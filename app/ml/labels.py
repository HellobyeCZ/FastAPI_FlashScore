"""Label store backfill.

Streams every terminal ``match_stats_snapshots`` row matching the configured
scope, runs it through :func:`app.ml.sports.derive_labels`, and upserts into
``bet_labels``. Idempotent: re-runs upsert the same primary key.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Iterator, List, Optional, Sequence, Tuple

from app.ml import db as ml_db
from app.ml.sports import LabelDerivationError, MatchLabels, derive_labels


# Phase 1 scope: football, top European leagues + Czech first-tier.
# Tuple of (country, competition) pairs as they appear in match_event_summaries.
FOOTBALL_PHASE1_SCOPE: Tuple[Tuple[str, str], ...] = (
    ("ENGLAND", "Premier League"),
    ("ENGLAND", "Championship"),
    ("ENGLAND", "Championship - Play Offs"),
    ("GERMANY", "Bundesliga"),
    ("SPAIN", "LaLiga"),
    ("SPAIN", "Primera Division"),
    ("FRANCE", "Ligue 1"),
    ("CZECH REPUBLIC", "FORTUNA:LIGA"),
    ("CZECH REPUBLIC", "Chance Liga"),
    ("CZECH REPUBLIC", "Chance Liga - Relegation Group"),
    ("CZECH REPUBLIC", "Chance Liga - Championship Group"),
)


@dataclass(frozen=True)
class LabelBackfillReport:
    scanned: int
    derived: int
    skipped_non_terminal: int
    skipped_unparseable: int
    upserted: int


def _scope_filter_sql(scope: Sequence[Tuple[str, str]]) -> Tuple[str, List[str]]:
    if not scope:
        return "1=1", []
    placeholders = ",".join("(?, ?)" for _ in scope)
    params: List[str] = []
    for country, competition in scope:
        params.extend([country, competition])
    return f"(m.country, m.competition) IN (VALUES {placeholders})", params


def _iter_terminal_events(
    sport: str,
    scope: Sequence[Tuple[str, str]],
) -> Iterator[Tuple[str, str]]:
    """Yield ``(event_id, match_stats_payload_json)`` for every terminal event
    in the configured scope. Order is irrelevant for label derivation."""
    where_clause, params = _scope_filter_sql(scope)
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT s.event_id, s.match_stats_payload_json
            FROM match_stats_snapshots s
            JOIN match_event_summaries m USING(event_id)
            WHERE s.is_terminal = 1
              AND m.sport = ?
              AND {where_clause}
            """,
            (sport, *params),
        )
        for event_id, payload_json in rows:
            yield event_id, payload_json


def backfill_labels(
    *,
    sport: str = "football",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    rebuild: bool = False,
) -> LabelBackfillReport:
    ml_db.ensure_phase1_tables()
    scanned = 0
    skipped_unparseable = 0
    skipped_non_terminal = 0
    derived: List[MatchLabels] = []

    for event_id, payload_json in _iter_terminal_events(sport, scope):
        scanned += 1
        try:
            payload = json.loads(payload_json)
        except (TypeError, json.JSONDecodeError):
            skipped_unparseable += 1
            continue
        event = payload.get("event") if isinstance(payload, dict) else None
        if not isinstance(event, dict):
            skipped_unparseable += 1
            continue
        try:
            label = derive_labels(event)
        except LabelDerivationError as exc:
            if "not finished" in str(exc):
                skipped_non_terminal += 1
            else:
                skipped_unparseable += 1
            continue
        derived.append(label)

    upserted = _persist_labels(derived, rebuild=rebuild)
    return LabelBackfillReport(
        scanned=scanned,
        derived=len(derived),
        skipped_non_terminal=skipped_non_terminal,
        skipped_unparseable=skipped_unparseable,
        upserted=upserted,
    )


def _persist_labels(labels: Iterable[MatchLabels], *, rebuild: bool) -> int:
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = [
        (
            lbl.event_id,
            lbl.sport,
            lbl.country,
            lbl.competition,
            lbl.start_time_utc,
            lbl.home_team,
            lbl.away_team,
            lbl.home_score,
            lbl.away_score,
            lbl.outcome_1x2,
            lbl.total_goals,
            1 if lbl.over_2_5 else 0,
            1 if lbl.btts else 0,
            lbl.home_goals_first_half,
            lbl.away_goals_first_half,
            now_iso,
        )
        for lbl in labels
    ]
    if not rows:
        return 0
    with ml_db.connect() as conn:
        if rebuild:
            conn.execute("DELETE FROM bet_labels")
        conn.executemany(
            """
            INSERT INTO bet_labels (
                event_id, sport, country, competition, start_time_utc,
                home_team, away_team, home_score, away_score, outcome_1x2,
                total_goals, over_2_5, btts,
                home_goals_first_half, away_goals_first_half, derived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
                sport = excluded.sport,
                country = excluded.country,
                competition = excluded.competition,
                start_time_utc = excluded.start_time_utc,
                home_team = excluded.home_team,
                away_team = excluded.away_team,
                home_score = excluded.home_score,
                away_score = excluded.away_score,
                outcome_1x2 = excluded.outcome_1x2,
                total_goals = excluded.total_goals,
                over_2_5 = excluded.over_2_5,
                btts = excluded.btts,
                home_goals_first_half = excluded.home_goals_first_half,
                away_goals_first_half = excluded.away_goals_first_half,
                derived_at = excluded.derived_at
            """,
            rows,
        )
        conn.commit()
    return len(rows)
