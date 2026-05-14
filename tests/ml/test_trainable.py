"""Trainable adapters resolve to callable model functions.

We don't assert numeric stability — fragile across data refreshes — only
shape and the routing logic.
"""
from __future__ import annotations

import pytest

from app.ml.market_spec import FOOTBALL_1X2_FT
from app.ml.trainable import TRAINABLE, resolve_model_for_backtest


def test_trainable_dict_contains_expected_models():
    assert "logistic" in TRAINABLE
    assert "dixon_coles" in TRAINABLE
    assert all(callable(v) for v in TRAINABLE.values())


def test_resolve_routes_analytic_to_models_registry():
    """market_implied is in the analytic _REGISTRY, not TRAINABLE."""
    fn = resolve_model_for_backtest(
        "market_implied",
        train_until="2024-08-01T00:00:00Z",
        spec=FOOTBALL_1X2_FT,
    )
    assert callable(fn)


def test_resolve_routes_trainable_to_fit_fn(monkeypatch):
    """Trainable name should call the fit fn with (train_until, spec)."""
    captured = {}

    def fake_fit(train_until: str, spec):
        captured["train_until"] = train_until
        captured["spec_key"] = spec.key
        def _model_fn(features, market_ctx):
            return {"home": 0.5, "draw": 0.25, "away": 0.25}
        return _model_fn

    monkeypatch.setitem(TRAINABLE, "logistic", fake_fit)

    fn = resolve_model_for_backtest(
        "logistic",
        train_until="2024-08-01T00:00:00Z",
        spec=FOOTBALL_1X2_FT,
    )
    assert callable(fn)
    assert captured == {
        "train_until": "2024-08-01T00:00:00Z",
        "spec_key": "football_1x2_ft",
    }


def test_resolve_unknown_raises_keyerror():
    with pytest.raises(KeyError):
        resolve_model_for_backtest(
            "does_not_exist",
            train_until="2024-08-01T00:00:00Z",
            spec=FOOTBALL_1X2_FT,
        )
