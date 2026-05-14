"""BacktestManager writes stage transitions for trainable runs and reads market_spec."""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.ml.backtest import BacktestReport, BetRecord


def _ok_report():
    bet = BetRecord(
        event_id="E1", bet_ts="2024-08-10T14:55:00Z",
        market="1x2_ft", selection="home",
        price_taken=2.10, closing_price=2.10,
        model_prob=0.55, implied_prob=0.48, devigged_prob=0.46,
        edge=0.09, stake_kelly_fraction=0.04,
        result=1.0, pnl=0.044, clv=0.0,
    )
    return BacktestReport(
        model="logistic", scope_size=1, test_events=1,
        bets=[bet], total_bets=1, hit_rate=1.0, roi=0.044,
        mean_clv=0.0, brier=0.2, log_loss=0.5, max_drawdown=0.0,
        reliability_buckets=[], config={},
    )


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch) -> Path:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
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
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())
    # Seed match_event_summaries so the manager can audit kickoff_ts.
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO match_event_summaries (event_id, start_time_utc, updated_at) VALUES (?, ?, ?)",
            ("E1", "2024-08-10T15:00:00Z", "2024-08-10T15:00:00Z"),
        )
        c.commit()
    return db


def test_market_spec_persisted_on_run(db_path, monkeypatch):
    """create_run with default market_spec stores 'football_1x2_ft'."""
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: _ok_report(),
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.market_spec == "football_1x2_ft"


def test_completed_run_stage_is_null(db_path, monkeypatch):
    """After completion, stage should be NULL (cleared)."""
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
            await asyncio.sleep(0.02)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "completed", f"got {result.status}, error={result.error}"
    assert result.stage is None


def test_trainable_model_resolves_via_resolver(db_path, monkeypatch):
    """For a trainable model, the worker must call resolve_model_for_backtest."""
    resolve_called_with = {}

    def fake_resolve(name, train_until, spec):
        resolve_called_with["name"] = name
        resolve_called_with["train_until"] = train_until
        resolve_called_with["spec_key"] = spec.key
        return lambda features, market: {"home": 0.5, "draw": 0.25, "away": 0.25}

    monkeypatch.setattr(
        "app.services.backtest_manager.resolve_model_for_backtest", fake_resolve
    )
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
                model="logistic",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        for _ in range(100):
            r = await mgr.get_run(run_id)
            if r and r.status in ("completed", "failed"):
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.02)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "completed", f"got {result.status}, error={result.error}"
    assert resolve_called_with == {
        "name": "logistic",
        "train_until": "2024-08-01T00:00:00Z",
        "spec_key": "football_1x2_ft",
    }


def test_unknown_model_marked_failed(db_path, monkeypatch):
    """Unknown model name → status=failed with 'unknown model' in error."""
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
            await asyncio.sleep(0.02)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "failed"
    assert "unknown model" in (result.error or "").lower()
