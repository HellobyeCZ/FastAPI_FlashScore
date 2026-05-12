"""Phase 3a logistic-model training tests.

Hermetic — runs against the fixture DB only. We don't try to assert
that the model is *good* on 5 synthetic events; the bar is that the
training pipeline produces well-formed outputs (probs sum to 1, no NaN,
calibrator clips to [0, 1]) and the backtester accepts it.
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
    LOGISTIC_FEATURE_COLUMNS,
    build_feature_matrix,
    chronological_split,
    isotonic_calibrate,
    train_logistic,
)


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled_full(fixture_db):
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=TEST_SCOPE, rebuild=True)
    return fixture_db


def test_build_feature_matrix_returns_aligned_arrays(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    assert len(matrix.event_ids) == len(matrix.kickoffs)
    assert matrix.X.shape == (len(matrix.event_ids), len(LOGISTIC_FEATURE_COLUMNS))
    assert matrix.y.shape == (len(matrix.event_ids),)
    # Labels are 0/1/2.
    assert set(matrix.y.tolist()).issubset({0, 1, 2})


def test_chronological_split_partitions_disjointly(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    split = chronological_split(
        matrix,
        train_until="2024-01-15T00:00:00Z",
        calib_until="2024-01-25T00:00:00Z",
    )
    all_ids = set(split.train.event_ids) | set(split.calib.event_ids) | set(split.test.event_ids)
    assert all_ids == set(matrix.event_ids)
    # Disjoint:
    assert not (set(split.train.event_ids) & set(split.calib.event_ids))
    assert not (set(split.train.event_ids) & set(split.test.event_ids))
    assert not (set(split.calib.event_ids) & set(split.test.event_ids))


def test_logistic_predictions_sum_to_one(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    # All 5 events go to train so we have something to fit; predict back on
    # the same matrix just to check the API.
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events to fit a 3-class model")
    model = train_logistic(matrix)
    probs = model.predict_proba(matrix.X)
    np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-6)
    assert (probs >= 0).all() and (probs <= 1).all()


def test_calibrated_predictions_sum_to_one(backfilled_full):
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events to fit a 3-class model")
    model = train_logistic(matrix)
    cal_model = isotonic_calibrate(model, matrix)
    probs = cal_model.predict_proba_calibrated(matrix.X)
    np.testing.assert_allclose(probs.sum(axis=1), 1.0, atol=1e-6)
    assert (probs >= 0).all() and (probs <= 1).all()


def test_logistic_model_fn_integrates_with_backtester(backfilled_full):
    """End-to-end: train a logistic, register as ModelFn, run a forced
    backtest. The backtester accepts logistic predictions and produces
    well-formed bet records."""
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events to fit a 3-class model")
    model = train_logistic(matrix)
    cal_model = isotonic_calibrate(model, matrix)
    ml_models.register("test_logistic_cal", ml_models.make_logistic_model_fn(cal_model, calibrated=True))

    report = run_backtest(
        model="test_logistic_cal",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    # 8 fixture events × 3 selections = 24 forced bets.
    assert report.total_bets == 24
    assert 0.0 <= report.brier <= 1.0
    # CLV slot present and zero for archive bets.
    assert report.mean_clv == 0.0


def test_logistic_save_and_load_roundtrip(backfilled_full, tmp_path):
    matrix = build_feature_matrix(scope=TEST_SCOPE)
    if len(matrix.event_ids) < 3:
        pytest.skip("need >= 3 events to fit a 3-class model")
    model = train_logistic(matrix)
    cal_model = isotonic_calibrate(model, matrix)
    path = tmp_path / "model.pkl"
    cal_model.save(str(path))
    from app.ml.training import TrainedLogistic
    loaded = TrainedLogistic.load(str(path))
    np.testing.assert_allclose(
        cal_model.predict_proba_calibrated(matrix.X),
        loaded.predict_proba_calibrated(matrix.X),
    )
