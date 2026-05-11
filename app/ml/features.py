"""Point-in-time feature builder.

``get_features(event_id, as_of_ts)`` returns a feature dict using **only**
data with timestamps strictly before ``as_of_ts``. This is the no-leakage
contract that Phase 2 backtesting depends on.

Phase 1 feature set (football):
  - ``home_elo`` / ``away_elo`` / ``elo_diff`` — pre-match Elo
  - ``home_form_n`` / ``away_form_n`` — PPG over the last N completed
    matches each team played strictly before ``as_of_ts``
  - ``home_days_rest`` / ``away_days_rest`` — days since previous match
  - ``home_advantage`` — constant 1 (always present here, kept for
    consistency with the eventual multi-sport feature builder)
  - ``market_prob_home`` / ``market_prob_draw`` / ``market_prob_away`` —
    closing-line devigged probabilities, **only** if
    ``as_of_ts >= odds_fetched_at`` (otherwise NULL — the future closing
    snapshot must not leak into a feature built for an earlier moment).

The feature builder does not call any HTTP — all inputs come from
``bet_labels``, ``team_elo_history``, ``odds_snapshots``, and
``closing_odds``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.ml import db as ml_db


DEFAULT_FORM_WINDOW = 5


def _parse_iso(ts: str) -> datetime:
    # SQLite stores ISO-8601 with offsets; ``datetime.fromisoformat`` handles
    # "+00:00" but not "Z". Normalize.
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@dataclass(frozen=True)
class TeamFormResult:
    points: float
    matches: int


def _team_form(
    conn,
    team: str,
    as_of_ts: str,
    window: int,
    exclude_event_id: Optional[str],
) -> TeamFormResult:
    """Return ``(points, matches_used)`` for ``team``'s last ``window``
    completed matches strictly before ``as_of_ts``. PPG = points / matches.
    The current event is excluded by ``event_id`` even if its
    ``start_time_utc`` is < ``as_of_ts``, so calling this function with
    ``as_of_ts`` after the event's kickoff doesn't leak the event's own
    result into its team's form feature."""
    rows = conn.execute(
        """
        SELECT outcome_1x2, home_team, away_team
        FROM bet_labels
        WHERE start_time_utc < ?
          AND (home_team = ? OR away_team = ?)
          AND event_id != COALESCE(?, '')
        ORDER BY start_time_utc DESC
        LIMIT ?
        """,
        (as_of_ts, team, team, exclude_event_id, window),
    ).fetchall()
    if not rows:
        return TeamFormResult(points=0.0, matches=0)
    pts = 0
    for row in rows:
        was_home = row["home_team"] == team
        outcome = row["outcome_1x2"]
        if outcome == "draw":
            pts += 1
        elif (outcome == "home" and was_home) or (outcome == "away" and not was_home):
            pts += 3
    return TeamFormResult(points=float(pts), matches=len(rows))


def _team_days_rest(
    conn,
    team: str,
    as_of_ts: str,
    exclude_event_id: Optional[str],
) -> Optional[float]:
    row = conn.execute(
        """
        SELECT start_time_utc
        FROM bet_labels
        WHERE start_time_utc < ?
          AND (home_team = ? OR away_team = ?)
          AND event_id != COALESCE(?, '')
        ORDER BY start_time_utc DESC
        LIMIT 1
        """,
        (as_of_ts, team, team, exclude_event_id),
    ).fetchone()
    if row is None:
        return None
    prev = _parse_iso(row["start_time_utc"])
    now = _parse_iso(as_of_ts)
    return (now - prev).total_seconds() / 86400.0


def _pre_match_elo(conn, event_id: str, team: str) -> Optional[float]:
    row = conn.execute(
        """
        SELECT pre_elo
        FROM team_elo_history
        WHERE event_id = ? AND team = ?
        """,
        (event_id, team),
    ).fetchone()
    return float(row["pre_elo"]) if row else None


def _market_probs(
    conn,
    event_id: str,
    as_of_ts: str,
    home_team: Optional[str],
    away_team: Optional[str],
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Return ``(home_prob, draw_prob, away_prob)`` from closing-line
    devigged probabilities averaged across bookmakers, **only** if the
    archive's odds snapshot was captured at or before ``as_of_ts``.

    Maps ``selection_key`` to home/draw/away by joining against the
    upstream payload's ``eventParticipantId``: the entry whose ID
    matches the home team's participant becomes home; the remaining
    non-DRAW selection is away; ``DRAW`` is the draw. We don't have the
    participant→team mapping stored explicitly, so we use the
    convention validated in Phase 0 / the spot-check: of the two
    non-DRAW selection_keys, the one appearing *first* in
    ``odds_snapshots.upstream_payload_json``'s 1X2 market is the home
    team's selection.
    """
    odds_row = conn.execute(
        "SELECT fetched_at, upstream_payload_json FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1",
        (event_id,),
    ).fetchone()
    if odds_row is None:
        return None, None, None
    if odds_row["fetched_at"] > as_of_ts:
        return None, None, None

    # Resolve the home-side selection_key from the upstream payload —
    # the first non-DRAW selection in any HOME_DRAW_AWAY:FULL_TIME market.
    home_sel: Optional[str] = None
    try:
        import json

        upstream = json.loads(odds_row["upstream_payload_json"]) if odds_row["upstream_payload_json"] else None
        container = (upstream or {}).get("data", {}).get("findOddsByEventId")
        if isinstance(container, dict):
            for entry in container.get("odds") or ():
                if entry.get("bettingType") == "HOME_DRAW_AWAY" and entry.get("bettingScope") == "FULL_TIME":
                    outcomes = entry.get("odds") or []
                    if len(outcomes) >= 1:
                        first = outcomes[0]
                        pid = first.get("eventParticipantId")
                        if pid:
                            home_sel = str(pid)
                    if home_sel:
                        break
    except Exception:
        home_sel = None

    rows = conn.execute(
        """
        SELECT selection_key, AVG(devigged_prob) AS prob
        FROM closing_odds
        WHERE event_id = ?
          AND market = 'HOME_DRAW_AWAY:FULL_TIME'
          AND devigged_prob IS NOT NULL
        GROUP BY selection_key
        """,
        (event_id,),
    ).fetchall()
    if not rows:
        return None, None, None

    home_prob = draw_prob = away_prob = None
    other_probs: List[float] = []
    for r in rows:
        sk = r["selection_key"]
        prob = float(r["prob"])
        if sk == "DRAW":
            draw_prob = prob
        elif home_sel and sk == home_sel:
            home_prob = prob
        else:
            other_probs.append(prob)

    if home_prob is None and len(other_probs) == 2:
        # Can't disambiguate home/away — fall back to None to avoid leaking
        # an incorrectly-labelled probability.
        return None, draw_prob, None
    if other_probs:
        away_prob = other_probs[0]
    return home_prob, draw_prob, away_prob


def get_features(
    event_id: str,
    as_of_ts: str,
    *,
    form_window: int = DEFAULT_FORM_WINDOW,
) -> Optional[Dict[str, Any]]:
    """Return point-in-time features for ``event_id`` at ``as_of_ts``, or
    ``None`` if the event isn't in ``bet_labels``."""
    ml_db.ensure_phase1_tables()
    with ml_db.connect(read_only=True) as conn:
        label = conn.execute(
            """
            SELECT event_id, sport, competition, start_time_utc,
                   home_team, away_team
            FROM bet_labels
            WHERE event_id = ?
            """,
            (event_id,),
        ).fetchone()
        if label is None:
            return None
        home = label["home_team"]
        away = label["away_team"]

        home_form = _team_form(conn, home, as_of_ts, form_window, event_id) if home else TeamFormResult(0.0, 0)
        away_form = _team_form(conn, away, as_of_ts, form_window, event_id) if away else TeamFormResult(0.0, 0)
        home_rest = _team_days_rest(conn, home, as_of_ts, event_id) if home else None
        away_rest = _team_days_rest(conn, away, as_of_ts, event_id) if away else None
        home_elo = _pre_match_elo(conn, event_id, home) if home else None
        away_elo = _pre_match_elo(conn, event_id, away) if away else None
        mp_h, mp_d, mp_a = _market_probs(conn, event_id, as_of_ts, home, away)

        home_ppg = home_form.points / home_form.matches if home_form.matches else None
        away_ppg = away_form.points / away_form.matches if away_form.matches else None
        elo_diff = (home_elo - away_elo) if (home_elo is not None and away_elo is not None) else None

        return {
            "event_id": event_id,
            "kickoff": label["start_time_utc"],
            "competition": label["competition"],
            "home_team": home,
            "away_team": away,
            "home_advantage": 1,
            "home_elo": home_elo,
            "away_elo": away_elo,
            "elo_diff": elo_diff,
            "home_form_ppg": home_ppg,
            "home_form_matches": home_form.matches,
            "away_form_ppg": away_ppg,
            "away_form_matches": away_form.matches,
            "home_days_rest": home_rest,
            "away_days_rest": away_rest,
            "market_prob_home": mp_h,
            "market_prob_draw": mp_d,
            "market_prob_away": mp_a,
        }
