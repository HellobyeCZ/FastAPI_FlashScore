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


def test_start_sweeps_orphaned_running_and_queued_rows(db_path):
    """A row left in running/queued at start() is from a dead previous
    process. start() must mark it failed with a clear error message."""
    from app.services.backtest_manager import BacktestManager

    # Seed three orphans: one running, one queued, plus a stage='training'
    # mid-flight row.
    with sqlite3.connect(db_path) as c:
        c.executemany(
            "INSERT INTO backtest_runs (id, label, model, train_until, "
            "min_edge, kelly_fraction, force_bets, scope_json, status, "
            "created_at, stage, market_spec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                ("orphan_running", "L1", "logistic", "2024-08-01T00:00:00Z",
                 0.02, 0.25, 0, "[]", "running", "2024-01-01T00:00:00Z",
                 "training", "football_1x2_ft"),
                ("orphan_queued", "L2", "logistic", "2024-08-01T00:00:00Z",
                 0.02, 0.25, 0, "[]", "queued", "2024-01-01T00:00:00Z",
                 None, "football_1x2_ft"),
                ("orphan_stage_only", "L3", "logistic", "2024-08-01T00:00:00Z",
                 0.02, 0.25, 0, "[]", "running", "2024-01-01T00:00:00Z",
                 "backtesting", "football_1x2_ft"),
            ],
        )
        c.commit()

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        await mgr.shutdown()

    asyncio.run(go())

    with sqlite3.connect(db_path) as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT id, status, stage, error FROM backtest_runs "
            "WHERE id LIKE 'orphan_%'"
        ).fetchall()
    by_id = {r["id"]: r for r in rows}
    for rid in ("orphan_running", "orphan_queued", "orphan_stage_only"):
        assert by_id[rid]["status"] == "failed", (
            f"{rid}: expected failed, got {by_id[rid]['status']}"
        )
        assert by_id[rid]["stage"] is None, (
            f"{rid}: stage should be cleared, got {by_id[rid]['stage']}"
        )
        assert "orphan" in (by_id[rid]["error"] or "").lower(), (
            f"{rid}: error should mention orphan, got {by_id[rid]['error']}"
        )


def test_start_with_no_orphans_does_not_fail(db_path):
    """The sweep is idempotent and safe on a fresh DB."""
    from app.services.backtest_manager import BacktestManager

    async def go():
        mgr = BacktestManager()
        await mgr.start()  # should not raise
        await mgr.shutdown()

    asyncio.run(go())


# ---------------------------------------------------------------------------
# MLflow isolation, n_train_events, cancel
# ---------------------------------------------------------------------------

def _wait_for(mgr, run_id, statuses, *, tries=200):
    async def go():
        for _ in range(tries):
            r = await mgr.get_run(run_id)
            if r and r.status in statuses:
                return r
            await asyncio.sleep(0.05)
        return await mgr.get_run(run_id)
    return go()


def _run_once(params_model="market_implied"):
    """Create one run on a fresh manager and wait for a terminal status."""
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(model=params_model, train_until="2024-08-01T00:00:00Z")
        )
        row = await _wait_for(mgr, run_id, ("completed", "failed", "cancelled"))
        # Logging runs after the row turns completed; give it a beat.
        for _ in range(40):
            if row.mlflow_run_id:
                break
            await asyncio.sleep(0.05)
            row = await mgr.get_run(run_id)
        await mgr.shutdown()
        return row

    return asyncio.run(go())


def test_completed_run_stays_completed_when_mlflow_logging_raises(db_path, monkeypatch):
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest", lambda **kw: _ok_report(),
    )

    def boom(**kwargs):
        raise RuntimeError("tracking server exploded")

    monkeypatch.setattr("app.services.backtest_manager.log_backtest_run", boom)
    row = _run_once()
    assert row.status == "completed", row.error
    assert row.error is None
    assert row.mlflow_run_id is None


def test_mlflow_run_id_persisted_from_log_backtest_run(db_path, monkeypatch):
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest", lambda **kw: _ok_report(),
    )
    seen = {}

    def fake_log(**kwargs):
        seen.update(kwargs)
        return "mlflow-run-123"

    monkeypatch.setattr("app.services.backtest_manager.log_backtest_run", fake_log)
    row = _run_once()
    assert row.status == "completed"
    assert row.mlflow_run_id == "mlflow-run-123"
    assert row.n_train_events == 0  # analytic baseline: fitted on nothing
    assert seen["backtest_run_id"] == row.id
    assert seen["scope_size"] > 0
    assert seen["trained_model"] is None


def test_fitted_model_of_prefers_attribute_then_closure():
    from app.ml.models import make_dixon_coles_model_fn, make_trained_model_fn
    from app.services.backtest_manager import _fitted_model_of

    class Trained:
        feature_columns = ("home_elo",)

        def predict_proba(self, X):  # pragma: no cover - never called
            raise AssertionError

    trained = Trained()
    fn = make_trained_model_fn(trained, calibrated=True, name_prefix="hgb")
    assert _fitted_model_of(fn) is trained  # closure fallback

    other = Trained()
    fn.trained_model = other
    assert _fitted_model_of(fn) is other  # explicit attribute wins

    from app.ml.dixon_coles import DCConfig
    assert _fitted_model_of(make_dixon_coles_model_fn({}, DCConfig())) is None

    from app.ml.models import get
    assert _fitted_model_of(get("market_implied")) is None


def test_cancel_queued_and_running_runs(db_path, monkeypatch):
    import threading

    release = threading.Event()

    def blocking_backtest(**kw):
        release.wait(10)
        return _ok_report()

    monkeypatch.setattr("app.services.backtest_manager.run_backtest", blocking_backtest)
    from app.services.backtest_manager import (
        BacktestManager, CreateRunParams, RunNotCancellable,
    )

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        params = CreateRunParams(model="market_implied", train_until="2024-08-01T00:00:00Z")
        first = await mgr.create_run(params)
        second = await mgr.create_run(params)  # queued behind the blocked first run
        await _wait_for(mgr, first, ("running",))

        queued = await mgr.cancel(second)
        assert queued.status == "cancelled"
        assert queued.finished_at is not None

        running = await mgr.cancel(first)
        assert running.status == "running"
        assert running.stage == "cancelling"

        release.set()
        first_row = await _wait_for(mgr, first, ("cancelled", "completed", "failed"))
        assert first_row.status == "cancelled"
        assert first_row.stage is None
        assert first_row.total_bets is None  # results discarded

        try:
            await mgr.cancel(first)
        except RunNotCancellable as exc:
            assert exc.status == "cancelled"
        else:
            raise AssertionError("cancelling a finished run must raise")
        assert await mgr.cancel("does-not-exist") is None
        await mgr.shutdown()

    try:
        asyncio.run(go())
    finally:
        release.set()
