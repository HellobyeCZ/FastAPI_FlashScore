"""Model interfaces and baseline models used by the backtester.

A ``ModelFn`` takes a feature dict (as returned by
:func:`app.ml.features.get_features`) and a market context dict that
exposes the market-implied and devigged probabilities for each
selection, and returns ``{selection: probability}`` summing to 1.

Phase 2 ships two baselines used to sanity-check the harness:

  - :func:`market_implied_baseline` — devigged market probability.
    Against archive closing odds with ``min_edge=0`` and forced bets,
    ROI should be ≈ −vig and Brier should equal the closing line's
    Brier. This is the harness's correctness anchor.
  - :func:`vig_included_baseline` — raw implied probability (vig
    included). Never reports an edge over the market and is here only
    for illustration.

Phase 3 will register real models (logistic, LightGBM, Dixon-Coles)
that consume the features dict.
"""
from __future__ import annotations

from typing import Callable, Dict, Mapping, Optional, Protocol


class ModelFn(Protocol):
    def __call__(
        self,
        features: Mapping[str, object],
        market: Mapping[str, Optional[float]],
    ) -> Dict[str, float]: ...


def market_implied_baseline(
    features: Mapping[str, object],
    market: Mapping[str, Optional[float]],
) -> Dict[str, float]:
    """Predict the devigged market probability for each selection. If the
    market features are missing, return uniform 1/3 priors so the bet
    is naturally edge-less and gets filtered out."""
    home = market.get("devigged_prob_home")
    draw = market.get("devigged_prob_draw")
    away = market.get("devigged_prob_away")
    if home is None or draw is None or away is None:
        return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
    s = float(home) + float(draw) + float(away)
    if s <= 0:
        return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
    return {
        "home": float(home) / s,
        "draw": float(draw) / s,
        "away": float(away) / s,
    }


def vig_included_baseline(
    features: Mapping[str, object],
    market: Mapping[str, Optional[float]],
) -> Dict[str, float]:
    """Predict raw 1/price implied probabilities (vig included).
    Sums to > 1 in general so we normalise — practically equivalent to
    the devigged baseline but with the per-selection ratios untouched."""
    home = market.get("implied_prob_home")
    draw = market.get("implied_prob_draw")
    away = market.get("implied_prob_away")
    if home is None or draw is None or away is None:
        return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
    s = float(home) + float(draw) + float(away)
    if s <= 0:
        return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
    return {
        "home": float(home) / s,
        "draw": float(draw) / s,
        "away": float(away) / s,
    }


_REGISTRY: Dict[str, ModelFn] = {
    "market_implied": market_implied_baseline,
    "vig_included": vig_included_baseline,
}


def register(name: str, fn: ModelFn) -> None:
    _REGISTRY[name] = fn


def get(name: str) -> ModelFn:
    if name not in _REGISTRY:
        raise KeyError(f"unknown model {name!r}. registered: {sorted(_REGISTRY)}")
    return _REGISTRY[name]


def names() -> tuple:
    return tuple(sorted(_REGISTRY))
