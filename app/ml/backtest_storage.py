"""SQL persistence for backtest_runs and backtest_bets.

Pure-sync helpers over ``sqlite3.Connection``. The async BacktestManager
calls these via ``asyncio.to_thread``.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Sequence


@dataclass(frozen=True)
class RunRow:
    id: str
    label: str
    model: str
    train_until: str
    test_until: Optional[str]
    min_edge: float
    kelly_fraction: float
    force_bets: int  # 0/1
    scope_json: str
    status: str
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None
    test_events: Optional[int] = None
    total_bets: Optional[int] = None
    hit_rate: Optional[float] = None
    roi: Optional[float] = None
    mean_clv: Optional[float] = None
    brier: Optional[float] = None
    log_loss: Optional[float] = None
    max_drawdown: Optional[float] = None
    reliability_json: Optional[str] = None
    stage: Optional[str] = None
    market_spec: str = "football_1x2_ft"
    sharpe_adjusted: Optional[float] = None
    mlflow_run_id: Optional[str] = None


@dataclass(frozen=True)
class BetRow:
    run_id: str
    event_id: str
    bet_ts: str
    kickoff_ts: str
    market: str
    selection: str
    price_taken: float
    closing_price: float
    model_prob: float
    implied_prob: float
    devigged_prob: float
    edge: float
    stake_kelly_fraction: float
    result: float
    pnl: float
    clv: Optional[float]


_RUN_COLS = (
    "id label model train_until test_until min_edge kelly_fraction "
    "force_bets scope_json status created_at started_at finished_at "
    "error test_events total_bets hit_rate roi mean_clv brier log_loss "
    "max_drawdown reliability_json stage market_spec "
    "sharpe_adjusted mlflow_run_id"
).split()

_BET_COLS = (
    "run_id event_id bet_ts kickoff_ts market selection price_taken "
    "closing_price model_prob implied_prob devigged_prob edge "
    "stake_kelly_fraction result pnl clv"
).split()


def insert_run(conn: sqlite3.Connection, row: RunRow) -> None:
    placeholders = ",".join("?" * len(_RUN_COLS))
    conn.execute(
        f"INSERT INTO backtest_runs ({','.join(_RUN_COLS)}) VALUES ({placeholders})",
        tuple(getattr(row, c) for c in _RUN_COLS),
    )
    conn.commit()


def insert_bets(conn: sqlite3.Connection, bets: Sequence[BetRow]) -> None:
    if not bets:
        return
    placeholders = ",".join("?" * len(_BET_COLS))
    conn.executemany(
        f"INSERT INTO backtest_bets ({','.join(_BET_COLS)}) VALUES ({placeholders})",
        [tuple(getattr(b, c) for c in _BET_COLS) for b in bets],
    )
    conn.commit()


def _row_to_run(row: sqlite3.Row) -> RunRow:
    return RunRow(**{c: row[c] for c in _RUN_COLS})


def _row_to_bet(row: sqlite3.Row) -> BetRow:
    return BetRow(**{c: row[c] for c in _BET_COLS})


def get_run(conn: sqlite3.Connection, run_id: str) -> Optional[RunRow]:
    cur = conn.execute("SELECT * FROM backtest_runs WHERE id = ?", (run_id,))
    row = cur.fetchone()
    return _row_to_run(row) if row else None


def list_runs(conn: sqlite3.Connection, *, limit: int = 50) -> List[RunRow]:
    cur = conn.execute(
        "SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?",
        (limit,),
    )
    return [_row_to_run(r) for r in cur.fetchall()]


def list_bets(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    offset: int,
    limit: int,
) -> List[BetRow]:
    cur = conn.execute(
        "SELECT * FROM backtest_bets WHERE run_id = ? "
        "ORDER BY bet_ts ASC, event_id ASC, selection ASC "
        "LIMIT ? OFFSET ?",
        (run_id, limit, offset),
    )
    return [_row_to_bet(r) for r in cur.fetchall()]


def count_bets(conn: sqlite3.Connection, run_id: str) -> int:
    cur = conn.execute(
        "SELECT COUNT(*) AS n FROM backtest_bets WHERE run_id = ?",
        (run_id,),
    )
    return int(cur.fetchone()["n"])


def update_run_status(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    status: str,
    started_at: Optional[str] = None,
    finished_at: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    sets: List[str] = ["status = ?"]
    params: List[Any] = [status]
    if started_at is not None:
        sets.append("started_at = ?")
        params.append(started_at)
    if finished_at is not None:
        sets.append("finished_at = ?")
        params.append(finished_at)
    if error is not None:
        sets.append("error = ?")
        params.append(error)
    params.append(run_id)
    conn.execute(
        f"UPDATE backtest_runs SET {', '.join(sets)} WHERE id = ?",
        params,
    )
    conn.commit()


def finalize_run(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    finished_at: str,
    summary: Mapping[str, Any],
) -> None:
    """Mark run completed and persist summary metrics atomically."""
    cols = (
        "test_events", "total_bets", "hit_rate", "roi", "mean_clv",
        "brier", "log_loss", "max_drawdown", "reliability_json",
        "sharpe_adjusted",
    )
    sets = ["status = ?", "finished_at = ?"] + [f"{c} = ?" for c in cols]
    params: List[Any] = ["completed", finished_at]
    params.extend(summary.get(c) for c in cols)
    params.append(run_id)
    conn.execute(
        f"UPDATE backtest_runs SET {', '.join(sets)} WHERE id = ?",
        params,
    )
    conn.commit()


def update_mlflow_run_id(
    conn: sqlite3.Connection,
    run_id: str,
    mlflow_run_id: Optional[str],
) -> None:
    """Persist the MLflow run id cross-link onto a backtest run.
    Idempotent — safe to call with None (clears the link)."""
    conn.execute(
        "UPDATE backtest_runs SET mlflow_run_id = ? WHERE id = ?",
        (mlflow_run_id, run_id),
    )
    conn.commit()


def delete_run(conn: sqlite3.Connection, run_id: str) -> None:
    conn.execute("DELETE FROM backtest_runs WHERE id = ?", (run_id,))
    conn.commit()
