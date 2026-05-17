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
            max_drawdown REAL, reliability_json TEXT,
            stage TEXT, market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft',
            sharpe_adjusted REAL, mlflow_run_id TEXT
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


def test_run_row_round_trips_stage_and_market_spec(conn):
    """RunRow defaults: stage=None, market_spec='football_1x2_ft'."""
    row = _run()  # the helper defined earlier in the file
    insert_run(conn, row)
    fetched = get_run(conn, "r1")
    assert fetched is not None
    assert fetched.stage is None
    assert fetched.market_spec == "football_1x2_ft"


# ---------------------------------------------------------------------------
# Phase A: sharpe_adjusted + mlflow_run_id
# ---------------------------------------------------------------------------

@pytest.fixture
def db(tmp_path: Path) -> Path:
    """DB with backtest tables created via _ensure_backtest_tables (no Prisma needed)."""
    p = tmp_path / "t.sqlite3"
    from app.services.storage import SnapshotStore
    with sqlite3.connect(p) as c:
        SnapshotStore._ensure_backtest_tables(c)
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, "
            "min_edge, kelly_fraction, force_bets, scope_json, status, created_at) "
            "VALUES ('r1','l','logistic','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','queued','2026-05-15T10:00:00Z')"
        )
        c.commit()
    return p


def test_sharpe_adjusted_and_mlflow_run_id_columns_exist(db):
    with sqlite3.connect(db) as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(backtest_runs)").fetchall()}
    assert "sharpe_adjusted" in cols
    assert "mlflow_run_id" in cols


def test_finalize_run_persists_sharpe_adjusted(db):
    from app.ml.backtest_storage import finalize_run
    with sqlite3.connect(db) as c:
        c.row_factory = sqlite3.Row
        finalize_run(c, "r1", finished_at="2026-05-15T11:00:00Z", summary={
            "test_events": 10, "total_bets": 5,
            "hit_rate": 0.4, "roi": -0.05, "mean_clv": 0.0,
            "brier": 0.2, "log_loss": 0.7, "max_drawdown": 1.0,
            "reliability_json": "[]",
            "sharpe_adjusted": 0.42,
        })
        row = c.execute("SELECT sharpe_adjusted FROM backtest_runs WHERE id='r1'").fetchone()
    assert row["sharpe_adjusted"] == pytest.approx(0.42)


def test_update_mlflow_run_id(db):
    from app.ml.backtest_storage import update_mlflow_run_id
    with sqlite3.connect(db) as c:
        c.row_factory = sqlite3.Row
        update_mlflow_run_id(c, "r1", "abcdef1234")
        row = c.execute("SELECT mlflow_run_id FROM backtest_runs WHERE id='r1'").fetchone()
    assert row["mlflow_run_id"] == "abcdef1234"
