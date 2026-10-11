"""Log completed backtests that predate MLflow logging to the `picks` experiment.

For every ``backtest_runs`` row with ``status = 'completed'`` and
``mlflow_run_id IS NULL``:

  1. create an MLflow run tagged ``purpose = backfill`` and
     ``backtest_run_id = <id>``, with the row's params (model, windows,
     min_edge, kelly_fraction, force_bets, scope size, n_train_events)
     and metrics (n_bets, n_test_events, and — when bets were placed —
     hit_rate, roi, brier, log_loss, max_drawdown);
  2. recompute return_per_bet / rmse_per_bet / sharpe_adjusted from the
     run's ``backtest_bets`` on unit stakes (the definition logged for new
     runs; the SQLite column may hold an older Kelly-scaled value);
  3. attach reliability.svg from the stored buckets;
  4. write the MLflow run id back to ``backtest_runs.mlflow_run_id``.

No model artifact is logged — the fitted model no longer exists — so
backfilled runs can't be registered. ``mean_clv`` is never logged:
archive backtests are priced at the close, where CLV is undefined
(tag ``clv_available = false``).

Idempotent: linked rows are skipped, and a row whose MLflow run was
created but not written back (crash in between) is re-linked to that
run instead of getting a second one.

Usage:
    PYTHONPATH=. APP_STORAGE_DB_PATH=<db> MLFLOW_TRACKING_URI=http://127.0.0.1:5050 \\
        python scripts/backfill_mlflow_backtests.py --dry-run
    ... python scripts/backfill_mlflow_backtests.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import namedtuple
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.ml import db as ml_db
from app.ml import tracking
from app.ml.backtest import ReliabilityBucket, _compute_sharpe_adjusted, render_reliability_svg
from app.ml.market_spec import get_spec

_UnitBet = namedtuple("_UnitBet", "price_taken result")


def _iso_to_ms(ts: Optional[str]) -> Optional[int]:
    if not ts:
        return None
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)


def _pending_rows(conn: sqlite3.Connection, limit: Optional[int]) -> List[sqlite3.Row]:
    sql = (
        "SELECT * FROM backtest_runs WHERE status = 'completed' AND mlflow_run_id IS NULL "
        "ORDER BY created_at ASC"
    )
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT ?"
        params = (limit,)
    return conn.execute(sql, params).fetchall()


def _payload(conn: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Any]:
    """Params, metrics, tags and reliability SVG for one backtest row."""
    keys = row.keys()
    params: Dict[str, Any] = {
        "model_name": row["model"],
        "train_until": row["train_until"],
        "test_until": row["test_until"] or "",
        "market_spec_key": row["market_spec"],
        "min_edge": row["min_edge"],
        "kelly_fraction": row["kelly_fraction"],
        "force_bets": bool(row["force_bets"]),
        "scope_size": len(json.loads(row["scope_json"] or "[]")),
        "label": row["label"],
    }
    try:
        spec = get_spec(row["market_spec"])
        params.update({"sport": spec.sport, "market": spec.market})
    except KeyError:
        pass
    if "n_train_events" in keys and row["n_train_events"] is not None:
        params["n_train_events"] = row["n_train_events"]

    n_bets = row["total_bets"] or 0
    metrics: Dict[str, float] = {"n_bets": n_bets}
    if row["test_events"] is not None:
        metrics["n_test_events"] = row["test_events"]
    if n_bets > 0:
        for key in ("hit_rate", "roi", "brier", "log_loss", "max_drawdown"):
            if row[key] is not None:
                metrics[key] = row[key]
        bets = [
            _UnitBet(r["price_taken"], r["result"])
            for r in conn.execute(
                "SELECT price_taken, result FROM backtest_bets WHERE run_id = ?", (row["id"],)
            )
        ]
        if bets:
            ret, rmse, sharpe = _compute_sharpe_adjusted(bets)
            metrics.update({"return_per_bet": ret, "rmse_per_bet": rmse, "sharpe_adjusted": sharpe})

    svg = None
    if row["reliability_json"]:
        buckets = [ReliabilityBucket(**b) for b in json.loads(row["reliability_json"])]
        if buckets:
            svg = render_reliability_svg(buckets)

    tags = {
        "purpose": "backfill",
        "backtest_run_id": row["id"],
        "clv_available": "false",
        "has_model": "false",
    }
    return {
        "run_name": f"bt_{row['model']}_{row['train_until'][:10]}",
        "params": params, "metrics": metrics, "tags": tags, "svg": svg,
    }


def _existing_run_id(client, experiment_id: str, backtest_run_id: str) -> Optional[str]:
    runs = client.search_runs(
        [experiment_id],
        filter_string=f"tags.backtest_run_id = '{backtest_run_id}'",
        max_results=1,
    )
    return runs[0].info.run_id if runs else None


def _create_run(client, experiment_id: str, row: sqlite3.Row, payload: Dict[str, Any]) -> str:
    from mlflow.entities import Metric, Param

    start_ms = _iso_to_ms(row["started_at"]) or _iso_to_ms(row["created_at"])
    end_ms = _iso_to_ms(row["finished_at"]) or start_ms
    run = client.create_run(
        experiment_id, start_time=start_ms, tags=payload["tags"],
        run_name=payload["run_name"],
    )
    run_id = run.info.run_id
    stamp = end_ms or int(time.time() * 1000)
    client.log_batch(
        run_id,
        metrics=[Metric(k, float(v), stamp, 0) for k, v in payload["metrics"].items()],
        params=[Param(k, str(v)) for k, v in payload["params"].items()],
    )
    if payload["svg"]:
        client.log_text(run_id, payload["svg"], "reliability.svg")
    client.set_terminated(run_id, status="FINISHED", end_time=end_ms)
    return run_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be logged; write nothing to MLflow or SQLite.")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    db_path = ml_db.db_path()
    print(f"backtest DB: {db_path}")
    if args.dry_run:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30.0)
    else:
        conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = _pending_rows(conn, args.limit)
        print(f"completed runs without mlflow_run_id: {len(rows)}")
        if args.dry_run:
            for row in rows:
                payload = _payload(conn, row)
                print(f"  would log {row['id']}  {row['model']:<15} "
                      f"train_until={row['train_until'][:10]}  "
                      f"metrics={sorted(payload['metrics'])}")
            return 0
        if not rows:
            return 0

        try:
            mlflow = tracking.import_mlflow()
            experiment_id = tracking.ensure_experiment_id()
        except tracking.MlflowUnavailable as exc:
            print(f"MLflow unavailable: {exc}", file=sys.stderr)
            return 2
        client = mlflow.MlflowClient(tracking_uri=tracking.tracking_uri())
        print(f"tracking URI: {tracking.tracking_uri()}  experiment: {experiment_id}")

        created = relinked = 0
        for row in rows:
            run_id = _existing_run_id(client, experiment_id, row["id"])
            if run_id is not None:
                relinked += 1
                action = "relinked"
            else:
                run_id = _create_run(client, experiment_id, row, _payload(conn, row))
                created += 1
                action = "logged"
            conn.execute(
                "UPDATE backtest_runs SET mlflow_run_id = ? WHERE id = ? AND mlflow_run_id IS NULL",
                (run_id, row["id"]),
            )
            conn.commit()
            print(f"  {action} {row['id']} -> {run_id}")
        print(f"done: {created} logged, {relinked} relinked")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
