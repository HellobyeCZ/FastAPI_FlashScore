"""Aggregation over backtest_bets — the source-side mirror of
``paper_trade_stats.aggregate``.

Same response shape (n, wins, hit_rate, stake_total, pnl_total, roi,
mean_clv, brier, max_drawdown) so the frontend can render identical
charts whether ``source=live`` or ``source=backtest``.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.ml import db as ml_db


ALLOWED_GROUP_BY = (
    "model",
    "market", "sport", "country", "competition",
    "selection", "edge_bucket", "price_bucket", "day", "week", "month",
)


@dataclass(frozen=True)
class BacktestStatsFilter:
    market: Tuple[str, ...] = ()
    sport: Tuple[str, ...] = ()
    country: Tuple[str, ...] = ()
    competition: Tuple[str, ...] = ()
    selection: Tuple[str, ...] = ()
    edge_min: Optional[float] = None
    edge_max: Optional[float] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None


@dataclass(frozen=True)
class BacktestStatsRequest:
    run_ids: Tuple[str, ...]
    filters: BacktestStatsFilter = field(default_factory=BacktestStatsFilter)
    group_by: Tuple[str, ...] = ()
    min_n_per_group: int = 1

    def __post_init__(self) -> None:
        if not self.run_ids:
            raise ValueError("run_ids must contain at least one id")
        for t in self.group_by:
            if t not in ALLOWED_GROUP_BY:
                raise ValueError(
                    f"unknown group_by {t!r}. allowed: {ALLOWED_GROUP_BY}"
                )


_GROUP_EXPR = {
    # model lives on backtest_runs, joined as r.
    "model": "r.model",
    "market": "b.market",
    "sport": "mes.sport",
    "country": "mes.country",
    "competition": "mes.competition",
    "selection": "b.selection",
    "edge_bucket": (
        "CASE "
        "WHEN b.edge IS NULL THEN 'unknown' "
        "WHEN b.edge < 0.02 THEN '0-2' "
        "WHEN b.edge < 0.05 THEN '2-5' "
        "WHEN b.edge < 0.10 THEN '5-10' "
        "WHEN b.edge < 0.15 THEN '10-15' "
        "ELSE '15+' END"
    ),
    "price_bucket": (
        "CASE "
        "WHEN b.price_taken <= 1.5 THEN '<=1.5' "
        "WHEN b.price_taken <= 2.0 THEN '1.5-2' "
        "WHEN b.price_taken <= 3.0 THEN '2-3' "
        "WHEN b.price_taken <= 5.0 THEN '3-5' "
        "ELSE '5+' END"
    ),
    "day": "substr(b.bet_ts, 1, 10)",
    "week": "strftime('%Y-W%W', b.bet_ts)",
    "month": "substr(b.bet_ts, 1, 7)",
}


def _build_where(run_ids: Sequence[str], f: BacktestStatsFilter) -> Tuple[str, List[Any]]:
    """Build WHERE clause and positional parameter list."""
    placeholders = ",".join("?" for _ in run_ids)
    where: List[str] = [f"b.run_id IN ({placeholders})"]
    params: List[Any] = list(run_ids)

    for col, values in [
        ("b.market", f.market),
        ("mes.sport", f.sport),
        ("mes.country", f.country),
        ("mes.competition", f.competition),
        ("b.selection", f.selection),
    ]:
        if values:
            placeholders = ",".join("?" for _ in values)
            where.append(f"{col} IN ({placeholders})")
            params.extend(values)

    if f.edge_min is not None:
        where.append("b.edge >= ?")
        params.append(f.edge_min)
    if f.edge_max is not None:
        where.append("b.edge <= ?")
        params.append(f.edge_max)
    if f.price_min is not None:
        where.append("b.price_taken >= ?")
        params.append(f.price_min)
    if f.price_max is not None:
        where.append("b.price_taken <= ?")
        params.append(f.price_max)
    if f.date_from:
        where.append("b.bet_ts >= ?")
        params.append(f.date_from)
    if f.date_to:
        where.append("b.bet_ts <= ?")
        params.append(f.date_to)

    return " AND ".join(where), params


def aggregate_backtest(req: BacktestStatsRequest) -> List[Dict[str, Any]]:
    """Run the aggregation query and return a list of result rows.

    Each row carries the group_by columns plus aggregate metrics
    (n, wins, hit_rate, stake_total, pnl_total, roi, mean_clv,
    brier, max_drawdown). max_drawdown is computed in Python from a
    second pass over matching rows ordered chronologically.
    """
    where_clause, where_params = _build_where(req.run_ids, req.filters)

    select_parts: List[str] = []
    group_parts: List[str] = []
    for token in req.group_by:
        expr = _GROUP_EXPR[token]
        select_parts.append(f"{expr} AS {token}")
        group_parts.append(expr)

    aggregates = """
        COUNT(*) AS n,
        SUM(CASE WHEN b.result = 1.0 THEN 1 ELSE 0 END) AS wins,
        SUM(COALESCE(b.stake_kelly_fraction, 0)) AS stake_total,
        SUM(COALESCE(b.pnl, 0)) AS pnl_total,
        AVG(b.clv) AS mean_clv,
        AVG(
            CASE WHEN b.result IS NOT NULL
                 THEN (b.model_prob - b.result) * (b.model_prob - b.result)
                 ELSE NULL END
        ) AS brier
    """
    select_clause = ", ".join([*select_parts, aggregates.strip()])
    group_clause = f"GROUP BY {', '.join(group_parts)}" if group_parts else ""

    final_params = list(where_params)
    if req.min_n_per_group > 1 and group_parts:
        final_params.append(req.min_n_per_group)
        sql = f"""
            SELECT {select_clause}
            FROM backtest_bets b
            JOIN backtest_runs r ON r.id = b.run_id
            LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id
            WHERE {where_clause}
            {group_clause}
            HAVING n >= ?
        """
    else:
        sql = f"""
            SELECT {select_clause}
            FROM backtest_bets b
            JOIN backtest_runs r ON r.id = b.run_id
            LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id
            WHERE {where_clause}
            {group_clause}
        """

    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, final_params).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            entry: Dict[str, Any] = dict(row)
            n = entry.get("n", 0) or 0
            wins = entry.get("wins", 0) or 0
            stake = entry.get("stake_total", 0.0) or 0.0
            pnl = entry.get("pnl_total", 0.0) or 0.0
            entry["hit_rate"] = (wins / n) if n > 0 else None
            entry["roi"] = (pnl / stake) if stake > 0 else None
            out.append(entry)

        # Second pass: compute max_drawdown per group from ordered bets.
        out = _attach_max_drawdown(conn, out, req, where_clause, where_params)
    return out


def _attach_max_drawdown(
    conn: sqlite3.Connection,
    rows: List[Dict[str, Any]],
    req: BacktestStatsRequest,
    where_clause: str,
    where_params: Sequence[Any],
) -> List[Dict[str, Any]]:
    """Compute max drawdown per group by scanning ordered bets."""
    if not req.group_by:
        bets = conn.execute(
            f"""
            SELECT b.pnl, b.bet_ts AS t
            FROM backtest_bets b
            JOIN backtest_runs r ON r.id = b.run_id
            LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id
            WHERE {where_clause}
            ORDER BY t ASC
            """,
            where_params,
        ).fetchall()
        if rows:
            rows[0]["max_drawdown"] = _max_drawdown([b["pnl"] or 0.0 for b in bets])
        return rows

    # Group-by case: pull per-group ordered bets, compute per group.
    group_exprs = ", ".join(
        f"{_GROUP_EXPR[token]} AS {token}" for token in req.group_by
    )
    bets = conn.execute(
        f"""
        SELECT {group_exprs}, b.pnl, b.bet_ts AS t
        FROM backtest_bets b
        JOIN backtest_runs r ON r.id = b.run_id
        LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id
        WHERE {where_clause}
        ORDER BY t ASC
        """,
        where_params,
    ).fetchall()
    bucket: Dict[Tuple, List[float]] = {}
    for b in bets:
        key = tuple(b[token] for token in req.group_by)
        bucket.setdefault(key, []).append(b["pnl"] or 0.0)
    for row in rows:
        key = tuple(row[token] for token in req.group_by)
        row["max_drawdown"] = _max_drawdown(bucket.get(key, []))
    return rows


def _max_drawdown(pnls: Sequence[float]) -> float:
    """Scan cumulative P&L and return the largest peak-to-trough decline."""
    running = 0.0
    peak = 0.0
    max_dd = 0.0
    for x in pnls:
        running += x
        if running > peak:
            peak = running
        dd = peak - running
        if dd > max_dd:
            max_dd = dd
    return max_dd
