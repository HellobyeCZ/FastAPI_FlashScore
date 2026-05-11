"""Project ``odds_snapshots`` into the ``closing_odds`` table.

Under the assumption validated in :mod:`scripts.spot_check_closing` — that
the single odds_snapshots row per terminal event is the closing snapshot —
each (event_id, bookmaker, market, selection_key) becomes one row with:

    - ``decimal_price``      raw price
    - ``implied_prob``       = 1 / decimal_price
    - ``devigged_prob``      market-group-aware proportional devig, NULL
                             for markets we cannot group reliably

Outcome ordering quirk (Phase 1 finding): the upstream
``HOME_DRAW_AWAY:*`` market lists outcomes as ``[home, away, draw]``,
with the draw being the entry whose upstream ``eventParticipantId`` is
None. The mapped payload preserves order but loses the participant ID
field, so we resolve the draw row by joining against
``upstream_payload_json`` when available.

Devig groups:
  - ``HOME_DRAW_AWAY:*``       3-way over all 3 outcomes
  - ``DOUBLE_CHANCE:*``        3-way over (1X, 12, X2)  -- excluded from
                               devig because outcomes overlap; implied
                               only.
  - ``DRAW_NO_BET:*``          2-way over (home, away)
  - ``HOME_AWAY:*``            2-way over (home, away)
  - ``BOTH_TEAMS_TO_SCORE:*``  2-way over (yes, no)
  - ``OVER_UNDER:*``           2-way per (line) over (over, under)
  - ``ASIAN_HANDICAP:*``       2-way per (handicap) over (home_side, away_side)
  - everything else            implied only (devig NULL)
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.ml import db as ml_db
from app.ml.labels import FOOTBALL_PHASE1_SCOPE


_TWO_WAY_NO_HANDICAP = {
    "DRAW_NO_BET",
    "HOME_AWAY",
    "BOTH_TEAMS_TO_SCORE",
}


@dataclass(frozen=True)
class ClosingOddsBackfillReport:
    events_scanned: int
    events_with_odds: int
    rows_written: int


@dataclass
class _OutcomeRow:
    bookmaker: str
    market: str
    selection_key: str
    decimal_price: float
    handicap: Optional[str]   # numeric handicap as string, or O/U line
    eventParticipantId: Optional[str]


def _extract_market_key(betting_type: Optional[str], betting_scope: Optional[str]) -> Optional[str]:
    if not betting_type or not betting_scope:
        return None
    return f"{betting_type}:{betting_scope}"


def _handicap_value(handicap_field: Any) -> Optional[str]:
    if isinstance(handicap_field, dict):
        v = handicap_field.get("value")
        return None if v in (None, "") else str(v)
    if handicap_field in (None, ""):
        return None
    return str(handicap_field)


def _selection_key(
    *,
    participant_id: Optional[str],
    handicap: Optional[str],
    position: Any,
    selection: Optional[str],
) -> Optional[str]:
    """Build a stable selection key from the upstream outcome fields.

    Precedence:
      - upstream ``selection`` (``OVER``, ``UNDER``, ``YES``, ``NO``, ``HOME``,
        ``AWAY``, ``DRAW``) — set on category-style markets;
      - ``eventParticipantId`` — set on participant markets (1X2 home/away);
      - ``position`` — fallback used by some categorical markets;
      - ``DRAW`` — a 1X2 draw row has all three above None.

    Combined with the handicap value as ``"{base}@{handicap}"`` so over/under
    and Asian-handicap lines stay disambiguated per line.
    """
    if selection not in (None, ""):
        base: Optional[str] = str(selection)
    elif participant_id not in (None, ""):
        base = str(participant_id)
    elif position not in (None, ""):
        base = str(position)
    else:
        base = "DRAW"

    if handicap not in (None, ""):
        return f"{base}@{handicap}"
    return base


def _row_from_upstream_outcome(
    *,
    bookmaker: str,
    market_key: str,
    outcome: Dict[str, Any],
) -> Optional[_OutcomeRow]:
    if outcome.get("active") is False:
        return None
    raw_price = outcome.get("value")
    if raw_price in (None, ""):
        return None
    try:
        price = float(raw_price)
    except (TypeError, ValueError):
        return None
    if price <= 1.0:
        return None
    participant_id = outcome.get("eventParticipantId")
    handicap = _handicap_value(outcome.get("handicap"))
    selection = _selection_key(
        participant_id=participant_id,
        handicap=handicap,
        position=outcome.get("position"),
        selection=outcome.get("selection"),
    )
    if selection is None:
        return None
    return _OutcomeRow(
        bookmaker=bookmaker,
        market=market_key,
        selection_key=selection,
        decimal_price=price,
        handicap=handicap,
        eventParticipantId=participant_id,
    )


def _proportional_devig(prices: Sequence[float]) -> List[float]:
    if not prices:
        return []
    inv = [1.0 / p for p in prices]
    s = sum(inv)
    if s <= 0:
        return []
    return [i / s for i in inv]


def _devig_market_group(
    market: str,
    rows: List[_OutcomeRow],
) -> Dict[str, Optional[float]]:
    """Return ``{selection_key: devigged_prob}``. Selections in markets we
    can't devig get ``None``."""
    betting_type = market.split(":", 1)[0]

    if betting_type == "HOME_DRAW_AWAY" and len(rows) == 3:
        probs = _proportional_devig([r.decimal_price for r in rows])
        return {r.selection_key: p for r, p in zip(rows, probs)}

    if betting_type in _TWO_WAY_NO_HANDICAP and len(rows) == 2:
        probs = _proportional_devig([r.decimal_price for r in rows])
        return {r.selection_key: p for r, p in zip(rows, probs)}

    if betting_type in {"OVER_UNDER", "ASIAN_HANDICAP"}:
        out: Dict[str, Optional[float]] = {}
        by_handicap: Dict[str, List[_OutcomeRow]] = {}
        for r in rows:
            key = r.handicap if r.handicap is not None else "_no_handicap"
            by_handicap.setdefault(key, []).append(r)
        for handicap, group in by_handicap.items():
            if len(group) == 2:
                probs = _proportional_devig([r.decimal_price for r in group])
                for r, p in zip(group, probs):
                    out[r.selection_key] = p
            else:
                for r in group:
                    out[r.selection_key] = None
        return out

    # Everything else (DOUBLE_CHANCE has overlapping outcomes; CORRECT_SCORE
    # has variable cardinality; HT_FT is a 9-cell joint).
    return {r.selection_key: None for r in rows}


def _iter_terminal_event_odds(
    sport: str,
    scope: Sequence[Tuple[str, str]],
) -> Iterable[Tuple[str, str]]:
    where_parts = ["m.sport = ?", "s.is_terminal = 1"]
    params: List[str] = [sport]
    if scope:
        placeholders = ",".join("(?, ?)" for _ in scope)
        where_parts.append(f"(m.country, m.competition) IN (VALUES {placeholders})")
        for country, competition in scope:
            params.extend([country, competition])
    where_clause = " AND ".join(where_parts)
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT o.event_id, o.upstream_payload_json
            FROM odds_snapshots o
            JOIN match_event_summaries m USING(event_id)
            JOIN match_stats_snapshots s USING(event_id)
            WHERE {where_clause}
            """,
            params,
        )
        seen: set[str] = set()
        for event_id, upstream_json in rows:
            if event_id in seen:
                continue
            seen.add(event_id)
            yield event_id, upstream_json


def backfill_closing_odds(
    *,
    sport: str = "football",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    rebuild: bool = False,
) -> ClosingOddsBackfillReport:
    ml_db.ensure_phase1_tables()
    events_scanned = 0
    events_with_odds = 0
    rows_to_write: List[Tuple[Any, ...]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    bookmaker_name_cache: Dict[Tuple[str, int], str] = {}

    for event_id, upstream_json in _iter_terminal_event_odds(sport, scope):
        events_scanned += 1
        try:
            upstream = json.loads(upstream_json)
        except (TypeError, json.JSONDecodeError):
            continue
        container = (upstream or {}).get("data", {}).get("findOddsByEventId")
        if not isinstance(container, dict):
            continue

        # Build bookmaker id -> name map for this event.
        settings = container.get("settings") or {}
        for bk_entry in settings.get("bookmakers") or ():
            bk_def = (bk_entry or {}).get("bookmaker") or {}
            bk_id = bk_def.get("id")
            bk_name = bk_def.get("name")
            if isinstance(bk_id, int) and isinstance(bk_name, str):
                bookmaker_name_cache[(event_id, bk_id)] = bk_name

        # Group outcomes by (bookmaker, market).
        per_group: Dict[Tuple[str, str], List[_OutcomeRow]] = {}
        for market_entry in container.get("odds") or ():
            if not isinstance(market_entry, dict):
                continue
            market = _extract_market_key(
                market_entry.get("bettingType"),
                market_entry.get("bettingScope"),
            )
            if market is None:
                continue
            bk_id = market_entry.get("bookmakerId")
            bookmaker = bookmaker_name_cache.get((event_id, bk_id)) if isinstance(bk_id, int) else None
            if not bookmaker:
                continue
            for outcome in market_entry.get("odds") or ():
                if not isinstance(outcome, dict):
                    continue
                row = _row_from_upstream_outcome(
                    bookmaker=bookmaker, market_key=market, outcome=outcome,
                )
                if row is None:
                    continue
                per_group.setdefault((bookmaker, market), []).append(row)

        if not per_group:
            continue
        events_with_odds += 1

        for (bookmaker, market), rows in per_group.items():
            devigged = _devig_market_group(market, rows)
            for r in rows:
                implied = 1.0 / r.decimal_price
                dv = devigged.get(r.selection_key)
                rows_to_write.append(
                    (
                        event_id,
                        bookmaker,
                        market,
                        r.selection_key,
                        r.decimal_price,
                        implied,
                        dv,
                        now_iso,
                    )
                )

    rows_written = _persist_closing_odds(rows_to_write, rebuild=rebuild)
    return ClosingOddsBackfillReport(
        events_scanned=events_scanned,
        events_with_odds=events_with_odds,
        rows_written=rows_written,
    )


def _persist_closing_odds(rows: List[Tuple[Any, ...]], *, rebuild: bool) -> int:
    if not rows:
        return 0
    with ml_db.connect() as conn:
        if rebuild:
            conn.execute("DELETE FROM closing_odds")
        # Insert in chunks to keep memory bounded.
        chunk = 5000
        for i in range(0, len(rows), chunk):
            conn.executemany(
                """
                INSERT INTO closing_odds (
                    event_id, bookmaker, market, selection_key,
                    decimal_price, implied_prob, devigged_prob, derived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id, bookmaker, market, selection_key) DO UPDATE SET
                    decimal_price = excluded.decimal_price,
                    implied_prob = excluded.implied_prob,
                    devigged_prob = excluded.devigged_prob,
                    derived_at = excluded.derived_at
                """,
                rows[i : i + chunk],
            )
        conn.commit()
    return len(rows)
