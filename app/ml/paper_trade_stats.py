"""Aggregation queries over paper_bets for /picks/stats.

Separate from paper_trade.py to keep that module focused on
record/settle and avoid growing it into a query toolbox.
"""
from __future__ import annotations

import contextlib
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
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

ALLOWED_STATUS = ("settled", "pending", "voided", "all")


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
            if n == 0:
                # An empty population has no hit rate, ROI, Brier or CLV —
                # report "undefined", never a measured zero.
                entry.update(hit_rate=None, roi=None, brier=None, mean_clv=None)
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
    rate. Used by the per-model deep-dive calibration plot.

    Calibration is only defined for settled bets, so this function
    overrides the caller's ``filters.status`` accordingly:

      - ``status="settled"`` (default): query settled rows.
      - ``status="all"``: silently rewritten to "settled".
      - ``status="pending"``: returns ``[]`` immediately because
        calibration is undefined for unsettled bets.

    The caller's ``filters.model`` is also overridden to ``(model,)``.

    Each returned bucket assumes a binary ``result`` (1.0 for win,
    0.0 for loss). Markets with fractional outcomes (e.g. Asian
    handicap half-wins) would need a different definition of
    ``hit_rate`` than the current ``sum(result) / n`` mean.
    """
    if n_buckets < 1:
        raise ValueError(f"n_buckets must be >= 1, got {n_buckets}")
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


# ---------------------------------------------------------------------------
# Bet history (/picks/history, /events/{id}/picks) and pipeline freshness
# ---------------------------------------------------------------------------

# A pending bet whose kickoff is older than this should have been settled.
SETTLE_GRACE = timedelta(hours=6)

# Display columns for history rows. Archive summaries win; fixtures captured
# by discovery fill in events the archive has not seen yet (most pending
# bets). ``upcoming_fixtures.country`` is lowercase, the archive's is
# uppercase, so the fallback is upper-cased to keep one vocabulary.
# ``kickoff``/``home_team_raw``/``away_team_raw``/``competition_path`` keep
# the keys the dashboard already reads.
_HISTORY_DISPLAY_WITH_FIXTURES = """
    COALESCE(mes.start_time_utc, uf.start_time_utc) AS kickoff,
    uf.home_team_raw AS home_team_raw,
    uf.away_team_raw AS away_team_raw,
    uf.competition_path AS competition_path,
    COALESCE(mes.home_team, uf.home_team_raw) AS home_team,
    COALESCE(mes.away_team, uf.away_team_raw) AS away_team,
    COALESCE(mes.sport, uf.sport) AS sport,
    COALESCE(mes.country, UPPER(uf.country)) AS country,
    COALESCE(mes.competition, uf.competition) AS competition
"""
_HISTORY_DISPLAY_SUMMARIES_ONLY = """
    mes.start_time_utc AS kickoff,
    NULL AS home_team_raw,
    NULL AS away_team_raw,
    NULL AS competition_path,
    mes.home_team AS home_team,
    mes.away_team AS away_team,
    mes.sport AS sport,
    mes.country AS country,
    mes.competition AS competition
"""


def table_names(conn: sqlite3.Connection) -> frozenset:
    """Names of the tables in ``conn``'s main schema."""
    return frozenset(
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    )


def parse_timestamp(value: Any) -> Optional[datetime]:
    """Parse the ISO-8601 strings stored across the archive into aware UTC
    datetimes. Columns mix ``...Z`` and ``...+00:00`` (and a few naive
    values written as UTC), so string comparison is not reliable across
    tables. Returns None for empty or unparseable input."""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_timestamp(value: Any) -> Optional[str]:
    """Normalise a stored timestamp (or datetime) to ISO-8601 UTC for API
    responses; unparseable text is passed through unchanged."""
    if isinstance(value, datetime):
        parsed: Optional[datetime] = (
            value.replace(tzinfo=timezone.utc) if value.tzinfo is None
            else value.astimezone(timezone.utc)
        )
    else:
        parsed = parse_timestamp(value)
    if parsed is not None:
        return parsed.isoformat()
    return str(value) if value else None


def fetch_history(
    filters: StatsFilter,
    *,
    limit: Optional[int],
    offset: int = 0,
    event_id: Optional[str] = None,
) -> Tuple[int, List[Dict[str, Any]]]:
    """Live paper bets matching ``filters``, newest recommendation first.

    Uses the exact WHERE clause of :func:`aggregate`, so a history page and
    the /picks/stats panels always describe the same population. Returns
    ``(total_matching, page)``; ``limit=None`` returns every match. Each
    row is the full ``paper_bets`` row plus the display columns above.

    Dimension filters (sport/country/competition) read the archive summary
    like /picks/stats does, so a pending bet on a fixture the archive has
    not captured yet is shown with fixture names but is not matched by
    those filters.
    """
    where_clause, params = _build_where(filters)
    if event_id is not None:
        where_clause = f"{where_clause} AND pb.event_id = ?"
        params.append(event_id)

    with contextlib.closing(ml_db.connect(read_only=True)) as conn:
        tables = table_names(conn)
        if "paper_bets" not in tables:
            return 0, []
        joins = "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id"
        if "upcoming_fixtures" in tables:
            joins += " LEFT JOIN upcoming_fixtures uf ON uf.event_id = pb.event_id"
            display = _HISTORY_DISPLAY_WITH_FIXTURES
        else:
            display = _HISTORY_DISPLAY_SUMMARIES_ONLY

        total = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            WHERE {where_clause}
            """,
            params,
        ).fetchone()[0]
        rows = conn.execute(
            f"""
            SELECT pb.*, {display.strip()}
            FROM paper_bets pb
            {joins}
            WHERE {where_clause}
            ORDER BY pb.recommended_at DESC, pb.id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, -1 if limit is None else limit, offset],
        ).fetchall()
    return int(total or 0), [dict(row) for row in rows]


def pipeline_freshness(
    conn: sqlite3.Connection,
    *,
    now: datetime,
    settle_grace: timedelta = SETTLE_GRACE,
) -> Dict[str, Any]:
    """When the picks pipeline last recorded and settled, and how far
    behind settlement is. Shared by /picks/summary and /ops/status.

    ``paper_bets`` is small (tens of rows), so pending kickoffs are parsed
    in Python rather than compared as mixed-format strings in SQL. Pending
    bets whose kickoff is unknown are never counted as overdue.
    """
    out: Dict[str, Any] = {
        "last_recommended_at": None,
        "last_settled_at": None,
        "pending_bets": 0,
        "oldest_pending_recommended_at": None,
        "oldest_pending_kickoff": None,
        "overdue_pending_bets": 0,
        "oldest_overdue_kickoff": None,
    }
    tables = table_names(conn)
    if "paper_bets" not in tables:
        return out

    totals = conn.execute(
        """
        SELECT
            MAX(recommended_at),
            MAX(settled_at),
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),
            MIN(CASE WHEN status = 'pending' THEN recommended_at END)
        FROM paper_bets
        """
    ).fetchone()
    out["last_recommended_at"] = totals[0]
    out["last_settled_at"] = totals[1]
    out["pending_bets"] = int(totals[2] or 0)
    out["oldest_pending_recommended_at"] = totals[3]
    if not out["pending_bets"]:
        return out

    if "upcoming_fixtures" in tables:
        kickoff_sql = """
            SELECT COALESCE(mes.start_time_utc, uf.start_time_utc)
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            LEFT JOIN upcoming_fixtures uf ON uf.event_id = pb.event_id
            WHERE pb.status = 'pending'
        """
    else:
        kickoff_sql = """
            SELECT mes.start_time_utc
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            WHERE pb.status = 'pending'
        """
    parsed_kickoffs = (parse_timestamp(raw) for (raw,) in conn.execute(kickoff_sql))
    kickoffs = [k for k in parsed_kickoffs if k is not None]
    if kickoffs:
        out["oldest_pending_kickoff"] = min(kickoffs).isoformat()
    overdue = [k for k in kickoffs if k <= now - settle_grace]
    out["overdue_pending_bets"] = len(overdue)
    if overdue:
        out["oldest_overdue_kickoff"] = min(overdue).isoformat()
    return out
