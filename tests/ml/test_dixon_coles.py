"""Phase 3c Dixon-Coles structural-model tests.

Verifies the standalone components (Poisson PMF, DC correction,
match_probabilities, EWMA rate estimator, temperature scaling) and the
end-to-end integration with the backtester via the fixture DB.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.ml import models as ml_models
from app.ml.backtest import run_backtest
from app.ml.closing_odds import backfill_closing_odds
from app.ml.dixon_coles import (
    DCConfig,
    apply_temperature,
    estimate_rates_chronological,
    fit_temperature,
    match_probabilities,
)
from app.ml.elo import EloConfig, backfill_elo
from app.ml.labels import backfill_labels
from app.ml.training import collect_events_for_dixon_coles


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled_full(fixture_db):
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=TEST_SCOPE, rebuild=True)
    return fixture_db


def test_match_probabilities_sum_to_one():
    p_h, p_d, p_a = match_probabilities(1.5, 1.2)
    assert 0.99 <= p_h + p_d + p_a <= 1.01
    # Higher home λ → higher home win prob.
    p_h2, _, _ = match_probabilities(2.5, 1.2)
    assert p_h2 > p_h


def test_match_probabilities_symmetric_at_equal_rates():
    p_h, p_d, p_a = match_probabilities(1.5, 1.5)
    assert abs(p_h - p_a) < 0.01  # symmetric within numerical noise


def test_dc_correction_increases_draw_probability():
    """The DC tau correction with rho < 0 increases low-score-draw mass.
    Compare match_probabilities at typical λ values with and without the
    correction (rho=0 disables it)."""
    no_corr = match_probabilities(1.3, 1.1, cfg=DCConfig(rho=0.0))
    with_corr = match_probabilities(1.3, 1.1, cfg=DCConfig(rho=-0.12))
    # The draw probability should rise with rho < 0.
    assert with_corr[1] > no_corr[1]


def test_estimate_rates_chronological_produces_two_snapshots_per_event():
    events = [
        {"event_id": "e1", "home_team": "A", "away_team": "B",
         "home_score": 2, "away_score": 1, "home_xg": 1.8, "away_xg": 1.0},
        {"event_id": "e2", "home_team": "B", "away_team": "A",
         "home_score": 1, "away_score": 1, "home_xg": 1.2, "away_xg": 1.5},
    ]
    snaps = estimate_rates_chronological(events)
    assert len(snaps) == 4
    by_event = {(s.event_id, s.side): s for s in snaps}
    # First event's snapshot should use the initial rates (no history).
    assert by_event[("e1", "home")].pre_attack == pytest.approx(1.0)
    assert by_event[("e1", "home")].matches_seen == 0
    # Second event's snapshot should be different (e1 results have updated them).
    assert by_event[("e2", "home")].pre_attack != pytest.approx(1.0)
    assert by_event[("e2", "home")].matches_seen == 1


def test_estimate_rates_handles_missing_xg():
    events = [
        {"event_id": "e1", "home_team": "A", "away_team": "B",
         "home_score": 3, "away_score": 0, "home_xg": None, "away_xg": None},
    ]
    snaps = estimate_rates_chronological(events)
    assert len(snaps) == 2


def test_fit_temperature_sharpens_under_confident_predictions():
    """If the model's predictions match outcomes monotonically (argmax
    is correct on every row), the temperature should be < 1 — i.e.
    sharpen the distribution. The optimum approaches the lower bound
    of the search range in this degenerate case."""
    probs = np.array([
        [0.4, 0.3, 0.3],
        [0.3, 0.4, 0.3],
        [0.3, 0.3, 0.4],
    ])
    y = np.array([0, 1, 2])
    T = fit_temperature(probs, y)
    assert T < 1.0


def test_fit_temperature_diffuses_over_confident_predictions():
    """If the model is too confident (one-hot but wrong every time), T
    should be > 1 to spread mass to the truth."""
    probs = np.array([
        [0.95, 0.025, 0.025],
        [0.95, 0.025, 0.025],
        [0.95, 0.025, 0.025],
    ])
    y = np.array([2, 2, 2])  # truth is always away but model says home
    T = fit_temperature(probs, y)
    assert T > 1.0


def test_apply_temperature_preserves_normalization():
    probs = np.array([[0.5, 0.3, 0.2], [0.1, 0.4, 0.5]])
    scaled = apply_temperature(probs, T=2.0)
    np.testing.assert_allclose(scaled.sum(axis=1), 1.0, atol=1e-6)
    # T > 1 makes distribution more uniform.
    assert scaled[0, 0] < 0.5


def test_collect_events_for_dixon_coles_returns_fixture_events(backfilled_full):
    events = collect_events_for_dixon_coles(sport="football", scope=TEST_SCOPE)
    # 8 fixture events should be returned with scores.
    assert len(events) == 8
    for ev in events:
        assert "home_score" in ev and "away_score" in ev
        assert ev["home_score"] is not None


def test_dixon_coles_model_fn_integrates_with_backtester(backfilled_full):
    events = collect_events_for_dixon_coles(sport="football", scope=TEST_SCOPE)
    snaps = estimate_rates_chronological(events)
    # Build the rates-by-event mapping the model fn expects.
    from collections import defaultdict
    sides_by_event = defaultdict(dict)
    for s in snaps:
        sides_by_event[s.event_id][s.side] = s
    rates_by_event = {
        eid: {
            "home_attack": sides["home"].pre_attack,
            "home_defense": sides["home"].pre_defense,
            "away_attack": sides["away"].pre_attack,
            "away_defense": sides["away"].pre_defense,
        }
        for eid, sides in sides_by_event.items()
        if "home" in sides and "away" in sides
    }
    cfg = DCConfig()
    ml_models.register("test_dc",
                       ml_models.make_dixon_coles_model_fn(rates_by_event, cfg))
    report = run_backtest(
        model="test_dc",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    assert report.total_bets == 8 * 3
    assert 0.0 <= report.brier <= 1.0
    assert report.mean_clv == 0.0
