import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from app.ml.picks_facets import (
    FacetsResponse,
    facets_for_live,
    facets_for_backtest,
    facets_for_both,
)


@pytest.fixture
def db(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    from app.config import get_settings
    get_settings.cache_clear()
    c = sqlite3.connect(p)
    c.row_factory = sqlite3.Row
    c.executescript(
        """
        CREATE TABLE paper_bets (
            event_id TEXT, recommended_at TEXT, market TEXT, selection TEXT,
            model TEXT, model_prob REAL, price_at_recommendation REAL, edge REAL,
            kelly_full REAL, status TEXT, result REAL, pnl REAL, clv REAL
        );
        CREATE TABLE backtest_runs (
            id TEXT PRIMARY KEY, label TEXT, model TEXT,
            train_until TEXT, test_until TEXT,
            min_edge REAL, kelly_fraction REAL, force_bets INTEGER,
            scope_json TEXT, status TEXT, created_at TEXT,
            started_at TEXT, finished_at TEXT, error TEXT,
            test_events INTEGER, total_bets INTEGER, hit_rate REAL,
            roi REAL, mean_clv REAL, brier REAL, log_loss REAL,
            max_drawdown REAL, reliability_json TEXT,
            stage TEXT, market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'
        );
        CREATE TABLE backtest_bets (
            run_id TEXT, event_id TEXT, bet_ts TEXT, kickoff_ts TEXT,
            market TEXT, selection TEXT, price_taken REAL,
            closing_price REAL, model_prob REAL, implied_prob REAL,
            devigged_prob REAL, edge REAL, stake_kelly_fraction REAL,
            result REAL, pnl REAL, clv REAL
        );
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY, sport TEXT, country TEXT,
            competition TEXT, start_time_utc TEXT
        );
        """
    )
    c.executemany(
        "INSERT INTO paper_bets (event_id, recommended_at, market, selection, model) VALUES (?,?,?,?,?)",
        [
            ("E1", "2024-08-10T14:55:00Z", "1x2_ft", "home", "logistic"),
            ("E2", "2024-08-17T14:55:00Z", "1x2_ft", "draw", "dixon_coles"),
        ],
    )
    c.execute(
        "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
        "kelly_fraction, force_bets, scope_json, status, created_at) VALUES "
        "('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed','2026-05-13T10:00:00Z')"
    )
    c.execute(
        "INSERT INTO backtest_bets VALUES "
        "('r1','E3','2024-09-10T14:55:00Z','2024-09-10T15:00:00Z','1x2_ft','away',"
        "2.5,2.5,0.4,0.4,0.4,0.0,1.0,1.0,1.5,0.0)"
    )
    c.executemany(
        "INSERT INTO match_event_summaries VALUES (?,?,?,?,?)",
        [
            ("E1", "football", "ENGLAND", "Premier League", "2024-08-10T15:00:00Z"),
            ("E2", "football", "GERMANY", "Bundesliga", "2024-08-17T15:00:00Z"),
            ("E3", "football", "SPAIN", "LaLiga", "2024-09-10T15:00:00Z"),
        ],
    )
    c.commit()
    c.close()
    yield p


def test_facets_for_live_returns_only_live_facets(db):
    f = facets_for_live()
    assert "ENGLAND" in f.countries
    assert "GERMANY" in f.countries
    assert "SPAIN" not in f.countries
    assert "logistic" in f.models
    assert "dixon_coles" in f.models
    assert "market_implied" not in f.models
    assert "1x2_ft" in f.markets
    assert "home" in f.selections
    assert "draw" in f.selections


def test_facets_for_backtest_returns_only_run_facets(db):
    f = facets_for_backtest(("r1",))
    assert f.countries == ["SPAIN"]
    assert f.competitions == ["LaLiga"]
    assert f.models == ["market_implied"]
    assert f.selections == ["away"]
    assert "ENGLAND" not in f.countries


def test_facets_for_both_unions(db):
    f = facets_for_both(("r1",))
    assert set(f.countries) == {"ENGLAND", "GERMANY", "SPAIN"}
    assert set(f.models) == {"logistic", "dixon_coles", "market_implied"}


def test_facets_for_backtest_unknown_run_returns_empty(db):
    f = facets_for_backtest(("does_not_exist",))
    assert f.countries == []
    assert f.models == []
