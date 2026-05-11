"""Chronological pre-match Elo ratings per team.

Iterates every settled match in scope in start-time order, computes the
pre-match Elo for both teams, applies the standard logistic update, and
writes ``team_elo_history`` rows. Strictly chronological — the pre_elo
recorded for a match never depends on the outcome of any match after it.

Football-specific defaults (K=20, HFA=60, start=1500) are configurable.
Skips promotion/relegation regression-to-mean — a known future
improvement.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from app.ml import db as ml_db
from app.ml.labels import FOOTBALL_PHASE1_SCOPE


@dataclass(frozen=True)
class EloConfig:
    sport: str = "football"
    k_factor: float = 20.0
    hfa: float = 60.0
    start_rating: float = 1500.0


@dataclass(frozen=True)
class EloBackfillReport:
    events_processed: int
    teams_touched: int
    rows_written: int


def _expected_home(elo_home: float, elo_away: float, hfa: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((elo_away - (elo_home + hfa)) / 400.0))


def _outcome_to_score(outcome_1x2: str) -> Tuple[float, float]:
    if outcome_1x2 == "home":
        return 1.0, 0.0
    if outcome_1x2 == "away":
        return 0.0, 1.0
    return 0.5, 0.5


def _iter_scope_events(
    config: EloConfig,
    scope: Sequence[Tuple[str, str]],
) -> List[Tuple[str, str, str, str, str, str]]:
    """Return ``(event_id, home, away, start_time_utc, competition, outcome_1x2)``
    in strict chronological order. Tie-breaks on ``event_id`` for
    determinism."""
    placeholders = ",".join("(?, ?)" for _ in scope) if scope else ""
    params: List[str] = [config.sport]
    where_extra = ""
    if scope:
        for country, competition in scope:
            params.extend([country, competition])
        where_extra = f" AND (country, competition) IN (VALUES {placeholders})"
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT event_id, home_team, away_team, start_time_utc,
                   competition, outcome_1x2
            FROM bet_labels
            WHERE sport = ?{where_extra}
              AND start_time_utc IS NOT NULL
              AND home_team IS NOT NULL
              AND away_team IS NOT NULL
            ORDER BY start_time_utc ASC, event_id ASC
            """,
            params,
        ).fetchall()
    return [tuple(r) for r in rows]


def backfill_elo(
    *,
    config: Optional[EloConfig] = None,
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    rebuild: bool = True,
) -> EloBackfillReport:
    """Recompute Elo history from scratch over the configured scope.

    ``rebuild=True`` (the default) deletes existing rows for the sport in
    scope and rewrites them — Elo can't be incrementally appended safely
    after the fact without checkpointing, so we always rebuild on demand.
    """
    cfg = config or EloConfig()
    ml_db.ensure_phase1_tables()

    events = _iter_scope_events(cfg, scope)
    ratings: Dict[str, float] = {}
    out_rows: List[Tuple[str, str, str, str, str, Optional[str], float, float, float, float]] = []

    for event_id, home, away, start_time, competition, outcome in events:
        elo_home = ratings.get(home, cfg.start_rating)
        elo_away = ratings.get(away, cfg.start_rating)
        expected_h = _expected_home(elo_home, elo_away, cfg.hfa)
        score_h, score_a = _outcome_to_score(outcome)
        post_home = elo_home + cfg.k_factor * (score_h - expected_h)
        post_away = elo_away + cfg.k_factor * (score_a - (1.0 - expected_h))
        ratings[home] = post_home
        ratings[away] = post_away

        out_rows.append(
            (event_id, home, "home", start_time, cfg.sport, competition,
             elo_home, post_home, cfg.k_factor, cfg.hfa)
        )
        out_rows.append(
            (event_id, away, "away", start_time, cfg.sport, competition,
             elo_away, post_away, cfg.k_factor, cfg.hfa)
        )

    rows_written = _persist_elo(out_rows, sport=cfg.sport, rebuild=rebuild)
    return EloBackfillReport(
        events_processed=len(events),
        teams_touched=len(ratings),
        rows_written=rows_written,
    )


def _persist_elo(
    rows: List[Tuple[str, str, str, str, str, Optional[str], float, float, float, float]],
    *,
    sport: str,
    rebuild: bool,
) -> int:
    if not rows:
        return 0
    with ml_db.connect() as conn:
        if rebuild:
            conn.execute("DELETE FROM team_elo_history WHERE sport = ?", (sport,))
        chunk = 5000
        for i in range(0, len(rows), chunk):
            conn.executemany(
                """
                INSERT INTO team_elo_history (
                    event_id, team, side, start_time_utc, sport, competition,
                    pre_elo, post_elo, k_factor, hfa
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id, team) DO UPDATE SET
                    side = excluded.side,
                    start_time_utc = excluded.start_time_utc,
                    sport = excluded.sport,
                    competition = excluded.competition,
                    pre_elo = excluded.pre_elo,
                    post_elo = excluded.post_elo,
                    k_factor = excluded.k_factor,
                    hfa = excluded.hfa
                """,
                rows[i : i + chunk],
            )
        conn.commit()
    return len(rows)
