"""End-to-end-ish tests for /backtest/* routes."""
from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app_client(tmp_path: Path, monkeypatch) -> Iterator[TestClient]:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))

    # Clear settings cache so the env var takes effect.
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

    # Init SnapshotStore tables.
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())

    # Seed kickoff so leakage check passes for our stubbed bet.
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT OR IGNORE INTO match_event_summaries (event_id, start_time_utc, updated_at) VALUES (?, ?, ?)",
            ("E1", "2024-08-10T15:00:00Z", "2024-08-10T15:00:00Z"),
        )
        c.commit()

    from app.ml.backtest import BacktestReport, BetRecord
    def _stub(**kw):
        bet = BetRecord(
            event_id="E1", bet_ts="2024-08-10T14:55:00Z",
            market="1x2_ft", selection="home",
            price_taken=2.10, closing_price=2.10,
            model_prob=0.55, implied_prob=0.48, devigged_prob=0.46,
            edge=0.09, stake_kelly_fraction=0.04,
            result=1.0, pnl=0.044, clv=0.0,
        )
        return BacktestReport(
            model=kw["model"], scope_size=1, test_events=1,
            bets=[bet], total_bets=1, hit_rate=1.0, roi=0.044,
            mean_clv=0.0, brier=0.2, log_loss=0.5, max_drawdown=0.0,
            reliability_buckets=[], config={},
        )
    monkeypatch.setattr("app.services.backtest_manager.run_backtest", _stub)

    # Clear any lru_cache'd BacktestManager so the new env var path is honored.
    from src import _get_backtest_manager
    _get_backtest_manager.cache_clear()

    from src import app
    with TestClient(app) as client:
        yield client

    # Cleanup
    _get_backtest_manager.cache_clear()


def _wait_completed(client: TestClient, run_id: str, timeout_s: float = 5.0) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = client.get(f"/backtest/runs/{run_id}").json()
        if r.get("status") in ("completed", "failed"):
            return r
        time.sleep(0.05)
    return client.get(f"/backtest/runs/{run_id}").json()


def test_create_list_get_delete(app_client: TestClient):
    resp = app_client.post(
        "/backtest/runs",
        json={"model": "market_implied", "train_until": "2024-08-01T00:00:00Z"},
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]

    detail = _wait_completed(app_client, run_id)
    assert detail["status"] == "completed", f"detail={detail}"
    assert detail["total_bets"] == 1

    listing = app_client.get("/backtest/runs").json()
    assert any(r["id"] == run_id for r in listing["items"])

    bets = app_client.get(f"/backtest/runs/{run_id}/bets").json()
    assert bets["total"] == 1
    assert bets["items"][0]["event_id"] == "E1"

    d = app_client.delete(f"/backtest/runs/{run_id}")
    assert d.status_code == 200
    assert app_client.get(f"/backtest/runs/{run_id}").status_code == 404


def test_create_rejects_bad_payload(app_client: TestClient):
    resp = app_client.post(
        "/backtest/runs",
        json={"model": "market_implied", "train_until": "not-a-date"},
    )
    assert resp.status_code == 422


def test_models_endpoint_lists_registry(app_client: TestClient):
    """Names appear in items[]."""
    resp = app_client.get("/backtest/models")
    assert resp.status_code == 200
    names = [it["name"] for it in resp.json()["items"]]
    assert "market_implied" in names


def test_create_run_accepts_market_spec(app_client: TestClient):
    """POST body's market_spec is honored and persisted on the run."""
    resp = app_client.post(
        "/backtest/runs",
        json={
            "model": "market_implied",
            "train_until": "2024-08-01T00:00:00Z",
            "market_spec": "football_1x2_ft",
        },
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]

    detail = _wait_completed(app_client, run_id)
    assert detail["market_spec"] == "football_1x2_ft"


def test_create_run_rejects_unknown_market_spec(app_client: TestClient):
    """A market_spec value that doesn't resolve should surface as a failed run."""
    import time

    resp = app_client.post(
        "/backtest/runs",
        json={
            "model": "market_implied",
            "train_until": "2024-08-01T00:00:00Z",
            "market_spec": "does_not_exist",
        },
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]

    for _ in range(50):
        r = app_client.get(f"/backtest/runs/{run_id}").json()
        if r["status"] == "failed":
            break
        time.sleep(0.05)

    r = app_client.get(f"/backtest/runs/{run_id}").json()
    assert r["status"] == "failed"
    assert "market_spec" in (r["error"] or "").lower()


def test_delete_refuses_running_run(app_client: TestClient, monkeypatch):
    """DELETE on a queued/running run returns 409."""
    import time

    # The worker calls run_backtest in a thread, so we need a sync stub that blocks.
    def slow_sync(**kw):
        time.sleep(60)

    monkeypatch.setattr("app.services.backtest_manager.run_backtest", slow_sync)

    resp = app_client.post(
        "/backtest/runs",
        json={"model": "market_implied", "train_until": "2024-08-01T00:00:00Z"},
    )
    run_id = resp.json()["id"]

    # Wait briefly for status to flip from queued to running.
    for _ in range(50):
        r = app_client.get(f"/backtest/runs/{run_id}").json()
        if r["status"] in ("queued", "running"):
            break
        time.sleep(0.05)

    # DELETE should refuse.
    d = app_client.delete(f"/backtest/runs/{run_id}")
    assert d.status_code == 409, f"expected 409 got {d.status_code} body={d.text}"
    assert "cancel" in d.json()["detail"].lower() or "running" in d.json()["detail"].lower()


def test_models_endpoint_returns_items_with_kind(app_client: TestClient):
    """Items include analytic and trainable kinds with correct labels."""
    resp = app_client.get("/backtest/models")
    assert resp.status_code == 200
    body = resp.json()
    assert "items" in body
    kinds_by_name = {it["name"]: it["kind"] for it in body["items"]}
    # Analytic baselines
    assert kinds_by_name.get("market_implied") == "analytic"
    # Trainable
    assert kinds_by_name.get("logistic") == "trainable"
    assert kinds_by_name.get("dixon_coles") == "trainable"
