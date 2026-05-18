"""Background worker for backtest runs.

Modeled on BulkScrapeManager: a singleton with an asyncio.Queue and a
single worker task that pops run ids and executes
``app.ml.backtest.run_backtest`` for each.

Structural anti-leakage checks live here:
  - model name must resolve via ``app.ml.models.get()``
  - every emitted BetRecord must have bet_ts < kickoff_ts, with
    kickoff_ts sourced from match_event_summaries
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import traceback
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from app.config import get_settings
from app.ml.backtest import BacktestReport, BetRecord, run_backtest
from app.ml.backtest_storage import (
    BetRow,
    RunRow,
    count_bets,
    delete_run,
    finalize_run,
    get_run,
    insert_bets,
    insert_run,
    list_bets,
    list_runs,
    update_mlflow_run_id,
    update_run_status,
)
from app.ml.tracking import log_backtest_run
from app.ml.labels import FOOTBALL_PHASE1_SCOPE
from app.ml.market_spec import get_spec
from app.ml.trainable import TRAINABLE, resolve_model_for_backtest

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CreateRunParams:
    model: str
    train_until: str
    test_until: Optional[str] = None
    min_edge: float = 0.02
    kelly_fraction: float = 0.25
    force_bets: bool = False
    label: Optional[str] = None
    scope: Optional[Sequence[Tuple[str, str]]] = None
    market_spec: str = "football_1x2_ft"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _connect() -> sqlite3.Connection:
    # Pydantic v1/v2 quirk: get_settings().storage_db_path may return a
    # FieldInfo wrapper instead of a resolved string. We fall back to the
    # raw env var first (which storage.py:build_snapshot_store also does)
    # and only consult settings for the default. This keeps the manager
    # and storage layer in agreement on path resolution.
    settings = get_settings()
    db_path = os.environ.get(
        "APP_STORAGE_DB_PATH",
        str(settings._resolve_value(settings.storage_db_path)),
    )
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class BacktestManager:
    """Async background worker. The factory in src.py wraps it in lru_cache.

    Note on event-loop binding: the asyncio.Queue and Lock are created
    lazily in :meth:`start` so they bind to the running event loop at
    that moment, not to whichever loop happened to be active when the
    lru_cache'd factory was first called. This matters for tests that
    construct BacktestManager() outside a running loop or across
    multiple TestClient sessions in the same process.
    """

    def __init__(self) -> None:
        self._queue: Optional[asyncio.Queue[str]] = None
        self._worker_task: Optional[asyncio.Task] = None
        self._started = False
        self._lock: Optional[asyncio.Lock] = None

    async def start(self) -> None:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._started:
                return
            if self._queue is None:
                self._queue = asyncio.Queue()
            # Sweep orphaned rows from a previous process. Any row still
            # in 'queued' or 'running' was left behind by a worker that no
            # longer exists (TestClient lifespan teardown, OOM, kill -9,
            # etc.). Without this sweep, those rows show as 'running'
            # forever in BacktestRunsPanel and confuse operators.
            await asyncio.to_thread(self._sweep_orphans_sync)
            self._worker_task = asyncio.create_task(self._worker_loop())
            self._started = True

    async def shutdown(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, Exception):
                pass
        self._worker_task = None
        self._started = False

    async def create_run(self, params: CreateRunParams) -> str:
        run_id = uuid.uuid4().hex
        scope = list(params.scope) if params.scope is not None else list(FOOTBALL_PHASE1_SCOPE)
        label = params.label or f"{params.model}_{_now_iso()}"
        row = RunRow(
            id=run_id,
            label=label,
            model=params.model,
            train_until=params.train_until,
            test_until=params.test_until,
            min_edge=params.min_edge,
            kelly_fraction=params.kelly_fraction,
            force_bets=1 if params.force_bets else 0,
            scope_json=json.dumps([[c, t] for c, t in scope]),
            status="queued",
            created_at=_now_iso(),
            stage=None,
            market_spec=params.market_spec,
        )
        # start() FIRST so the orphan-sweep can't see the row we're about
        # to insert (otherwise it would mark our own new row as orphaned).
        # start() is idempotent — subsequent create_run() calls no-op.
        await self.start()
        await asyncio.to_thread(self._insert_run_sync, row)
        assert self._queue is not None  # guaranteed by start()
        await self._queue.put(run_id)
        return run_id

    async def list_runs(self, *, limit: int = 50) -> List[RunRow]:
        return await asyncio.to_thread(self._list_runs_sync, limit)

    async def get_run(self, run_id: str) -> Optional[RunRow]:
        return await asyncio.to_thread(self._get_run_sync, run_id)

    async def list_bets(
        self, run_id: str, *, offset: int, limit: int
    ) -> Tuple[List[BetRow], int]:
        return await asyncio.to_thread(self._list_bets_sync, run_id, offset, limit)

    async def delete_run(self, run_id: str) -> None:
        await asyncio.to_thread(self._delete_run_sync, run_id)

    # --- sync helpers ---

    def _insert_run_sync(self, row: RunRow) -> None:
        with _connect() as conn:
            insert_run(conn, row)

    def _list_runs_sync(self, limit: int) -> List[RunRow]:
        with _connect() as conn:
            return list_runs(conn, limit=limit)

    def _get_run_sync(self, run_id: str) -> Optional[RunRow]:
        with _connect() as conn:
            return get_run(conn, run_id)

    def _list_bets_sync(
        self, run_id: str, offset: int, limit: int
    ) -> Tuple[List[BetRow], int]:
        with _connect() as conn:
            return list_bets(conn, run_id, offset=offset, limit=limit), count_bets(conn, run_id)

    def _delete_run_sync(self, run_id: str) -> None:
        with _connect() as conn:
            delete_run(conn, run_id)

    # --- worker ---

    async def _worker_loop(self) -> None:
        assert self._queue is not None  # set in start() before this task is created
        while True:
            run_id = await self._queue.get()
            try:
                await self._execute(run_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("backtest_worker_crashed", extra={"run_id": run_id})
                # _execute has its own try/except that marks the row failed
                # for most exceptions. This is the belt-and-suspenders path
                # for anything that escaped (e.g. exceptions thrown by
                # _execute's own _mark_failed_sync call). Without this,
                # the row would dangle in 'running' forever.
                try:
                    await asyncio.to_thread(
                        self._mark_failed_sync, run_id,
                        f"worker_loop caught uncaught: {exc!r}",
                    )
                except Exception:
                    logger.exception(
                        "worker_loop_mark_failed_also_crashed",
                        extra={"run_id": run_id},
                    )

    async def _execute(self, run_id: str) -> None:
        row = await self.get_run(run_id)
        if row is None or row.status == "cancelled":
            return

        # Resolve the MarketSpec.
        try:
            spec = get_spec(row.market_spec or "football_1x2_ft")
        except KeyError as e:
            await asyncio.to_thread(
                self._mark_failed_sync, run_id, f"unknown market_spec: {e}"
            )
            return

        await asyncio.to_thread(self._mark_running_sync, run_id, _now_iso())

        try:
            # For trainable models, mark stage='training' and resolve in a thread.
            if row.model in TRAINABLE:
                await asyncio.to_thread(self._mark_stage_sync, run_id, "training")
            try:
                model_fn = await asyncio.to_thread(
                    resolve_model_for_backtest, row.model, row.train_until, spec
                )
            except KeyError as e:
                await asyncio.to_thread(
                    self._mark_failed_sync, run_id, f"unknown model: {e}"
                )
                return
            # Read metadata stashed by the trainable adapter (or analytic defaults).
            feature_columns = tuple(getattr(model_fn, "feature_columns", ()))
            n_train_events = int(getattr(model_fn, "n_train_events", 0) or 0)

            # Mark stage='backtesting' before run_backtest.
            await asyncio.to_thread(self._mark_stage_sync, run_id, "backtesting")

            scope: List[Tuple[str, str]] = [tuple(x) for x in json.loads(row.scope_json)]
            report: BacktestReport = await asyncio.to_thread(
                run_backtest,
                model=model_fn,
                scope=scope,
                train_until=row.train_until,
                test_until=row.test_until,
                min_edge=row.min_edge,
                kelly_fraction=row.kelly_fraction,
                force_bets=bool(row.force_bets),
                market_spec=spec,
            )
            kickoffs = await asyncio.to_thread(
                self._kickoff_map_for, [b.event_id for b in report.bets]
            )
            bet_rows = self._to_bet_rows(run_id, report.bets, kickoffs)
            # Structural anti-leakage check: every bet must precede kickoff.
            for br in bet_rows:
                if not (br.bet_ts < br.kickoff_ts):
                    raise RuntimeError(
                        f"leakage detected: bet_ts={br.bet_ts} >= "
                        f"kickoff_ts={br.kickoff_ts} for event {br.event_id}"
                    )
            await asyncio.to_thread(
                self._persist_completed_sync, run_id, report, bet_rows
            )
            # Run MLflow logging in a thread — its calls are synchronous HTTP
            # to the tracking server. Phase A latency is sub-ms locally; this
            # guards against the Phase B (remote MLflow) regression.
            mlflow_run_id = await asyncio.to_thread(
                log_backtest_run,
                report=report,
                model_name=row.model,
                train_until=row.train_until,
                test_until=row.test_until,
                market_spec=get_spec(row.market_spec or "football_1x2_ft"),
                feature_columns=feature_columns,
                n_train_events=n_train_events,
                backtest_run_id=run_id,
            )
            if mlflow_run_id:
                await asyncio.to_thread(
                    self._update_mlflow_id_sync, run_id, mlflow_run_id,
                )
        except Exception as exc:
            tb = traceback.format_exc(limit=4)
            await asyncio.to_thread(
                self._mark_failed_sync, run_id, f"{exc}\n{tb}"
            )

    def _kickoff_map_for(self, event_ids: Sequence[str]) -> Dict[str, str]:
        if not event_ids:
            return {}
        with _connect() as conn:
            placeholders = ",".join("?" * len(event_ids))
            rows = conn.execute(
                f"SELECT event_id, start_time_utc FROM match_event_summaries "
                f"WHERE event_id IN ({placeholders})",
                tuple(event_ids),
            ).fetchall()
            return {r["event_id"]: r["start_time_utc"] for r in rows}

    def _to_bet_rows(
        self,
        run_id: str,
        bets: Sequence[BetRecord],
        kickoffs: Mapping[str, str],
    ) -> List[BetRow]:
        out: List[BetRow] = []
        for b in bets:
            kickoff = kickoffs.get(b.event_id)
            if not kickoff:
                raise RuntimeError(
                    f"no kickoff in match_event_summaries for event_id={b.event_id}; "
                    "cannot audit leakage"
                )
            out.append(BetRow(
                run_id=run_id,
                event_id=b.event_id,
                bet_ts=b.bet_ts,
                kickoff_ts=kickoff,
                market=b.market,
                selection=b.selection,
                price_taken=b.price_taken,
                closing_price=b.closing_price,
                model_prob=b.model_prob,
                implied_prob=b.implied_prob,
                devigged_prob=b.devigged_prob,
                edge=b.edge,
                stake_kelly_fraction=b.stake_kelly_fraction,
                result=b.result,
                pnl=b.pnl,
                clv=b.clv,
            ))
        return out

    def _sweep_orphans_sync(self) -> int:
        """Mark any rows left in queued/running state as failed.

        Called once at start(). A row in queued/running at startup is by
        definition from a dead previous process — the BacktestManager is
        single-instance and the new instance's in-memory queue is empty.
        Returns the number of rows swept (logged for visibility).
        """
        with _connect() as conn:
            rows = conn.execute(
                "SELECT id FROM backtest_runs WHERE status IN ('queued', 'running')"
            ).fetchall()
            ids = [r["id"] if hasattr(r, "keys") else r[0] for r in rows]
            if not ids:
                return 0
            placeholders = ",".join("?" * len(ids))
            conn.execute(
                f"UPDATE backtest_runs SET status = 'failed', "
                f"finished_at = ?, stage = NULL, "
                f"error = COALESCE(error, '') || ? "
                f"WHERE id IN ({placeholders})",
                (_now_iso(), "orphaned at backend restart (no live worker)", *ids),
            )
            conn.commit()
        logger.info(
            "swept_orphaned_backtests",
            extra={"event": "swept_orphaned_backtests", "count": len(ids)},
        )
        return len(ids)

    def _mark_running_sync(self, run_id: str, started_at: str) -> None:
        with _connect() as conn:
            update_run_status(conn, run_id, status="running", started_at=started_at)

    def _mark_stage_sync(self, run_id: str, stage: Optional[str]) -> None:
        with _connect() as conn:
            conn.execute(
                "UPDATE backtest_runs SET stage = ? WHERE id = ?",
                (stage, run_id),
            )
            conn.commit()

    def _mark_failed_sync(self, run_id: str, error: str) -> None:
        # Multi-statement, single-connection: update_run_status commits internally,
        # then we commit the stage=NULL clear. A reader in the tiny window between
        # them could observe status=failed but stage still set. Under single-writer
        # SQLite + asyncio this window is sub-millisecond and benign. If it ever
        # matters, fold stage into update_run_status's UPDATE.
        with _connect() as conn:
            update_run_status(
                conn, run_id,
                status="failed",
                finished_at=_now_iso(),
                error=error[:4000],
            )
            conn.execute(
                "UPDATE backtest_runs SET stage = NULL WHERE id = ?",
                (run_id,),
            )
            conn.commit()

    def _persist_completed_sync(
        self,
        run_id: str,
        report: BacktestReport,
        bet_rows: Sequence[BetRow],
    ) -> None:
        # Multi-statement, single-connection: the storage helpers (insert_bets,
        # finalize_run) each commit internally. A reader in the tiny window
        # between them could observe partial state (e.g. status=completed but
        # stage=backtesting). Under single-writer SQLite + asyncio this window
        # is sub-millisecond and benign. If it ever matters, fold stage into
        # finalize_run's UPDATE.
        with _connect() as conn:
            insert_bets(conn, bet_rows)
            summary = {
                "test_events": report.test_events,
                "total_bets": report.total_bets,
                "hit_rate": report.hit_rate,
                "roi": report.roi,
                "mean_clv": report.mean_clv,
                "brier": report.brier,
                "log_loss": report.log_loss,
                "max_drawdown": report.max_drawdown,
                "sharpe_adjusted": report.sharpe_adjusted,
                "reliability_json": json.dumps(
                    [asdict(b) for b in report.reliability_buckets]
                ),
            }
            finalize_run(conn, run_id, finished_at=_now_iso(), summary=summary)
            conn.execute(
                "UPDATE backtest_runs SET stage = NULL WHERE id = ?",
                (run_id,),
            )
            conn.commit()

    def _update_mlflow_id_sync(self, run_id: str, mlflow_run_id: str) -> None:
        with _connect() as conn:
            update_mlflow_run_id(conn, run_id, mlflow_run_id)
