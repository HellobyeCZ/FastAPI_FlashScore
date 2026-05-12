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


# ---------------------------------------------------------------------------
# Logistic-model adapter (Phase 3a)
# ---------------------------------------------------------------------------

def make_trained_model_fn(trained, *, calibrated: bool, name_prefix: str = "trained") -> ModelFn:
    """Wrap any object exposing ``feature_columns``, ``predict_proba``,
    and ``predict_proba_calibrated`` as a backtester ``ModelFn``.

    Reads the feature columns the trained model expects (in order) from
    the feature dict + market context. Market columns (``market_prob_*``)
    are pulled from the market context dict; everything else from the
    feature dict. Any missing column falls back to a uniform 1/3 prior so
    the bet is naturally edge-less and skipped.
    """
    import numpy as _np

    feature_columns = tuple(getattr(trained, "feature_columns"))

    def _fn(features, market) -> Dict[str, float]:
        row = []
        for col in feature_columns:
            if col.startswith("market_prob_"):
                v = market.get(f"devigged_prob_{col.removeprefix('market_prob_')}")
            else:
                v = features.get(col)
            if v is None:
                return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
            try:
                row.append(float(v))
            except (TypeError, ValueError):
                return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
        X = _np.asarray([row], dtype=float)
        probs = (
            trained.predict_proba_calibrated(X)[0]
            if calibrated else trained.predict_proba(X)[0]
        )
        return {"home": float(probs[0]), "draw": float(probs[1]), "away": float(probs[2])}

    _fn.__name__ = f"{name_prefix}_{'calibrated' if calibrated else 'uncalibrated'}"
    return _fn


# Back-compat alias: existing callers (train_logistic, tests) call
# make_logistic_model_fn(). It now delegates to the generic helper.
def make_logistic_model_fn(trained, *, calibrated: bool) -> ModelFn:
    return make_trained_model_fn(trained, calibrated=calibrated, name_prefix="logistic")


# ---------------------------------------------------------------------------
# Dixon-Coles model adapter (Phase 3c)
# ---------------------------------------------------------------------------

def make_dixon_coles_model_fn(
    rates_by_event,
    cfg,
    *,
    temperature: float = 1.0,
) -> ModelFn:
    """Build a backtester ``ModelFn`` from a snapshot of pre-match rates.

    ``rates_by_event``: ``{event_id: {"home_attack", "home_defense",
    "away_attack", "away_defense"}}``. Built by the trainer from
    ``estimate_rates_chronological`` output and passed in directly so
    the backtester reads from memory rather than re-querying.
    """
    import numpy as _np
    from app.ml.dixon_coles import apply_temperature, match_probabilities

    def _fn(features, market) -> Dict[str, float]:
        event_id = features.get("event_id")
        if event_id is None:
            return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
        rates = rates_by_event.get(event_id)
        if rates is None:
            return {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}
        lam_home = (
            rates["home_attack"] * rates["away_defense"]
            * cfg.home_advantage * cfg.league_mean_goals
        )
        lam_away = (
            rates["away_attack"] * rates["home_defense"]
            * cfg.league_mean_goals
        )
        p_home, p_draw, p_away = match_probabilities(lam_home, lam_away, cfg=cfg)
        if temperature != 1.0:
            arr = _np.asarray([[p_home, p_draw, p_away]])
            arr = apply_temperature(arr, temperature)
            p_home, p_draw, p_away = float(arr[0, 0]), float(arr[0, 1]), float(arr[0, 2])
        return {"home": p_home, "draw": p_draw, "away": p_away}

    suffix = "calibrated" if temperature != 1.0 else "uncalibrated"
    _fn.__name__ = f"dixon_coles_{suffix}"
    return _fn
