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


# ---------------------------------------------------------------------------
# Guarded status transitions
# ---------------------------------------------------------------------------

def _seed_run(db_path, run_id, status, *, stage=None, finished_at=None, total_bets=None):
    with sqlite3.connect(db_path) as c:
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
            "kelly_fraction, force_bets, scope_json, status, created_at, stage, "
            "finished_at, total_bets, market_spec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, run_id, "market_implied", "2024-08-01T00:00:00Z", 0.02, 0.25, 0,
             "[]", status, "2024-01-01T00:00:00Z", stage, finished_at, total_bets,
             "football_1x2_ft"),
        )
        c.commit()


def _row(db_path, run_id):
    with sqlite3.connect(db_path) as c:
        c.row_factory = sqlite3.Row
        return c.execute("SELECT * FROM backtest_runs WHERE id = ?", (run_id,)).fetchone()


def test_status_transitions_never_overwrite_a_final_status(db_path):
    from app.services.backtest_manager import BacktestManager

    mgr = BacktestManager()
    _seed_run(db_path, "running", "running")
    _seed_run(db_path, "cancelled", "cancelled", finished_at="2024-01-01T01:00:00Z")
    _seed_run(db_path, "completed", "completed", finished_at="2024-01-01T01:00:00Z")

    # cancel()'s queued-only transition leaves a run the worker started alone.
    assert mgr._cancel_queued_sync("running") is False
    assert _row(db_path, "running")["status"] == "running"

    # No stage on a run that is not running.
    mgr._mark_stage_sync("cancelled", "training")
    assert _row(db_path, "cancelled")["stage"] is None

    # A completed run stays completed.
    mgr._mark_failed_sync("completed", "late error")
    mgr._mark_cancelled_sync("completed")
    done = _row(db_path, "completed")
    assert (done["status"], done["error"]) == ("completed", None)

    # The worker's cancel path clears a stale stage on an already-cancelled
    # row and keeps its original finish time.
    with sqlite3.connect(db_path) as c:
        c.execute("UPDATE backtest_runs SET stage = 'backtesting' WHERE id = 'cancelled'")
    mgr._mark_cancelled_sync("cancelled")
    row = _row(db_path, "cancelled")
    assert (row["status"], row["stage"], row["finished_at"]) == (
        "cancelled", None, "2024-01-01T01:00:00Z",
    )


def test_cancel_after_last_checkpoint_wins_over_completion(db_path, monkeypatch):
    """A cancel that lands after the worker's last checkpoint (here: while
    kickoffs are looked up) must still end the run cancelled, with no bets
    stored and nothing logged to MLflow."""
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest", lambda **kw: _ok_report(),
    )
    logged = []
    monkeypatch.setattr(
        "app.services.backtest_manager.log_backtest_run",
        lambda **kw: logged.append(kw) or "should-not-be-logged",
    )
    real_kickoffs = BacktestManager._kickoff_map_for

    def kickoffs_then_cancel(self, event_ids):
        # Same write cancel() makes for a running run.
        with sqlite3.connect(db_path) as c:
            run_id = c.execute(
                "SELECT id FROM backtest_runs WHERE status = 'running'"
            ).fetchone()[0]
        self._cancel_requested.add(run_id)
        self._flag_cancelling_sync(run_id)
        return real_kickoffs(self, event_ids)

    monkeypatch.setattr(BacktestManager, "_kickoff_map_for", kickoffs_then_cancel)

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(model="market_implied", train_until="2024-08-01T00:00:00Z")
        )
        row = await _wait_for(mgr, run_id, ("completed", "failed", "cancelled"))
        await mgr.shutdown()
        return row

    row = asyncio.run(go())
    assert row.status == "cancelled", row.error
    assert row.stage is None
    assert row.total_bets is None
    with sqlite3.connect(db_path) as c:
        assert c.execute("SELECT COUNT(*) FROM backtest_bets").fetchone()[0] == 0
    assert logged == []


def test_cancel_of_a_run_that_finished_meanwhile_is_rejected(db_path):
    from app.services.backtest_manager import BacktestManager, RunNotCancellable

    mgr = BacktestManager()
    _seed_run(db_path, "r1", "running")

    def worker_finishes_first(run_id):
        # The worker persists the run between cancel()'s read and its flag
        # write, so the flag write no longer matches.
        with sqlite3.connect(db_path) as c:
            c.execute("UPDATE backtest_runs SET status = 'completed' WHERE id = ?", (run_id,))
        BacktestManager._flag_cancelling_sync(mgr, run_id)

    mgr._flag_cancelling_sync = worker_finishes_first
    with pytest.raises(RunNotCancellable) as excinfo:
        asyncio.run(mgr.cancel("r1"))
    assert excinfo.value.status == "completed"
    assert "r1" not in mgr._cancel_requested
    assert _row(db_path, "r1")["stage"] is None


def test_sweep_finishes_a_pending_cancel_as_cancelled(db_path):
    from app.services.backtest_manager import BacktestManager

    _seed_run(db_path, "pending_cancel", "running", stage="cancelling")
    _seed_run(db_path, "orphan", "running", stage="backtesting")

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        await mgr.shutdown()

    asyncio.run(go())
    cancelled = _row(db_path, "pending_cancel")
    assert (cancelled["status"], cancelled["stage"], cancelled["error"]) == (
        "cancelled", None, None,
    )
    assert cancelled["finished_at"] is not None
    orphan = _row(db_path, "orphan")
    assert orphan["status"] == "failed" and "orphan" in orphan["error"]


# ---------------------------------------------------------------------------
# Undefined metrics are persisted as NULL, not 0
# ---------------------------------------------------------------------------

def test_undefined_metrics_are_persisted_as_null(db_path, monkeypatch):
    from dataclasses import replace

    report = _ok_report()
    no_bets = replace(
        report, bets=[], total_bets=0, hit_rate=0.0, roi=0.0, mean_clv=None,
        brier=0.0, log_loss=0.0, max_drawdown=0.0,
    )
    reports = iter([no_bets, report])
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest", lambda **kw: next(reports),
    )

    empty = _run_once()
    assert (empty.status, empty.total_bets) == ("completed", 0)
    for key in ("hit_rate", "roi", "mean_clv", "brier", "log_loss",
                "max_drawdown", "sharpe_adjusted"):
        assert getattr(empty, key) is None, key

    # Archive bets are priced at the close: CLV is undefined, the rest is not.
    archive = _run_once()
    assert archive.status == "completed"
    assert archive.mean_clv is None
    assert archive.hit_rate == pytest.approx(1.0)
    assert archive.roi == pytest.approx(0.044)


def test_summary_serves_legacy_zero_bet_metrics_as_null():
    from dataclasses import replace

    from app.ml.backtest_storage import RunRow
    from app.routes.backtests import run_row_to_summary

    legacy = RunRow(
        id="r", label="r", model="logistic", train_until="2024-08-01T00:00:00Z",
        test_until=None, min_edge=0.02, kelly_fraction=0.25, force_bets=0,
        scope_json="[]", status="completed", created_at="2024-01-01T00:00:00Z",
        test_events=40, total_bets=0, hit_rate=0.0, roi=0.0, mean_clv=0.0,
        brier=0.0, log_loss=0.0, max_drawdown=0.0, sharpe_adjusted=0.0,
    )
    summary = run_row_to_summary(legacy)
    assert (summary.total_bets, summary.test_events) == (0, 40)
    for key in ("hit_rate", "roi", "mean_clv", "brier", "log_loss",
                "max_drawdown", "sharpe_adjusted"):
        assert getattr(summary, key) is None, key

    with_bets = run_row_to_summary(replace(legacy, total_bets=3, roi=0.0))
    assert with_bets.roi == 0.0  # a measured zero stays zero
