"""run_backtest accepts a market_spec kwarg and uses it for selections + label."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from app.ml.backtest import run_backtest
from app.ml.market_spec import FOOTBALL_1X2_FT


@pytest.fixture
def empty_db(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    """Empty SQLite with the schema run_backtest expects, so queries
    return zero rows without erroring."""
    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    from app.config import get_settings
    get_settings.cache_clear()
    c = sqlite3.connect(p)
    c.executescript(
        """
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY,
            event_name TEXT,
            home_team TEXT,
            away_team TEXT,
            sport TEXT,
            country TEXT,
            competition TEXT,
            competition_stage TEXT,
            competition_path TEXT,
            start_time_utc TEXT,
            status TEXT,
            status_detail TEXT,
            outcome TEXT,
            odds_snapshot_count INTEGER NOT NULL DEFAULT 0,
            stats_snapshot_count INTEGER NOT NULL DEFAULT 0,
            latest_odds_fetched_at TEXT,
            latest_stats_fetched_at TEXT,
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE bet_labels (
            event_id TEXT PRIMARY KEY,
            sport TEXT NOT NULL,
            country TEXT,
            competition TEXT,
            start_time_utc TEXT,
            home_team TEXT,
            away_team TEXT,
            home_score INTEGER NOT NULL DEFAULT 0,
            away_score INTEGER NOT NULL DEFAULT 0,
            outcome_1x2 TEXT NOT NULL DEFAULT '',
            total_goals INTEGER NOT NULL DEFAULT 0,
            over_2_5 INTEGER NOT NULL DEFAULT 0,
            btts INTEGER NOT NULL DEFAULT 0,
            home_goals_first_half INTEGER,
            away_goals_first_half INTEGER,
            derived_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE closing_odds (
            event_id TEXT NOT NULL,
            bookmaker TEXT NOT NULL,
            market TEXT NOT NULL,
            selection_key TEXT NOT NULL,
            decimal_price REAL NOT NULL,
            implied_prob REAL NOT NULL,
            devigged_prob REAL,
            derived_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (event_id, bookmaker, market, selection_key)
        );
        CREATE TABLE odds_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            fetched_at TEXT,
            source TEXT,
            correlation_id TEXT,
            odds_payload_json TEXT,
            upstream_payload_json TEXT
        );
        """
    )
    c.commit()
    c.close()
    yield p


def test_run_backtest_accepts_market_spec_kwarg(empty_db):
    """Smoke: passing market_spec doesn't error on signature."""
    def stub_model(features, market_ctx):
        return {"home": 0.5, "draw": 0.25, "away": 0.25}

    report = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
    )
    assert report.test_events == 0
    assert report.total_bets == 0


def test_run_backtest_market_spec_default_is_football_1x2_ft(empty_db):
    """Calling without market_spec should behave identically to passing FOOTBALL_1X2_FT."""
    def stub_model(features, market_ctx):
        return {"home": 0.5, "draw": 0.25, "away": 0.25}

    a = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",
    )
    b = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
    )
    assert a.test_events == b.test_events
    assert a.total_bets == b.total_bets
