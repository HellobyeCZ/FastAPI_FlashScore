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
fully logged but not written back (crash in between) is re-linked to
that run instead of getting a second one. A run that fails half-way is
deleted (or, failing that, marked FAILED) and never re-linked; the row
stays pending for the next invocation.

``--normalize-sqlite`` additionally rewrites the stored metrics of every
completed row to the definitions new runs persist: ``sharpe_adjusted``
on unit stakes (older rows hold a Kelly-scaled value or NULL), rate
metrics NULL for runs without bets, and ``mean_clv`` NULL where CLV is
undefined. It runs before the MLflow backfill, needs no MLflow server,
and respects ``--dry-run``.

Usage:
    PYTHONPATH=. APP_STORAGE_DB_PATH=<db> MLFLOW_TRACKING_URI=http://127.0.0.1:5050 \\
        python scripts/backfill_mlflow_backtests.py --dry-run [--normalize-sqlite]
    ... python scripts/backfill_mlflow_backtests.py [--limit N] [--normalize-sqlite]
"""
from __future__ import annotations

import argparse
import json
import math
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

# Metrics that are undefined for a run without bets (NULL, not 0).
_UNDEFINED_WITHOUT_BETS = (
    "hit_rate", "roi", "brier", "log_loss", "max_drawdown", "sharpe_adjusted", "mean_clv",
)


def _iso_to_ms(ts: Optional[str]) -> Optional[int]:
    if not ts:
        return None
    return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)


def _unit_stake_metrics(conn: sqlite3.Connection, run_id: str) -> Optional[tuple]:
    """(return_per_bet, rmse_per_bet, sharpe_adjusted) on unit stakes from
    the run's stored bets, or None when it has none."""
    bets = [
        _UnitBet(r["price_taken"], r["result"])
        for r in conn.execute(
            "SELECT price_taken, result FROM backtest_bets WHERE run_id = ?", (run_id,)
        )
    ]
    return _compute_sharpe_adjusted(bets) if bets else None


def _normalized_values(conn: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Optional[float]]:
    """Stored metrics of a completed row that differ from what the app
    persists today (see `tracking.backtest_metrics`), mapped to the value
    they should hold."""
    target: Dict[str, Optional[float]] = {}
    if not row["total_bets"]:
        target = {col: None for col in _UNDEFINED_WITHOUT_BETS}
    else:
        unit = _unit_stake_metrics(conn, row["id"])
        if unit is not None:  # bets stored: Sharpe and CLV can be judged
            target["sharpe_adjusted"] = unit[2]
            priced_before_close = conn.execute(
                "SELECT 1 FROM backtest_bets WHERE run_id = ? "
                "AND price_taken != closing_price LIMIT 1",
                (row["id"],),
            ).fetchone()
            if not priced_before_close:
                target["mean_clv"] = None
    return {col: value for col, value in target.items() if not _same(row[col], value)}


def _same(stored: Optional[float], value: Optional[float]) -> bool:
    # The recomputation sums bets in a different order than the run did.
    if stored is None or value is None:
        return stored is value
    return math.isclose(stored, value, rel_tol=1e-9, abs_tol=1e-12)


def _normalize_sqlite(conn: sqlite3.Connection, *, dry_run: bool) -> int:
    """Rewrite legacy metric values of completed rows; returns rows changed."""
    rows = conn.execute(
        "SELECT * FROM backtest_runs WHERE status = 'completed' ORDER BY created_at ASC"
    ).fetchall()
    changed = 0
    for row in rows:
        updates = _normalized_values(conn, row)
        if not updates:
            continue
        changed += 1
        described = ", ".join(f"{col} {row[col]!r} -> {value!r}" for col, value in updates.items())
        print(f"  {'would normalize' if dry_run else 'normalized'} {row['id']}: {described}")
        if not dry_run:
            conn.execute(
                f"UPDATE backtest_runs SET {', '.join(f'{col} = ?' for col in updates)} WHERE id = ?",
                (*updates.values(), row["id"]),
            )
    if not dry_run:
        conn.commit()
    print(f"{'would normalize' if dry_run else 'normalized'} metrics of {changed} completed run(s)")
    return changed


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
        unit = _unit_stake_metrics(conn, row["id"])
        if unit is not None:
            ret, rmse, sharpe = unit
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
    """A fully logged run for this row. FINISHED is set last, so a run
    left half-logged by an earlier crash is never re-linked."""
    runs = client.search_runs(
        [experiment_id],
        filter_string=(
            f"tags.backtest_run_id = '{backtest_run_id}' and attributes.status = 'FINISHED'"
        ),
        max_results=1,
    )
    return runs[0].info.run_id if runs else None


def _discard_partial_run(client, run_id: str) -> None:
    """Best effort: delete a half-logged run, or at least close it as
    FAILED so it can't be mistaken for a complete one."""
    try:
        client.delete_run(run_id)
    except Exception:
        try:
            client.set_terminated(run_id, status="FAILED")
        except Exception:
            pass


def _create_run(client, experiment_id: str, row: sqlite3.Row, payload: Dict[str, Any]) -> str:
    from mlflow.entities import Metric, Param

    start_ms = _iso_to_ms(row["started_at"]) or _iso_to_ms(row["created_at"])
    end_ms = _iso_to_ms(row["finished_at"]) or start_ms
    run = client.create_run(
        experiment_id, start_time=start_ms, tags=payload["tags"],
        run_name=payload["run_name"],
    )
    run_id = run.info.run_id
    try:
        stamp = end_ms or int(time.time() * 1000)
        client.log_batch(
            run_id,
            metrics=[Metric(k, float(v), stamp, 0) for k, v in payload["metrics"].items()],
            params=[Param(k, str(v)) for k, v in payload["params"].items()],
        )
        if payload["svg"]:
            client.log_text(run_id, payload["svg"], "reliability.svg")
        client.set_terminated(run_id, status="FINISHED", end_time=end_ms)
    except BaseException:
        _discard_partial_run(client, run_id)
        raise
    return run_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be logged; write nothing to MLflow or SQLite.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--normalize-sqlite", action="store_true",
                        help="Also rewrite legacy metric values of every completed run in SQLite.")
    args = parser.parse_args()

    db_path = ml_db.db_path()
    print(f"backtest DB: {db_path}")
    if args.dry_run:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30.0)
    else:
        conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        if args.normalize_sqlite:
            _normalize_sqlite(conn, dry_run=args.dry_run)
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

        created = relinked = failed = 0
        for row in rows:
            try:
                run_id = _existing_run_id(client, experiment_id, row["id"])
                if run_id is not None:
                    action = "relinked"
                else:
                    run_id = _create_run(client, experiment_id, row, _payload(conn, row))
                    action = "logged"
            except Exception as exc:
                failed += 1
                print(f"  FAILED {row['id']}: {type(exc).__name__}: {exc}", file=sys.stderr)
                if tracking.connection_lost():
                    print("MLflow server unreachable; stopping. Re-run to resume.", file=sys.stderr)
                    break
                continue
            conn.execute(
                "UPDATE backtest_runs SET mlflow_run_id = ? WHERE id = ? AND mlflow_run_id IS NULL",
                (run_id, row["id"]),
            )
            conn.commit()
            if action == "relinked":
                relinked += 1
            else:
                created += 1
            print(f"  {action} {row['id']} -> {run_id}")
        print(f"done: {created} logged, {relinked} relinked, {failed} failed")
        return 1 if failed else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
