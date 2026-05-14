import asyncio
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
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

    # Seed a backtest run + bet + match summary so /picks/stats?source=backtest finds data.
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
            "kelly_fraction, force_bets, scope_json, status, created_at) VALUES "
            "('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed','2026-05-13T10:00:00Z')"
        )
        c.execute(
            "INSERT INTO backtest_bets VALUES "
            "('r1','E1','2024-08-10T14:55:00Z','2024-08-10T15:00:00Z','1x2_ft','home',"
            "2.1,2.1,0.55,0.48,0.46,0.09,0.04,1.0,0.044,0.0)"
        )
        # match_event_summaries already exists from SnapshotStore; insert with all NOT NULL cols.
        # Inspect what columns exist:
        cols = c.execute("PRAGMA table_info(match_event_summaries)").fetchall()
        col_names = [r[1] for r in cols]
        # Build a row with sensible defaults for any NOT NULL non-defaulted columns.
        # Common columns: event_id, sport, country, competition, start_time_utc, updated_at.
        # If updated_at exists and is NOT NULL, supply it.
        row_data = {
            "event_id": "E1",
            "sport": "football",
            "country": "ENGLAND",
            "competition": "Premier League",
            "start_time_utc": "2024-08-10T15:00:00Z",
        }
        if "updated_at" in col_names:
            row_data["updated_at"] = "2024-08-10T15:00:00Z"
        if "status" in col_names:
            row_data["status"] = "finished"
        if "home_team" in col_names:
            row_data["home_team"] = "H"
        if "away_team" in col_names:
            row_data["away_team"] = "A"
        if "home_score" in col_names:
            row_data["home_score"] = 1
        if "away_score" in col_names:
            row_data["away_score"] = 0
        used = [k for k in row_data if k in col_names]
        c.execute(
            f"INSERT INTO match_event_summaries ({','.join(used)}) VALUES ({','.join('?' for _ in used)})",
            tuple(row_data[k] for k in used),
        )
        c.commit()

    # Clear lru_cache so a fresh BacktestManager picks up the env var.
    from src import _get_backtest_manager
    _get_backtest_manager.cache_clear()

    from src import app
    with TestClient(app) as c:
        yield c
    _get_backtest_manager.cache_clear()


def test_stats_source_backtest_returns_backtest_aggregation(client: TestClient):
    resp = client.get("/picks/stats", params={"source": "backtest", "run_id": "r1"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = body.get("rows") or body.get("items") or body
    assert isinstance(rows, list)
    assert rows
    assert rows[0]["n"] == 1


def test_stats_source_backtest_requires_run_id(client: TestClient):
    resp = client.get("/picks/stats", params={"source": "backtest"})
    assert resp.status_code == 400


def test_stats_source_both_returns_400_until_task_10(client: TestClient):
    resp = client.get(
        "/picks/stats",
        params={"source": "both", "run_id": "r1"},
    )
    assert resp.status_code == 400
