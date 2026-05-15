"""Tests for fit_hgb_at and fit_hgb_pca_at adapters."""
from __future__ import annotations

import numpy as np
import pytest

from app.ml.training import TrainedHGB


def test_trained_hgb_preprocessor_defaults_to_none():
    """Existing pickled artifacts (no preprocessor field) must keep loading."""
    th = TrainedHGB(model=object())
    assert th.preprocessor is None


def test_trained_hgb_predict_proba_skips_preprocessor_when_none():
    """When preprocessor is None, predict_proba calls self.model directly."""
    class FakeModel:
        def predict_proba(self, X):
            return np.array([[0.5, 0.3, 0.2]] * len(X))

    th = TrainedHGB(model=FakeModel())
    out = th.predict_proba(np.zeros((1, 12)))
    assert out.shape == (1, 3)
    assert pytest.approx(out[0].sum()) == 1.0


def test_trained_hgb_predict_proba_applies_preprocessor_when_set():
    """When preprocessor is set, predict_proba transforms first."""
    class FakePrep:
        def transform(self, X):
            # Project 12 -> 6 by halving (deterministic for the test).
            return X[:, :6]

    class FakeModel:
        last_X_shape = None

        def predict_proba(self, X):
            FakeModel.last_X_shape = X.shape
            return np.array([[0.5, 0.3, 0.2]] * len(X))

    th = TrainedHGB(model=FakeModel(), preprocessor=FakePrep())
    th.predict_proba(np.zeros((2, 12)))
    assert FakeModel.last_X_shape == (2, 6)


def test_isotonic_calibrate_preserves_preprocessor_on_trained_hgb():
    """isotonic_calibrate(TrainedHGB) returns a new TrainedHGB; the
    preprocessor must be carried over."""
    from app.ml.training import FeatureMatrix, isotonic_calibrate

    class FakePrep:
        def transform(self, X):
            return X[:, :6]

    class FakeModel:
        def predict_proba(self, X):
            # Calibration needs distinct prob values per row to fit
            # IsotonicRegression — synthesize a small spread.
            n = len(X)
            base = np.linspace(0.2, 0.8, n)
            return np.stack([base, 1 - base - 0.1, np.full(n, 0.1)], axis=1)

    raw = TrainedHGB(model=FakeModel(), preprocessor=FakePrep())
    calib = FeatureMatrix(
        X=np.zeros((30, 12)),
        y=np.array([0, 1, 2] * 10),
        event_ids=[f"E{i}" for i in range(30)],
        kickoffs=[f"2024-08-{i+1:02d}T15:00:00Z" for i in range(30)],
    )
    cal = isotonic_calibrate(raw, calib)
    assert isinstance(cal, TrainedHGB)
    assert cal.preprocessor is raw.preprocessor  # same fitted object
    assert cal.calibrators is not None


def test_fit_and_apply_preprocessor_returns_projected_matrix():
    """_fit_and_apply_preprocessor fits scaler+PCA(0.95) and projects."""
    from app.ml.trainable import _fit_and_apply_preprocessor
    from app.ml.training import FeatureMatrix, HGB_FEATURE_COLUMNS

    rng = np.random.default_rng(0)
    # Make last 6 columns near-duplicates of the first 6 so the effective
    # rank is ~6. StandardScaler whitens all columns to unit variance, so
    # small absolute variance doesn't help — redundancy (correlation) is
    # what causes PCA(0.95) to drop components.
    X = rng.normal(size=(200, 12))
    X[:, 6:] = X[:, :6] + rng.normal(size=(200, 6)) * 0.01
    fm = FeatureMatrix(
        X=X,
        y=rng.integers(0, 3, size=200),
        event_ids=[f"E{i}" for i in range(200)],
        kickoffs=[f"2024-08-{(i%28)+1:02d}T15:00:00Z" for i in range(200)],
        columns=HGB_FEATURE_COLUMNS,
    )

    prep, projected = _fit_and_apply_preprocessor(fm)
    assert projected.X.shape[0] == 200
    assert projected.X.shape[1] < 12  # PCA(0.95) drops the redundant cols
    # The pipeline must be runnable on new data.
    Xnew = rng.normal(size=(5, 12))
    Xnew[:, 6:] = Xnew[:, :6] + rng.normal(size=(5, 6)) * 0.01
    out = prep.transform(Xnew)
    assert out.shape == (5, projected.X.shape[1])
    # Column names are pcN
    assert projected.columns[0] == "pc1"


def test_apply_preprocessor_uses_existing_fit():
    """_apply_preprocessor must not refit."""
    from app.ml.trainable import _apply_preprocessor, _fit_and_apply_preprocessor
    from app.ml.training import FeatureMatrix, HGB_FEATURE_COLUMNS

    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, 12))
    X[:, 6:] = X[:, :6] + rng.normal(size=(200, 6)) * 0.01
    fm = FeatureMatrix(
        X=X, y=rng.integers(0, 3, size=200),
        event_ids=[f"E{i}" for i in range(200)],
        kickoffs=[f"2024-08-{(i%28)+1:02d}T15:00:00Z" for i in range(200)],
        columns=HGB_FEATURE_COLUMNS,
    )
    prep, _ = _fit_and_apply_preprocessor(fm)

    calib = FeatureMatrix(
        X=rng.normal(size=(30, 12)),
        y=rng.integers(0, 3, size=30),
        event_ids=[f"C{i}" for i in range(30)],
        kickoffs=[f"2024-09-{(i%28)+1:02d}T15:00:00Z" for i in range(30)],
        columns=HGB_FEATURE_COLUMNS,
    )
    out = _apply_preprocessor(prep, calib)
    assert out.X.shape[0] == 30
    assert out.X.shape[1] == prep.named_steps["pca"].n_components_
