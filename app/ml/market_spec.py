"""MarketSpec — the minimal seam for sport/market generalization.

Stage 1 ships exactly one instance (FOOTBALL_1X2_FT). The dataclass +
REGISTRY + label_fn pattern is the surface future markets/sports plug
into without code refactor.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Tuple

from app.ml.labels import FOOTBALL_PHASE1_SCOPE


def _label_1x2_ft(event_summary: Mapping[str, Any]) -> Dict[str, float]:
    """Map a bet_labels-shaped row to one-hot results over (home, draw, away).

    Expects ``event_summary["outcome_1x2"]`` to be one of {"home", "draw", "away"}.
    Returns {selection: 1.0 if winner else 0.0}.
    """
    outcome = event_summary["outcome_1x2"]
    return {
        "home": 1.0 if outcome == "home" else 0.0,
        "draw": 1.0 if outcome == "draw" else 0.0,
        "away": 1.0 if outcome == "away" else 0.0,
    }


@dataclass(frozen=True)
class MarketSpec:
    key: str                                       # globally unique, e.g. "football_1x2_ft"
    sport: str                                     # "football"
    market: str                                    # "1x2_ft"
    selections: Tuple[str, ...]                    # ("home", "draw", "away")
    scope: Tuple[Tuple[str, str], ...]             # ((country, competition), ...)
    label_fn: Callable[[Mapping[str, Any]], Dict[str, float]]
    feature_window_unit: str                       # "matches" | "days"


FOOTBALL_1X2_FT = MarketSpec(
    key="football_1x2_ft",
    sport="football",
    market="1x2_ft",
    selections=("home", "draw", "away"),
    scope=tuple(FOOTBALL_PHASE1_SCOPE),
    label_fn=_label_1x2_ft,
    feature_window_unit="matches",
)


REGISTRY: Dict[str, MarketSpec] = {FOOTBALL_1X2_FT.key: FOOTBALL_1X2_FT}


def get_spec(key: str) -> MarketSpec:
    if key not in REGISTRY:
        raise KeyError(
            f"unknown market_spec {key!r}; known: {sorted(REGISTRY)}"
        )
    return REGISTRY[key]
