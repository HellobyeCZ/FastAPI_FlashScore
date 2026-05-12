"""Aggregation queries over paper_bets for /picks/stats.

Separate from paper_trade.py to keep that module focused on
record/settle and avoid growing it into a query toolbox.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.ml import db as ml_db


# Allowed group_by tokens. Used both for validation and for the SQL
# SELECT/GROUP BY clause builder.
ALLOWED_GROUP_BY = (
    "model",
    "market",
    "sport",
    "country",
    "competition",
    "selection",
    "edge_bucket",
    "price_bucket",
    "day",
    "week",
    "month",
)

ALLOWED_STATUS = ("settled", "pending", "all")


@dataclass(frozen=True)
class StatsFilter:
    status: str = "settled"
    date_from: Optional[str] = None   # ISO8601
    date_to: Optional[str] = None
    model: Tuple[str, ...] = ()
    market: Tuple[str, ...] = ()
    sport: Tuple[str, ...] = ()
    country: Tuple[str, ...] = ()
    competition: Tuple[str, ...] = ()
    selection: Tuple[str, ...] = ()
    edge_min: Optional[float] = None
    edge_max: Optional[float] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None


@dataclass(frozen=True)
class StatsRequest:
    group_by: Tuple[str, ...] = ()
    filters: StatsFilter = field(default_factory=StatsFilter)
    min_n_per_group: int = 1

    def __post_init__(self) -> None:
        for token in self.group_by:
            if token not in ALLOWED_GROUP_BY:
                raise ValueError(
                    f"unknown group_by {token!r}. allowed: {ALLOWED_GROUP_BY}"
                )
        if self.filters.status not in ALLOWED_STATUS:
            raise ValueError(
                f"unknown status {self.filters.status!r}. allowed: {ALLOWED_STATUS}"
            )


# Maps group_by token -> SQL SELECT expression. Keys are validated
# against ALLOWED_GROUP_BY in StatsRequest.__post_init__.
_GROUP_EXPR = {
    "model": "pb.model",
    "market": "pb.market",
    "sport": "mes.sport",
    "country": "mes.country",
    "competition": "mes.competition",
    "selection": "pb.selection",
    "edge_bucket": (
        "CASE "
        "WHEN pb.edge IS NULL THEN 'unknown' "
        "WHEN pb.edge < 0.02 THEN '0-2' "
        "WHEN pb.edge < 0.05 THEN '2-5' "
        "WHEN pb.edge < 0.10 THEN '5-10' "
        "WHEN pb.edge < 0.15 THEN '10-15' "
        "ELSE '15+' END"
    ),
    "price_bucket": (
        "CASE "
        "WHEN pb.price_at_recommendation <= 1.5 THEN '<=1.5' "
        "WHEN pb.price_at_recommendation <= 2.0 THEN '1.5-2' "
        "WHEN pb.price_at_recommendation <= 3.0 THEN '2-3' "
        "WHEN pb.price_at_recommendation <= 5.0 THEN '3-5' "
        "ELSE '5+' END"
    ),
    "day": (
        "substr(COALESCE(pb.settled_at, pb.recommended_at), 1, 10)"
    ),
    "week": (
        # ISO week — sqlite-friendly approximation: YYYY-MM-(weekno) via strftime.
        "strftime('%Y-W%W', COALESCE(pb.settled_at, pb.recommended_at))"
    ),
    "month": (
        "substr(COALESCE(pb.settled_at, pb.recommended_at), 1, 7)"
    ),
}


def _build_where(filters: StatsFilter) -> Tuple[str, List[Any]]:
    """Build the WHERE clause and parameter list. All parameter binding
    is positional ('?') — never string-interpolated."""
    where: List[str] = []
    params: List[Any] = []

    if filters.status != "all":
        where.append("pb.status = ?")
        params.append(filters.status)

    if filters.date_from:
        # When filtering by date, use settled_at for settled, else recommended_at.
        where.append(
            "COALESCE(pb.settled_at, pb.recommended_at) >= ?"
        )
        params.append(filters.date_from)
    if filters.date_to:
        where.append(
            "COALESCE(pb.settled_at, pb.recommended_at) <= ?"
        )
        params.append(filters.date_to)

    for col, values in [
        ("pb.model", filters.model),
        ("pb.market", filters.market),
        ("mes.sport", filters.sport),
        ("mes.country", filters.country),
        ("mes.competition", filters.competition),
        ("pb.selection", filters.selection),
    ]:
        if values:
            placeholders = ",".join("?" for _ in values)
            where.append(f"{col} IN ({placeholders})")
            params.extend(values)

    if filters.edge_min is not None:
        where.append("pb.edge >= ?")
        params.append(filters.edge_min)
    if filters.edge_max is not None:
        where.append("pb.edge <= ?")
        params.append(filters.edge_max)
    if filters.price_min is not None:
        where.append("pb.price_at_recommendation >= ?")
        params.append(filters.price_min)
    if filters.price_max is not None:
        where.append("pb.price_at_recommendation <= ?")
        params.append(filters.price_max)

    clause = " AND ".join(where) if where else "1=1"
    return clause, params


def aggregate(request: StatsRequest) -> List[Dict[str, Any]]:
    """Run the aggregation query and return a list of result rows.

    Each row carries the group_by columns plus aggregate metrics
    (n, wins, hit_rate, stake_total, pnl_total, roi, mean_clv,
    brier, max_drawdown). max_drawdown is computed in Python from a
    second pass over the matching rows ordered chronologically.
    """
    where_clause, where_params = _build_where(request.filters)

    select_parts: List[str] = []
    group_parts: List[str] = []
    for token in request.group_by:
        expr = _GROUP_EXPR[token]
        select_parts.append(f"{expr} AS {token}")
        group_parts.append(expr)
    aggregates = """
        COUNT(*) AS n,
        SUM(CASE WHEN pb.result = 1.0 THEN 1 ELSE 0 END) AS wins,
        SUM(COALESCE(pb.kelly_full, 0)) AS stake_total,
        SUM(COALESCE(pb.pnl, 0)) AS pnl_total,
        AVG(pb.clv) AS mean_clv,
        AVG(
            CASE WHEN pb.result IS NOT NULL
                 THEN (pb.model_prob - pb.result) * (pb.model_prob - pb.result)
                 ELSE NULL END
        ) AS brier
    """
    select_clause = ", ".join([*select_parts, aggregates.strip()])
    group_clause = f"GROUP BY {', '.join(group_parts)}" if group_parts else ""
    # HAVING requires GROUP BY in SQLite. When group_by is present we can use
    # HAVING directly; when there is no GROUP BY, wrap as a subquery and filter
    # on n in the outer WHERE.  Both produce the same result set.
    final_params = list(where_params)
    if request.min_n_per_group > 1:
        final_params.append(request.min_n_per_group)
        if group_parts:
            sql = f"""
                SELECT {select_clause}
                FROM paper_bets pb
                LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
                WHERE {where_clause}
                {group_clause}
                HAVING n >= ?
            """
        else:
            inner_sql = f"""
                SELECT {select_clause}
                FROM paper_bets pb
                LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
                WHERE {where_clause}
            """
            sql = f"SELECT * FROM ({inner_sql}) WHERE n >= ?"
    else:
        sql = f"""
            SELECT {select_clause}
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
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

        # Second pass: compute max_drawdown per group from individual bets.
        out = _attach_max_drawdown(conn, out, request, where_clause, where_params)
    return out


def _attach_max_drawdown(
    conn: sqlite3.Connection,
    rows: List[Dict[str, Any]],
    request: StatsRequest,
    where_clause: str,
    where_params: Sequence[Any],
) -> List[Dict[str, Any]]:
    """Compute max drawdown per group by scanning ordered settled bets."""
    # NOTE: This intentionally respects the caller's status filter (it
    # delegates entirely to ``where_clause``). Consequence: when
    # ``status='pending'`` or ``status='all'``, pending bets have
    # ``pnl=NULL`` which COALESCE-coerces to 0.0 — they contribute
    # nothing to the running cumulative. A drawdown computed over a
    # pending-only population will therefore always be 0.0. This is
    # consistent with the rest of the metrics, which use the same
    # population, but callers passing non-settled statuses should
    # interpret max_drawdown as "settled-only loss path."
    if not request.group_by:
        bets = conn.execute(
            f"""
            SELECT pb.pnl, COALESCE(pb.settled_at, pb.recommended_at) AS t
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
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
        f"{_GROUP_EXPR[token]} AS {token}" for token in request.group_by
    )
    bets = conn.execute(
        f"""
        SELECT {group_exprs}, pb.pnl, COALESCE(pb.settled_at, pb.recommended_at) AS t
        FROM paper_bets pb
        LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
        WHERE {where_clause}
        ORDER BY t ASC
        """,
        where_params,
    ).fetchall()
    bucket: Dict[Tuple, List[float]] = {}
    for b in bets:
        key = tuple(b[token] for token in request.group_by)
        bucket.setdefault(key, []).append(b["pnl"] or 0.0)
    for row in rows:
        key = tuple(row[token] for token in request.group_by)
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


def calibration_buckets(
    *,
    model: str,
    filters: StatsFilter = StatsFilter(),
    n_buckets: int = 10,
) -> List[Dict[str, Any]]:
    """Bin settled bets for ``model`` by ``model_prob`` and return the
    per-bucket sample count, mean predicted prob, and empirical hit
    rate. Used by the per-model deep-dive calibration plot."""
    width = 1.0 / n_buckets
    # Ensure paper_bets table exists before the read-only query.
    from app.ml.paper_trade import _ensure_paper_bets_table
    _ensure_paper_bets_table()
    # Force model filter to the given model, on top of caller filters.
    model_filters = filters.__class__(
        **{**filters.__dict__, "model": tuple([model])}
    )
    # Settled rows only.
    if model_filters.status == "pending":
        return []
    if model_filters.status == "all":
        model_filters = model_filters.__class__(
            **{**model_filters.__dict__, "status": "settled"}
        )

    where_clause, where_params = _build_where(model_filters)
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"""
            SELECT pb.model_prob AS p, pb.result AS r
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            WHERE {where_clause}
              AND pb.status = 'settled'
              AND pb.result IS NOT NULL
            """,
            where_params,
        ).fetchall()
    if not rows:
        return []

    buckets: List[List[Tuple[float, float]]] = [[] for _ in range(n_buckets)]
    for row in rows:
        p = float(row["p"])
        idx = min(int(p / width), n_buckets - 1)
        buckets[idx].append((p, float(row["r"])))
    out: List[Dict[str, Any]] = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        mean_pred = sum(p for p, _ in bucket) / len(bucket)
        hit_rate = sum(r for _, r in bucket) / len(bucket)
        out.append({
            "lower": i * width,
            "upper": (i + 1) * width,
            "n": len(bucket),
            "mean_pred": mean_pred,
            "hit_rate": hit_rate,
        })
    return out
