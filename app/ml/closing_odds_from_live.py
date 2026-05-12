"""Build closing_odds rows from live_odds_snapshots.

The legacy builder in :mod:`app.ml.closing_odds` reads the rich upstream
JSON payload from ``odds_snapshots`` — which only exists when the
archive scraper has visited the event after kickoff. Live-pipeline
events (recorded via ``record_picks`` from ``live_odds_snapshots``)
never get an ``odds_snapshots`` row, so the legacy builder doesn't see
them and the settler skips them as "no closing".

This module fills that gap. For every event that has live odds but
no ``closing_odds`` row, we pick the live snapshot closest to
(kickoff − 5 min) per (event, bookmaker, market, selection_key) and
write it as a closing-line row. The 5-minute buffer matches the
Pinnacle convention used throughout the rest of the Phase 1 stack.

Devigging reuses :func:`app.ml.closing_odds._devig_market_group` so
group-level math stays identical to the legacy path.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Sequence, Tuple

from app.ml import db as ml_db
from app.ml.closing_odds import _OutcomeRow, _devig_market_group


_CLOSING_BUFFER = timedelta(minutes=5)


@dataclass(frozen=True)
class LiveClosingOddsReport:
    events_scanned: int
    events_with_rows: int
    rows_written: int
    rows_skipped_existing: int


def _parse_handicap_from_selection_key(selection_key: str) -> Optional[str]:
    """Live ``selection_key`` for handicap markets is ``"{base}@{handicap}"``.
    Extract the handicap suffix; return ``None`` if no ``@`` present."""
    if "@" not in selection_key:
        return None
    return selection_key.split("@", 1)[1]


def _iter_candidate_events(
    sport: str,
) -> List[Tuple[str, str]]:
    """Yield ``(event_id, start_time_utc)`` for events that:

    - have a row in ``upcoming_fixtures`` for the configured sport;
    - have at least one ``live_odds_snapshots`` row;
    - have NO existing ``closing_odds`` rows yet (so the legacy builder
      hasn't already covered them via ``odds_snapshots``).

    No competition-scope filter here — closing_odds rows for
    out-of-scope events are harmless (the settler is label-gated,
    and labels ARE scope-filtered), so we cast wide and let the
    downstream filter do its job. This also avoids the case-folding
    headache between ``upcoming_fixtures.country`` (lowercase) and
    ``match_event_summaries.country`` (uppercase).
    """
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT uf.event_id, uf.start_time_utc
            FROM upcoming_fixtures uf
            WHERE uf.sport = ?
              AND EXISTS (
                  SELECT 1 FROM live_odds_snapshots lo
                  WHERE lo.event_id = uf.event_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM closing_odds co
                  WHERE co.event_id = uf.event_id
              )
            ORDER BY uf.start_time_utc
            """,
            (sport,),
        ).fetchall()
    return [(r["event_id"], r["start_time_utc"]) for r in rows]


def _select_closing_rows_for_event(
    conn: sqlite3.Connection,
    event_id: str,
    closing_cutoff_iso: str,
) -> Dict[Tuple[str, str], _OutcomeRow]:
    """For one event, return ``{(bookmaker, market, selection_key):
    _OutcomeRow}`` where each value is the live row with the latest
    ``fetched_at`` not exceeding ``closing_cutoff_iso``.

    SQLite's ``ROW_NUMBER`` partition gives us "latest per group" in a
    single scan.
    """
    rows = conn.execute(
        """
        WITH ranked AS (
            SELECT
                bookmaker,
                market,
                selection_key,
                decimal_price,
                fetched_at,
                ROW_NUMBER() OVER (
                    PARTITION BY bookmaker, market, selection_key
                    ORDER BY fetched_at DESC
                ) AS rn
            FROM live_odds_snapshots
            WHERE event_id = ?
              AND fetched_at <= ?
              AND decimal_price IS NOT NULL
              AND decimal_price > 1.0
        )
        SELECT bookmaker, market, selection_key, decimal_price
        FROM ranked
        WHERE rn = 1
        """,
        (event_id, closing_cutoff_iso),
    ).fetchall()

    out: Dict[Tuple[str, str], _OutcomeRow] = {}
    for row in rows:
        bookmaker = row["bookmaker"]
        market = row["market"]
        if not bookmaker or not market:
            continue
        out[(bookmaker, market, row["selection_key"])] = _OutcomeRow(
            bookmaker=bookmaker,
            market=market,
            selection_key=row["selection_key"],
            decimal_price=float(row["decimal_price"]),
            handicap=_parse_handicap_from_selection_key(row["selection_key"]),
            eventParticipantId=None,
        )
    return out


def backfill_closing_from_live(
    *,
    sport: str = "football",
) -> LiveClosingOddsReport:
    """Populate ``closing_odds`` for events that have live odds but no
    archive ``odds_snapshots``. Idempotent: skips events that already
    have any ``closing_odds`` row (avoids overwriting the canonical
    archive-derived rows).
    """
    ml_db.ensure_phase1_tables()

    now_iso = datetime.now(timezone.utc).isoformat()
    events_scanned = 0
    events_with_rows = 0
    rows_to_write: List[Tuple] = []

    for event_id, start_time_utc in _iter_candidate_events(sport):
        events_scanned += 1
        try:
            kickoff = datetime.fromisoformat(start_time_utc)
            if kickoff.tzinfo is None:
                kickoff = kickoff.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        cutoff = (kickoff - _CLOSING_BUFFER).astimezone(timezone.utc).isoformat()

        with ml_db.connect(read_only=True) as conn:
            selected = _select_closing_rows_for_event(conn, event_id, cutoff)

        if not selected:
            continue

        # Group by (bookmaker, market) to compute devigged probs across
        # outcomes within each bookmaker's market.
        per_group: Dict[Tuple[str, str], List[_OutcomeRow]] = {}
        for (bookmaker, market, _), outcome_row in selected.items():
            per_group.setdefault((bookmaker, market), []).append(outcome_row)

        had_any = False
        for (bookmaker, market), group_rows in per_group.items():
            devigged = _devig_market_group(market, group_rows)
            for r in group_rows:
                implied = 1.0 / r.decimal_price
                rows_to_write.append(
                    (
                        event_id,
                        bookmaker,
                        market,
                        r.selection_key,
                        r.decimal_price,
                        implied,
                        devigged.get(r.selection_key),
                        now_iso,
                    )
                )
                had_any = True
        if had_any:
            events_with_rows += 1

    rows_written, rows_skipped = _persist(rows_to_write)
    return LiveClosingOddsReport(
        events_scanned=events_scanned,
        events_with_rows=events_with_rows,
        rows_written=rows_written,
        rows_skipped_existing=rows_skipped,
    )


def _persist(rows: Sequence[Tuple]) -> Tuple[int, int]:
    if not rows:
        return 0, 0
    written = 0
    skipped = 0
    with ml_db.connect() as conn:
        # Insert one row at a time using INSERT OR IGNORE so we don't
        # clobber any closing_odds rows the legacy builder might have
        # written in a race. The unique constraint is
        # (event_id, bookmaker, market, selection_key).
        for row in rows:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO closing_odds (
                    event_id, bookmaker, market, selection_key,
                    decimal_price, implied_prob, devigged_prob, derived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )
            if cur.rowcount > 0:
                written += 1
            else:
                skipped += 1
        conn.commit()
    return written, skipped
