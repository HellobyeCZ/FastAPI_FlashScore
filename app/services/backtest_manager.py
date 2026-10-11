"""Background worker for backtest runs.

Modeled on BulkScrapeManager: a singleton with an asyncio.Queue and a
single worker task that pops run ids and executes
``app.ml.backtest.run_backtest`` for each.

Structural anti-leakage checks live here:
  - model name must resolve via ``app.ml.models.get()``
  - every emitted BetRecord must have bet_ts < kickoff_ts, with
    kickoff_ts sourced from match_event_summaries

Cancellation: a queued run is cancelled immediately; a running run gets a
flag (stage ``cancelling``) that the worker checks between stages (before
training, before the backtest, before persisting). The blocking
training/backtest calls themselves are not interrupted — their results are
discarded. Every status write is a guarded transition, so a cancel that
lands after the last checkpoint still wins over completion and nothing
but the worker moves a running run to a final status.

MLflow logging happens after the run is persisted as completed and is
isolated: a tracking failure is logged as a warning and never turns a
completed run into a failed one.
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
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from app.config import get_settings
from app.ml.backtest import BacktestReport, BetRecord, run_backtest
from app.ml.backtest_storage import (
    BetRow,
    RunRow,
    count_bets,
    delete_run,
    finalize_run,
    get_run,
    insert_run,
    list_bets,
    list_runs,
    update_mlflow_run_id,
    update_n_train_events,
)
from app.ml.tracking import backtest_metrics, log_backtest_run
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


class RunNotCancellable(Exception):
    """cancel() was called on a run that already finished."""

    def __init__(self, status: str) -> None:
        super().__init__(f"run already finished with status={status!r}")
        self.status = status


class _RunCancelled(Exception):
    """Raised at a worker checkpoint when a cancel was requested."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _fitted_model_of(model_fn: Any) -> Any:
    """The fitted object behind a ModelFn, logged to MLflow as
    ``picks_model`` so the backtest can be registered and served.

    Trainable adapters expose it as ``fn.trained_model``. ModelFns built
    by ``app.ml.models.make_trained_model_fn`` also hold it in their
    closure as ``trained``; that cell is the fallback for adapters that
    don't set the attribute. Returns None when neither exists (analytic
    baselines, Dixon-Coles).
    """
    trained = getattr(model_fn, "trained_model", None)
    if trained is not None:
        return trained
    code = getattr(model_fn, "__code__", None)
    closure = getattr(model_fn, "__closure__", None)
    if code is None or not closure:
        return None
    cell = dict(zip(code.co_freevars, closure)).get("trained")
    if cell is None:
        return None
    try:
        candidate = cell.cell_contents
    except ValueError:  # empty cell
        return None
    if hasattr(candidate, "predict_proba") and hasattr(candidate, "feature_columns"):
        return candidate
    return None


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
    # 30 s busy timeout: the live-odds scheduler and bulk scrapes write the
    # same file, and the default 5 s surfaces as spurious "database is
    # locked" failures on long backtests.
    conn = sqlite3.connect(db_path, timeout=30.0)
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
        self._cancel_requested: Set[str] = set()

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

    async def cancel(self, run_id: str) -> Optional[RunRow]:
        """Cancel a queued or running run and return its updated row.

        Queued runs become ``cancelled`` immediately. Running runs are
        flagged (stage ``cancelling``) and become ``cancelled`` at the
        worker's next checkpoint. Returns None for an unknown id; raises
        :class:`RunNotCancellable` when the run already finished —
        including when it finished before the cancel could land.
        """
        row = await self.get_run(run_id)
        if row is None:
            return None
        if row.status not in ("queued", "running"):
            raise RunNotCancellable(row.status)
        self._cancel_requested.add(run_id)
        cancelled_now = False
        if row.status == "queued":
            cancelled_now = await asyncio.to_thread(self._cancel_queued_sync, run_id)
        if not cancelled_now:
            # Running, or picked up by the worker between our read and write.
            await asyncio.to_thread(self._flag_cancelling_sync, run_id)
        row = await self.get_run(run_id)
        if row is None:
            self._cancel_requested.discard(run_id)
            return None
        if row.status in ("completed", "failed"):
            # Finished between our read and the flag write; the worker
            # has already let go of the run, so drop the flag again.
            self._cancel_requested.discard(run_id)
            raise RunNotCancellable(row.status)
        return row

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
        try:
            await self._execute_run(run_id)
        finally:
            self._cancel_requested.discard(run_id)

    def _checkpoint(self, run_id: str) -> None:
        if run_id in self._cancel_requested:
            raise _RunCancelled()

    async def _execute_run(self, run_id: str) -> None:
        row = await self.get_run(run_id)
        if row is None or row.status != "queued":
            # Cancelled (or otherwise finished) while waiting in the queue.
            return

        # Resolve the MarketSpec.
        try:
            spec = get_spec(row.market_spec or "football_1x2_ft")
        except KeyError as e:
            await asyncio.to_thread(
                self._mark_failed_sync, run_id, f"unknown market_spec: {e}"
            )
            return

        if not await asyncio.to_thread(self._mark_running_sync, run_id, _now_iso()):
            return  # cancelled between the read above and this transition

        try:
            self._checkpoint(run_id)
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
            trained_model = _fitted_model_of(model_fn)
            await asyncio.to_thread(
                self._set_n_train_events_sync, run_id, n_train_events
            )

            self._checkpoint(run_id)
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
            self._checkpoint(run_id)
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
            completed = await asyncio.to_thread(
                self._persist_completed_sync, run_id, report, bet_rows
            )
            if not completed:
                raise _RunCancelled()  # a cancel landed after the last checkpoint
        except _RunCancelled:
            await asyncio.to_thread(self._mark_cancelled_sync, run_id)
            return
        except Exception as exc:
            if run_id in self._cancel_requested:
                await asyncio.to_thread(self._mark_cancelled_sync, run_id)
                return
            tb = traceback.format_exc(limit=4)
            await asyncio.to_thread(
                self._mark_failed_sync, run_id, f"{exc}\n{tb}"
            )
            return

        # The run is completed from here on. MLflow calls are synchronous
        # HTTP (thread) and must never flip the run to failed.
        try:
            mlflow_run_id = await asyncio.to_thread(
                log_backtest_run,
                report=report,
                model_name=row.model,
                train_until=row.train_until,
                test_until=row.test_until,
                market_spec=spec,
                feature_columns=feature_columns,
                n_train_events=n_train_events,
                backtest_run_id=run_id,
                trained_model=trained_model,
                scope_size=len(scope),
            )
            if mlflow_run_id:
                await asyncio.to_thread(
                    self._update_mlflow_id_sync, run_id, mlflow_run_id,
                )
        except Exception:
            logger.warning(
                "backtest_mlflow_logging_failed",
                exc_info=True,
                extra={"event": "backtest_mlflow_logging_failed", "run_id": run_id},
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
        """Finish any rows left in queued/running state.

        Called once at start(). A row in queued/running at startup is by
        definition from a dead previous process — the BacktestManager is
        single-instance and the new instance's in-memory queue is empty.
        A row with a pending cancel (stage ``cancelling``) becomes
        cancelled, as the operator asked; every other one becomes failed.
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
            # Right-hand sides see the pre-UPDATE row, so `stage` here is
            # the old value even though the same statement clears it.
            conn.execute(
                f"UPDATE backtest_runs SET "
                f"status = CASE WHEN stage = 'cancelling' THEN 'cancelled' ELSE 'failed' END, "
                f"error = CASE WHEN stage = 'cancelling' THEN error "
                f"ELSE COALESCE(error, '') || ? END, "
                f"finished_at = ?, stage = NULL "
                f"WHERE id IN ({placeholders})",
                ("orphaned at backend restart (no live worker)", _now_iso(), *ids),
            )
            conn.commit()
        logger.info(
            "swept_orphaned_backtests",
            extra={"event": "swept_orphaned_backtests", "count": len(ids)},
        )
        return len(ids)

    def _mark_running_sync(self, run_id: str, started_at: str) -> bool:
        """queued -> running. False when the row is no longer queued
        (cancelled between the worker's read and this write)."""
        with _connect() as conn:
            cur = conn.execute(
                "UPDATE backtest_runs SET status = 'running', started_at = ? "
                "WHERE id = ? AND status = 'queued'",
                (started_at, run_id),
            )
            conn.commit()
            return cur.rowcount == 1

    def _mark_stage_sync(self, run_id: str, stage: Optional[str]) -> None:
        # Only a running run has a stage, and a pending cancel is never
        # masked: 'cancelling' sticks until the worker's next checkpoint.
        with _connect() as conn:
            conn.execute(
                "UPDATE backtest_runs SET stage = ? "
                "WHERE id = ? AND status = 'running' "
                "AND (stage IS NULL OR stage != 'cancelling')",
                (stage, run_id),
            )
            conn.commit()

    def _mark_failed_sync(self, run_id: str, error: str) -> None:
        # Only an in-flight run can fail: a cancelled run stays cancelled
        # even if its thread later errors, and a completed one stays
        # completed whatever happens after it was persisted.
        with _connect() as conn:
            conn.execute(
                "UPDATE backtest_runs SET status = 'failed', finished_at = ?, "
                "error = ?, stage = NULL WHERE id = ? AND status IN ('queued', 'running')",
                (_now_iso(), error[:4000], run_id),
            )
            conn.commit()

    def _cancel_queued_sync(self, run_id: str) -> bool:
        """queued -> cancelled, for cancel(). False when the run is no
        longer queued (the worker started it in the meantime)."""
        with _connect() as conn:
            cur = conn.execute(
                "UPDATE backtest_runs SET status = 'cancelled', finished_at = ?, "
                "stage = NULL WHERE id = ? AND status = 'queued'",
                (_now_iso(), run_id),
            )
            conn.commit()
            return cur.rowcount == 1

    def _mark_cancelled_sync(self, run_id: str) -> None:
        """Worker side: queued/running -> cancelled, and always clear the
        stage — also on a row that is already cancelled (its finish time
        is kept). Completed and failed runs are left alone."""
        with _connect() as conn:
            conn.execute(
                "UPDATE backtest_runs SET status = 'cancelled', "
                "finished_at = COALESCE(finished_at, ?), stage = NULL "
                "WHERE id = ? AND status IN ('queued', 'running', 'cancelled')",
                (_now_iso(), run_id),
            )
            conn.commit()

    def _flag_cancelling_sync(self, run_id: str) -> None:
        with _connect() as conn:
            conn.execute(
                "UPDATE backtest_runs SET stage = 'cancelling' "
                "WHERE id = ? AND status = 'running'",
                (run_id,),
            )
            conn.commit()

    def _set_n_train_events_sync(self, run_id: str, n_train_events: int) -> None:
        with _connect() as conn:
            update_n_train_events(conn, run_id, n_train_events)

    def _persist_completed_sync(
        self,
        run_id: str,
        report: BacktestReport,
        bet_rows: Sequence[BetRow],
    ) -> bool:
        """Store bets + summary and mark the run completed, atomically.
        False (nothing written) when a cancel is pending or the run is no
        longer running.

        Undefined metrics are stored as NULL, not 0 — the same values the
        MLflow run logs: rate metrics when no bets were placed, mean_clv
        unless CLV is defined (archive bets are priced at the close).
        """
        metrics = backtest_metrics(report)
        summary = {
            "test_events": report.test_events,
            "total_bets": report.total_bets,
            "hit_rate": metrics["hit_rate"],
            "roi": metrics["roi"],
            "mean_clv": metrics["mean_clv"],
            "brier": metrics["brier"],
            "log_loss": metrics["log_loss"],
            "max_drawdown": metrics["max_drawdown"],
            "sharpe_adjusted": metrics["sharpe_adjusted"],
            "reliability_json": json.dumps(
                [asdict(b) for b in report.reliability_buckets]
            ),
        }
        with _connect() as conn:
            return finalize_run(
                conn, run_id, finished_at=_now_iso(), summary=summary, bets=bet_rows,
            )

    def _update_mlflow_id_sync(self, run_id: str, mlflow_run_id: str) -> None:
        with _connect() as conn:
            update_mlflow_run_id(conn, run_id, mlflow_run_id)
