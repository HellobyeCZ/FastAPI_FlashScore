import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from app.ml.backtest_storage import (
    insert_run,
    insert_bets,
    list_runs,
    get_run,
    list_bets,
    count_bets,
    update_run_status,
    finalize_run,
    delete_run,
    RunRow,
    BetRow,
)


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db = tmp_path / "test.sqlite3"
    c = sqlite3.connect(db)
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
            result REAL, pnl REAL, clv REAL,
            PRIMARY KEY (run_id, event_id, market, selection),
            FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
        );
        """
    )
    c.execute("PRAGMA foreign_keys=ON")
    yield c
    c.close()


def _run() -> RunRow:
    return RunRow(
        id="r1",
        label="market_implied_2026",
        model="market_implied",
        train_until="2024-08-01T00:00:00Z",
        test_until=None,
        min_edge=0.02,
        kelly_fraction=0.25,
        force_bets=0,
        scope_json=json.dumps([["england", "premier-league"]]),
        status="queued",
        created_at="2026-05-13T10:00:00Z",
    )


def _bet(selection: str) -> BetRow:
    return BetRow(
        run_id="r1",
        event_id="E1",
        bet_ts="2024-08-10T14:55:00Z",
        kickoff_ts="2024-08-10T15:00:00Z",
        market="1x2_ft",
        selection=selection,
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


def test_insert_and_list_run(conn):
    insert_run(conn, _run())
    rows = list_runs(conn, limit=10)
    assert len(rows) == 1
    assert rows[0].id == "r1"
    assert rows[0].status == "queued"


def test_update_run_status(conn):
    insert_run(conn, _run())
    update_run_status(conn, "r1", status="running", started_at="2026-05-13T10:01:00Z")
    r = get_run(conn, "r1")
    assert r.status == "running"
    assert r.started_at == "2026-05-13T10:01:00Z"


def test_insert_bets_and_finalize(conn):
    insert_run(conn, _run())
    insert_bets(conn, [_bet("home"), _bet("draw")])
    finalize_run(
        conn,
        "r1",
        finished_at="2026-05-13T10:02:00Z",
        summary={
            "test_events": 1,
            "total_bets": 2,
            "hit_rate": 0.5,
            "roi": 0.022,
            "mean_clv": 0.0,
            "brier": 0.2,
            "log_loss": 0.5,
            "max_drawdown": 0.0,
            "reliability_json": "[]",
        },
    )
    r = get_run(conn, "r1")
    assert r.status == "completed"
    assert r.total_bets == 2
    bets = list_bets(conn, "r1", offset=0, limit=10)
    assert len(bets) == 2
    assert count_bets(conn, "r1") == 2


def test_delete_run_cascades(conn):
    insert_run(conn, _run())
    insert_bets(conn, [_bet("home")])
    delete_run(conn, "r1")
    assert get_run(conn, "r1") is None
    assert list_bets(conn, "r1", offset=0, limit=10) == []
