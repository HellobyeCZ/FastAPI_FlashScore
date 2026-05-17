"""Lifecycle + leakage-assertion tests for BacktestManager.

We stub run_backtest so tests don't depend on real Phase 1 data.
"""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.ml.backtest import BacktestReport, BetRecord


def _ok_report() -> BacktestReport:
    bet = BetRecord(
        event_id="E1",
        bet_ts="2024-08-10T14:55:00Z",
        market="1x2_ft",
        selection="home",
        price_taken=2.10,
        closing_price=2.10,
        model_prob=0.55,
        implied_prob=0.48,
        devigged_prob=0.46,
        edge=0.09,
        stake_kelly_fraction=0.04,
        result=1.0,
        pnl=0.044,
        clv=0.0,
    )
    return BacktestReport(
        model="market_implied",
        scope_size=1,
        test_events=1,
        bets=[bet],
        total_bets=1,
        hit_rate=1.0,
        roi=0.044,
        mean_clv=0.0,
        brier=0.20,
        log_loss=0.6,
        max_drawdown=0.0,
        reliability_buckets=[],
        config={},
    )


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch) -> Path:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    # Clear cached settings so the env var is picked up.
    from app.config import get_settings
    get_settings.cache_clear()
    # Pre-create Prisma-managed tables that SnapshotStore.initialize() requires.
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS odds_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT)"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS match_stats_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT, is_terminal INTEGER DEFAULT 0)"
        )
        c.commit()
    # Init tables via SnapshotStore (this is the prod path).
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())
    # Seed match_event_summaries so the manager can audit kickoff_ts.
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS match_event_summaries "
            "(event_id TEXT PRIMARY KEY, start_time_utc TEXT)"
        )
        c.execute(
            "INSERT INTO match_event_summaries (event_id, start_time_utc, updated_at) VALUES (?, ?, ?)",
            ("E1", "2024-08-10T15:00:00Z", "2024-08-10T15:00:00Z"),
        )
        c.commit()
    return db


def test_create_run_persists_queued(db_path, monkeypatch):
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: _ok_report(),
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams
    mgr = BacktestManager()
    run_id = asyncio.run(
        mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
    )
    assert run_id
    summary = asyncio.run(mgr.get_run(run_id))
    assert summary is not None
    assert summary.status in ("queued", "running", "completed")


def test_worker_runs_through_to_completed(db_path, monkeypatch):
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: _ok_report(),
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        for _ in range(100):
            r = await mgr.get_run(run_id)
            if r and r.status in ("completed", "failed"):
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.05)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "completed", f"got {result.status}, error={result.error}"
    assert result.total_bets == 1


def test_worker_rejects_unregistered_model(db_path):
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="does_not_exist",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        for _ in range(100):
            r = await mgr.get_run(run_id)
            if r and r.status == "failed":
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.05)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "failed"
    assert "unknown model" in (result.error or "").lower()


def test_leakage_assertion_fails_run(db_path, monkeypatch):
    """If a returned BetRecord has bet_ts >= kickoff_ts, the run fails."""
    bad = BetRecord(
        event_id="E1",
        bet_ts="2024-08-10T15:30:00Z",  # AFTER kickoff (15:00)
        market="1x2_ft",
        selection="home",
        price_taken=2.10,
        closing_price=2.10,
        model_prob=0.55,
        implied_prob=0.48,
        devigged_prob=0.46,
        edge=0.09,
        stake_kelly_fraction=0.04,
        result=1.0,
        pnl=0.044,
        clv=0.0,
    )
    report = _ok_report()
    # Replace bets with the leaky one
    from dataclasses import replace
    bad_report = replace(report, bets=[bad], total_bets=1)
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: bad_report,
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        for _ in range(100):
            r = await mgr.get_run(run_id)
            if r and r.status == "failed":
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.05)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "failed"
    assert ("leakage" in (result.error or "").lower()
            or "bet_ts" in (result.error or ""))


def test_execute_imports_log_backtest_run_and_update_mlflow_run_id():
    """Module-level imports must include both symbols so the integration
    wiring exists. (Full _execute path is covered by manual smoke; this
    is a guard against accidental import removal.)"""
    from app.services import backtest_manager as bm
    assert callable(bm.log_backtest_run)
    assert callable(bm.update_mlflow_run_id)
