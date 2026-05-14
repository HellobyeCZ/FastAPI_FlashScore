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

    with sqlite3.connect(db) as c:
        from app.ml.paper_trade import _ensure_paper_bets_table
        _ensure_paper_bets_table()
        # Inspect actual columns to build safe inserts
        pb_cols = [r[1] for r in c.execute("PRAGMA table_info(paper_bets)").fetchall()]
        # Seed paper_bets (two countries)
        for row in [
            {
                "event_id": "E1",
                "recommended_at": "2024-08-10T14:55:00Z",
                "bet_ts": "2024-08-10T14:55:00Z",
                "market": "1x2_ft",
                "selection": "home",
                "model": "logistic",
                "model_prob": 0.55,
                "price_at_recommendation": 2.1,
                "edge": 0.09,
                "kelly_full": 0.04,
                "status": "settled",
                "result": 1.0,
                "pnl": 0.044,
                "clv": 0.0,
            },
            {
                "event_id": "E2",
                "recommended_at": "2024-08-17T14:55:00Z",
                "bet_ts": "2024-08-17T14:55:00Z",
                "market": "1x2_ft",
                "selection": "draw",
                "model": "dixon_coles",
                "model_prob": 0.30,
                "price_at_recommendation": 3.4,
                "edge": 0.02,
                "kelly_full": 0.01,
                "status": "settled",
                "result": 0.0,
                "pnl": -0.01,
                "clv": 0.0,
            },
        ]:
            used = [k for k in row if k in pb_cols]
            c.execute(
                f"INSERT INTO paper_bets ({','.join(used)}) "
                f"VALUES ({','.join('?' for _ in used)})",
                tuple(row[k] for k in used),
            )
        # match_event_summaries (use real schema — check NOT NULL columns)
        cols = [r[1] for r in c.execute("PRAGMA table_info(match_event_summaries)").fetchall()]
        for ev in [
            {"event_id": "E1", "sport": "football", "country": "ENGLAND",
             "competition": "Premier League", "start_time_utc": "2024-08-10T15:00:00Z"},
            {"event_id": "E2", "sport": "football", "country": "GERMANY",
             "competition": "Bundesliga", "start_time_utc": "2024-08-17T15:00:00Z"},
        ]:
            if "updated_at" in cols:
                ev["updated_at"] = ev["start_time_utc"]
            if "status" in cols:
                ev["status"] = "finished"
            used = [k for k in ev if k in cols]
            c.execute(
                f"INSERT INTO match_event_summaries ({','.join(used)}) "
                f"VALUES ({','.join('?' for _ in used)})",
                tuple(ev[k] for k in used),
            )
        # Seed a backtest run + bet (third country)
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
            "kelly_fraction, force_bets, scope_json, status, created_at, market_spec) "
            "VALUES ('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed',"
            "'2026-05-13T10:00:00Z','football_1x2_ft')"
        )
        c.execute(
            "INSERT INTO backtest_bets VALUES "
            "('r1','E1','2024-08-10T14:55:00Z','2024-08-10T15:00:00Z','1x2_ft','away',"
            "2.5,2.5,0.4,0.4,0.4,0.0,1.0,0.0,0.0,0.0)"
        )
        c.commit()

    from src import _get_backtest_manager
    _get_backtest_manager.cache_clear()

    from src import app
    with TestClient(app) as c:
        yield c

    _get_backtest_manager.cache_clear()


def test_facets_source_live(client):
    r = client.get("/picks/facets?source=live")
    assert r.status_code == 200
    body = r.json()
    assert "ENGLAND" in body["countries"]
    assert "GERMANY" in body["countries"]
    assert "logistic" in body["models"]


def test_facets_source_backtest_requires_run_id(client):
    r = client.get("/picks/facets?source=backtest")
    assert r.status_code == 400


def test_facets_source_backtest_returns_run_facets(client):
    r = client.get("/picks/facets?source=backtest&run_id=r1")
    assert r.status_code == 200
    body = r.json()
    assert body["models"] == ["market_implied"]
    assert body["selections"] == ["away"]


def test_facets_source_both_unions(client):
    r = client.get("/picks/facets?source=both&run_id=r1")
    assert r.status_code == 200
    body = r.json()
    assert "logistic" in body["models"]
    assert "market_implied" in body["models"]


def test_facets_unknown_source_returns_400(client):
    r = client.get("/picks/facets?source=invalid")
    assert r.status_code == 400
