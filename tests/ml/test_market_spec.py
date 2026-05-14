import pytest

from app.ml.market_spec import (
    FOOTBALL_1X2_FT,
    MarketSpec,
    REGISTRY,
    get_spec,
)


def test_football_1x2_ft_has_expected_shape():
    spec = FOOTBALL_1X2_FT
    assert spec.key == "football_1x2_ft"
    assert spec.sport == "football"
    assert spec.market == "1x2_ft"
    assert spec.selections == ("home", "draw", "away")
    assert spec.feature_window_unit == "matches"
    assert len(spec.scope) > 0
    assert callable(spec.label_fn)


def test_registry_contains_football_1x2_ft():
    assert "football_1x2_ft" in REGISTRY
    assert REGISTRY["football_1x2_ft"] is FOOTBALL_1X2_FT


def test_get_spec_returns_registered():
    assert get_spec("football_1x2_ft") is FOOTBALL_1X2_FT


def test_get_spec_unknown_raises():
    with pytest.raises(KeyError, match="unknown market_spec"):
        get_spec("does_not_exist")


def test_label_fn_returns_one_hot_over_selections():
    spec = FOOTBALL_1X2_FT
    out = spec.label_fn({"outcome_1x2": "home"})
    assert out == {"home": 1.0, "draw": 0.0, "away": 0.0}
    out = spec.label_fn({"outcome_1x2": "draw"})
    assert out == {"home": 0.0, "draw": 1.0, "away": 0.0}
    out = spec.label_fn({"outcome_1x2": "away"})
    assert out == {"home": 0.0, "draw": 0.0, "away": 1.0}


def test_market_spec_is_frozen():
    with pytest.raises(Exception):
        FOOTBALL_1X2_FT.key = "x"  # type: ignore[misc]
