"""Sport-specific parsers for label derivation.

Each parser takes the ``event`` dict from ``match_stats_payload_json`` and
returns a :class:`MatchLabels` row. Adding a new sport = adding a new
``register`` call here, no callers change.

Football is implemented now. Hockey / basketball / american football are
stubbed with NotImplementedError so adding them is a contained task.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional


@dataclass(frozen=True)
class MatchLabels:
    event_id: str
    sport: str
    country: Optional[str]
    competition: Optional[str]
    start_time_utc: Optional[str]
    home_team: Optional[str]
    away_team: Optional[str]
    home_score: int
    away_score: int
    outcome_1x2: str  # "home", "draw", "away"
    total_goals: int
    over_2_5: bool
    btts: bool
    home_goals_first_half: Optional[int]
    away_goals_first_half: Optional[int]


class LabelDerivationError(Exception):
    """Raised when a stats payload is malformed or non-terminal."""


def _find_score(event: Dict[str, Any], period_name: str, label_keyword: str) -> Optional[tuple[int, int]]:
    for period in event.get("periods") or ():
        if (period.get("name") or "").strip().lower() != period_name.lower():
            continue
        for category in period.get("categories") or ():
            if (category.get("name") or "").strip().lower() != "score":
                continue
            for stat in category.get("stats") or ():
                if label_keyword.lower() in (stat.get("label") or "").lower():
                    try:
                        return int(stat["home"]), int(stat["away"])
                    except (KeyError, TypeError, ValueError):
                        return None
    return None


def _football_labels(event: Dict[str, Any]) -> MatchLabels:
    final = _find_score(event, "Match", "Final score")
    if final is None:
        raise LabelDerivationError("missing Final score")
    home_score, away_score = final
    first_half = _find_score(event, "1st Half", "Period score")

    outcome_1x2 = "draw"
    if home_score > away_score:
        outcome_1x2 = "home"
    elif home_score < away_score:
        outcome_1x2 = "away"

    total = home_score + away_score
    return MatchLabels(
        event_id=event["event_id"],
        sport="football",
        country=event.get("country"),
        competition=event.get("competition"),
        start_time_utc=event.get("start_time_utc"),
        home_team=event.get("home_team"),
        away_team=event.get("away_team"),
        home_score=home_score,
        away_score=away_score,
        outcome_1x2=outcome_1x2,
        total_goals=total,
        over_2_5=total > 2.5,
        btts=(home_score > 0 and away_score > 0),
        home_goals_first_half=first_half[0] if first_half else None,
        away_goals_first_half=first_half[1] if first_half else None,
    )


_PARSERS: Dict[str, Callable[[Dict[str, Any]], MatchLabels]] = {}


def register(sport: str, parser: Callable[[Dict[str, Any]], MatchLabels]) -> None:
    _PARSERS[sport.lower()] = parser


def derive_labels(event: Dict[str, Any]) -> MatchLabels:
    sport = (event.get("sport") or "").strip().lower()
    if not sport:
        raise LabelDerivationError("payload has no sport")
    parser = _PARSERS.get(sport)
    if parser is None:
        raise LabelDerivationError(f"no parser registered for sport={sport!r}")
    if (event.get("status") or "").strip().lower() != "finished":
        raise LabelDerivationError("event is not finished")
    return parser(event)


register("football", _football_labels)
