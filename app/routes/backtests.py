"""Router: backtests. See app/routes/__init__.py.

Backtest run actions added after the PR #13 split. The list/detail/create
routes still live in src.py and share `run_row_to_summary` with this
module so both serialize runs identically.
"""
from __future__ import annotations

import dataclasses
import sys
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.ml import tracking
from app.ml.backtest_storage import RunRow
from app.schemas.backtest import BacktestRunSummary
from app.services.backtest_manager import BacktestManager, RunNotCancellable

router = APIRouter(tags=["backtests"])


def _backtest_manager() -> BacktestManager:
    # src.py owns the singleton and includes this router, so read it from the
    # running app module. Under ``python src.py`` that module is __main__;
    # ``import src`` would load a second, never-started copy whose manager
    # the worker never consults (a cancel would silently do nothing).
    app_module = sys.modules.get("src") or sys.modules.get("__main__")
    dependency = getattr(app_module, "backtest_manager_dependency", None)
    if dependency is None:
        from src import backtest_manager_dependency as dependency
    return dependency()


def run_row_to_summary(
    row: RunRow, *, mlflow_experiment_id: Optional[str] = None
) -> BacktestRunSummary:
    if row.total_bets == 0:
        # Runs persisted before undefined metrics were stored as NULL
        # carry 0.0 rate metrics when they placed no bets. Undefined is
        # not zero: serve them as null, like newer rows.
        row = dataclasses.replace(
            row, hit_rate=None, roi=None, mean_clv=None, brier=None,
            log_loss=None, max_drawdown=None, sharpe_adjusted=None,
        )
    # Backtest bets are priced at the close, so CLV is undefined for every
    # run; older rows stored it as 0.0.
    row = dataclasses.replace(row, mean_clv=None)
    return BacktestRunSummary(
        id=row.id,
        label=row.label,
        model=row.model,
        status=row.status,
        created_at=row.created_at,
        train_until=row.train_until,
        test_until=row.test_until,
        started_at=row.started_at,
        finished_at=row.finished_at,
        error=row.error,
        test_events=row.test_events,
        total_bets=row.total_bets,
        hit_rate=row.hit_rate,
        roi=row.roi,
        mean_clv=row.mean_clv,
        brier=row.brier,
        log_loss=row.log_loss,
        max_drawdown=row.max_drawdown,
        stage=row.stage,
        market_spec=row.market_spec,
        sharpe_adjusted=row.sharpe_adjusted,
        mlflow_run_id=row.mlflow_run_id,
        n_train_events=row.n_train_events,
        mlflow_ui_url=tracking.run_ui_url(row.mlflow_run_id, mlflow_experiment_id),
    )


async def mlflow_experiment_id_for_links() -> Optional[str]:
    """Experiment id for run deep links. Cached after the first lookup;
    the lookup itself (probe + one request) runs off the event loop."""
    cached = tracking.cached_experiment_id()
    if cached is not None:
        return cached
    return await run_in_threadpool(tracking.resolve_experiment_id)


@router.post("/backtest/runs/{run_id}/cancel", response_model=BacktestRunSummary)
async def cancel_backtest_run(
    run_id: str,
    mgr: BacktestManager = Depends(_backtest_manager),
) -> BacktestRunSummary:
    """Cancel a queued run immediately, or flag a running run to stop at
    its next checkpoint (stage `cancelling`). 404 unknown, 409 finished."""
    try:
        row = await mgr.cancel(run_id)
    except RunNotCancellable as exc:
        raise HTTPException(
            status_code=409,
            detail=f"cannot cancel a run with status={exc.status!r}",
        ) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run_row_to_summary(row, mlflow_experiment_id=tracking.cached_experiment_id())
