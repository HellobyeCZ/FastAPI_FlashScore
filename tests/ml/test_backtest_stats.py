import os
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from app.ml.backtest_stats import (
    aggregate_backtest,
    BacktestStatsRequest,
    BacktestStatsFilter,
)


@pytest.fixture
def db(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    # Clear settings cache.
    from app.config import get_settings
    get_settings.cache_clear()
    c = sqlite3.connect(p)
    c.row_factory = sqlite3.Row
    c.executescript(
        """
        CREATE TABLE backtest_runs (
            id TEXT PRIMARY KEY, label TEXT, model TEXT,
            train_until TEXT, test_until TEXT,
            min_edge REAL, kelly_fraction REAL, force_bets INTEGER,
            scope_json TEXT, status TEXT, created_at TEXT,
            started_at TEXT, finished_at TEXT, error TEXT,
            test_events INTEGER, total_bets INTEGER, hit_rate REAL,
            roi REAL, mean_clv REAL, brier REAL, log_loss REAL,
            max_drawdown REAL, reliability_json TEXT
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
    c.execute(
        "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
        "kelly_fraction, force_bets, scope_json, status, created_at) "
        "VALUES ('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed','2026-05-13T10:00:00Z')"
    )
    c.executemany(
        "INSERT INTO backtest_bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("r1","E1","2024-08-10T14:55:00Z","2024-08-10T15:00:00Z","1x2_ft","home",2.1,2.1,0.55,0.48,0.46,0.09,0.04,1.0,0.044,0.0),
            ("r1","E2","2024-08-17T14:55:00Z","2024-08-17T15:00:00Z","1x2_ft","draw",3.4,3.4,0.30,0.29,0.28,0.02,0.01,0.0,-0.01,0.0),
        ],
    )
    c.executemany(
        "INSERT INTO match_event_summaries VALUES (?,?,?,?,?)",
        [
            ("E1","football","ENGLAND","Premier League","2024-08-10T15:00:00Z"),
            ("E2","football","ENGLAND","Premier League","2024-08-17T15:00:00Z"),
        ],
    )
    c.commit()
    c.close()
    yield p


def test_aggregate_returns_one_row_no_groupby(db):
    req = BacktestStatsRequest(
        run_ids=("r1",),
        filters=BacktestStatsFilter(),
    )
    rows = aggregate_backtest(req)
    assert len(rows) == 1
    r = rows[0]
    assert r["n"] == 2
    assert r["wins"] == 1
    assert r["hit_rate"] == pytest.approx(0.5)
    # ROI = pnl/stake = (0.044 - 0.01)/(0.04 + 0.01) = 0.034 / 0.05 = 0.68
    assert r["roi"] == pytest.approx(0.68, rel=1e-3)


def test_aggregate_group_by_selection(db):
    req = BacktestStatsRequest(
        run_ids=("r1",),
        filters=BacktestStatsFilter(),
        group_by=("selection",),
    )
    rows = aggregate_backtest(req)
    by_sel = {r["selection"]: r for r in rows}
    assert set(by_sel) == {"home", "draw"}
    assert by_sel["home"]["wins"] == 1
    assert by_sel["draw"]["wins"] == 0


def test_mean_clv_is_null_for_backtests(db):
    """Archive backtests take the closing price, so CLV is undefined —
    the stored 0.0 must not surface as a measured break-even."""
    rows = aggregate_backtest(BacktestStatsRequest(run_ids=("r1",)))
    assert rows[0]["mean_clv"] is None


def test_empty_population_has_null_metrics(db):
    rows = aggregate_backtest(BacktestStatsRequest(
        run_ids=("r1",),
        filters=BacktestStatsFilter(market=("no_such_market",)),
    ))
    assert rows[0]["n"] == 0
    for key in ("hit_rate", "roi", "brier", "mean_clv"):
        assert rows[0][key] is None, key
    assert (rows[0]["wins"], rows[0]["stake_total"], rows[0]["pnl_total"]) == (0, 0.0, 0.0)


def test_group_by_run_id_exposes_label(db):
    rows = aggregate_backtest(BacktestStatsRequest(run_ids=("r1",), group_by=("run_id",)))
    assert len(rows) == 1
    assert rows[0]["run_id"] == "r1"
    assert rows[0]["run_label"] == "l"
    assert rows[0]["n"] == 2


def test_model_filter_reads_the_run_model(db):
    assert aggregate_backtest(BacktestStatsRequest(
        run_ids=("r1",), filters=BacktestStatsFilter(model=("market_implied",)),
    ))[0]["n"] == 2
    assert aggregate_backtest(BacktestStatsRequest(
        run_ids=("r1",), filters=BacktestStatsFilter(model=("logistic",)),
    ))[0]["n"] == 0


def test_status_filter_uses_the_live_vocabulary(db):
    def n(status: str) -> int:
        return aggregate_backtest(BacktestStatsRequest(
            run_ids=("r1",), filters=BacktestStatsFilter(status=status),
        ))[0]["n"]

    # Backtest bets are all settled.
    assert (n("all"), n("settled"), n("pending"), n("voided")) == (2, 2, 0, 0)
    with pytest.raises(ValueError, match="unknown status"):
        BacktestStatsRequest(run_ids=("r1",), filters=BacktestStatsFilter(status="weird"))


def test_group_by_run_id_lists_runs_without_bets(db):
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, status, created_at) "
            "VALUES ('r2', 'empty', 'logistic', 'completed', '2026-05-14T10:00:00Z')"
        )
    rows = aggregate_backtest(BacktestStatsRequest(run_ids=("r2", "r1"), group_by=("run_id",)))
    assert [(r["run_id"], r["n"]) for r in rows] == [("r2", 0), ("r1", 2)]
    assert rows[0]["run_label"] == "empty"
    assert rows[0]["hit_rate"] is None and rows[0]["max_drawdown"] == 0.0

    # A minimum group size hides the empty run like any other small group.
    rows = aggregate_backtest(BacktestStatsRequest(
        run_ids=("r2", "r1"), group_by=("run_id",), min_n_per_group=2,
    ))
    assert [r["run_id"] for r in rows] == ["r1"]
