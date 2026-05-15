"""Trainable model adapters for the backtest pipeline.

Each adapter takes (train_until, MarketSpec) and returns a ModelFn whose
training data is strictly before ``train_until`` and scoped to
``spec.scope``. Adapters train **in memory**; on-disk artifacts under
``app/ml/training/<label>/`` are never read or written.

Deviations from the original plan reference implementation:
- ``FeatureMatrix`` uses ``kickoffs`` (not ``start_time_utc``) for ISO timestamps.
- ``estimate_rates_chronological`` returns two ``TeamRateSnapshot`` rows per
  event (one per team with ``side`` in {"home","away"} and fields
  ``pre_attack``/``pre_defense``), NOT a single per-event dict. The adapter
  aggregates these into the ``{event_id: {home_attack, ...}}`` shape that
  ``make_dixon_coles_model_fn`` expects.
"""
from __future__ import annotations

from typing import Callable, Dict

import numpy as np

from app.ml.market_spec import MarketSpec
from app.ml.models import (
    ModelFn,
    get as get_analytic,
    make_dixon_coles_model_fn,
    make_logistic_model_fn,
)


def fit_logistic_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train a fresh logistic regression on events strictly before
    ``train_until``, scoped to ``spec.scope``. Returns a calibrated
    ModelFn ready to feed into run_backtest(model=...)."""
    from app.ml.training import (
        build_feature_matrix,
        chronological_split,
        isotonic_calibrate,
        train_logistic,
    )

    matrix = build_feature_matrix(sport=spec.sport, scope=spec.scope)

    # FeatureMatrix.kickoffs holds ISO timestamps (not start_time_utc).
    pre = [
        (ev, ts) for ev, ts in zip(matrix.event_ids, matrix.kickoffs)
        if ts < train_until
    ]
    if len(pre) < 100:
        # Not enough pre-cutoff data for a held-out calib slice — train
        # uncalibrated on the train portion. (chronological_split discards
        # post-cutoff rows; the empty calib slice is intentional and unused.)
        split = chronological_split(
            matrix, train_until=train_until, calib_until=train_until
        )
        raw = train_logistic(split.train)
        return make_logistic_model_fn(raw, calibrated=False)

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(
        matrix, train_until=calib_until, calib_until=train_until
    )
    raw = train_logistic(split.train)
    cal = isotonic_calibrate(raw, split.calib)
    return make_logistic_model_fn(cal, calibrated=True)


def fit_dixon_coles_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train fresh Dixon-Coles rates on events strictly before
    ``train_until``, scoped to ``spec.scope``. Temperature is fit on a
    held-out tail of the pre-cutoff events.

    Note: ``estimate_rates_chronological`` returns two ``TeamRateSnapshot``
    rows per event (one per side). We pair home+away snapshots for the same
    event_id and map them to the dict shape
    ``{event_id: {home_attack, home_defense, away_attack, away_defense}}``
    that ``make_dixon_coles_model_fn`` expects.
    """
    from app.ml.dixon_coles import (
        DCConfig,
        estimate_rates_chronological,
        fit_temperature,
        match_probabilities,
    )
    from app.ml.training import collect_events_for_dixon_coles

    cfg = DCConfig()  # no required args; all fields have defaults
    events_all = collect_events_for_dixon_coles(sport=spec.sport, scope=spec.scope)
    events_pre = [e for e in events_all if e["start_time_utc"] < train_until]

    snapshots = estimate_rates_chronological(events_pre, cfg)
    events_by_id = {e["event_id"]: e for e in events_pre}

    # Aggregate per-team snapshots into per-event rate dicts.
    # estimate_rates_chronological emits two TeamRateSnapshot rows per event:
    #   - side="home": pre_attack → home_attack, pre_defense → home_defense
    #   - side="away": pre_attack → away_attack, pre_defense → away_defense
    rates_by_event: Dict[str, dict] = {}
    for s in snapshots:
        if s.event_id not in events_by_id:
            continue
        entry = rates_by_event.setdefault(s.event_id, {})
        if s.side == "home":
            entry["home_attack"] = s.pre_attack
            entry["home_defense"] = s.pre_defense
        else:
            entry["away_attack"] = s.pre_attack
            entry["away_defense"] = s.pre_defense

    # Fit temperature on the last ~25% of pre-cutoff events.
    if len(events_pre) >= 100:
        calib_cutoff = sorted(e["start_time_utc"] for e in events_pre)[int(len(events_pre) * 0.75)]
        calib_events = [e for e in events_pre if e["start_time_utc"] >= calib_cutoff]
        raw_probs = []
        y = []
        for ev in calib_events:
            r = rates_by_event.get(ev["event_id"])
            if r is None or len(r) < 4:
                continue
            lam_h = r["home_attack"] * r["away_defense"] * cfg.home_advantage * cfg.league_mean_goals
            lam_a = r["away_attack"] * r["home_defense"] * cfg.league_mean_goals
            p_h, p_d, p_a = match_probabilities(lam_h, lam_a, cfg=cfg)
            raw_probs.append([p_h, p_d, p_a])
            if ev["home_score"] > ev["away_score"]:
                y.append(0)
            elif ev["home_score"] < ev["away_score"]:
                y.append(2)
            else:
                y.append(1)
        if raw_probs:
            T = fit_temperature(np.asarray(raw_probs), np.asarray(y))
        else:
            T = 1.0
    else:
        T = 1.0

    return make_dixon_coles_model_fn(rates_by_event, cfg, temperature=T)


def _fit_and_apply_preprocessor(train: "FeatureMatrix"):
    """Fit StandardScaler+PCA(0.95) on ``train.X``. Returns the fitted
    sklearn Pipeline and a new FeatureMatrix with the projected X and
    synthesized ``pc1..pcK`` column names. ``y``, ``event_ids``, and
    ``kickoffs`` carry over unchanged."""
    from sklearn.decomposition import PCA
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    from app.ml.training import FeatureMatrix

    prep = Pipeline([
        ("scaler", StandardScaler()),
        ("pca", PCA(n_components=0.95, svd_solver="full")),
    ])
    Xp = prep.fit_transform(train.X)
    proj_cols = tuple(f"pc{i+1}" for i in range(Xp.shape[1]))
    return prep, FeatureMatrix(
        X=Xp, y=train.y, event_ids=train.event_ids,
        kickoffs=train.kickoffs, columns=proj_cols,
    )


def _apply_preprocessor(prep, fm: "FeatureMatrix"):
    """Apply an already-fitted preprocessor to a FeatureMatrix. Returns
    a new FeatureMatrix with the projected X and synthesized column
    names. Does NOT refit."""
    from app.ml.training import FeatureMatrix

    Xp = prep.transform(fm.X)
    proj_cols = tuple(f"pc{i+1}" for i in range(Xp.shape[1]))
    return FeatureMatrix(
        X=Xp, y=fm.y, event_ids=fm.event_ids, kickoffs=fm.kickoffs,
        columns=proj_cols,
    )


TRAINABLE: Dict[str, Callable[[str, MarketSpec], ModelFn]] = {
    "logistic": fit_logistic_at,
    "dixon_coles": fit_dixon_coles_at,
}


def resolve_model_for_backtest(
    name: str,
    train_until: str,
    spec: MarketSpec,
) -> ModelFn:
    """Return a callable model function.

    - If ``name`` is in ``TRAINABLE``: train fresh in-memory using
      ``(train_until, spec)`` and return the resulting ModelFn.
    - Else fall through to the analytic registry in app.ml.models.
    - Raises KeyError for unknown names.
    """
    if name in TRAINABLE:
        return TRAINABLE[name](train_until, spec)
    return get_analytic(name)
