"""Phase 3b HGB training tests.

Hermetic — same fixture DB as the logistic tests, plus the
market_prob_* columns now feeding the model. We don't assert that the
model is *good* on 8 synthetic events; the bar is well-formed outputs
and an end-to-end pipeline that the backtester accepts.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.ml import models as ml_models
from app.ml.backtest import run_backtest
from app.ml.closing_odds import backfill_closing_odds
from app.ml.elo import EloConfig, backfill_elo
from app.ml.labels import backfill_labels
from app.ml.training import (
    HGB_FEATURE_COLUMNS,
    MARKET_FEATURE_COLUMNS,
    build_feature_matrix,
    isotonic_calibrate,
    train_hgb,
)


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled_full(fixture_db):
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=TEST_SCOPE, rebuild=True)
    return fixture_db


def test_market_features_present_in_matrix(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE, columns=HGB_FEATURE_COLUMNS)
    assert matrix.X.shape[1] == len(HGB_FEATURE_COLUMNS)
    # The last three columns must be the market_prob_* features and they
    # must be populated (devigged probs sum to ~1 per row).
    market_block = matrix.X[:, -3:]
    np.testing.assert_allclose(market_block.sum(axis=1), 1.0, atol=0.02)


def test_hgb_predictions_sum_to_one(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE, columns=HGB_FEATURE_COLUMNS)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events for a 3-class model")
    model = train_hgb(matrix, max_iter=20)
    probs = model.predict_proba(matrix.X)
    np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-6)
    assert (probs >= 0).all() and (probs <= 1).all()


def test_hgb_isotonic_calibrate_roundtrip(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE, columns=HGB_FEATURE_COLUMNS)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events for a 3-class model")
    model = train_hgb(matrix, max_iter=20)
    cal_model = isotonic_calibrate(model, matrix)
    probs = cal_model.predict_proba_calibrated(matrix.X)
    np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-6)


def test_hgb_model_fn_integrates_with_backtester(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE, columns=HGB_FEATURE_COLUMNS)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events for a 3-class model")
    model = train_hgb(matrix, max_iter=20)
    cal_model = isotonic_calibrate(model, matrix)
    ml_models.register("test_hgb_cal",
                       ml_models.make_trained_model_fn(cal_model, calibrated=True, name_prefix="hgb"))

    report = run_backtest(
        model="test_hgb_cal",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    assert report.total_bets == 8 * 3
    assert 0.0 <= report.brier <= 1.0
    assert report.mean_clv == 0.0


def test_hgb_save_and_load_roundtrip(backfilled_full, tmp_path):
    matrix = build_feature_matrix(scope=TEST_SCOPE, columns=HGB_FEATURE_COLUMNS)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events for a 3-class model")
    model = train_hgb(matrix, max_iter=20)
    cal_model = isotonic_calibrate(model, matrix)
    from app.ml.training import TrainedHGB
    path = tmp_path / "hgb.pkl"
    cal_model.save(str(path))
    loaded = TrainedHGB.load(str(path))
    np.testing.assert_allclose(
        cal_model.predict_proba_calibrated(matrix.X),
        loaded.predict_proba_calibrated(matrix.X),
    )
