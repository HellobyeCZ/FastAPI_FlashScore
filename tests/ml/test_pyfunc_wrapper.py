"""Round-trip log → load → predict for each model type via the universal pyfunc."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import mlflow
import pandas as pd
import pytest


@pytest.fixture
def tracking(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    uri = f"sqlite:///{tmp_path / 'mlflow.db'}"
    mlflow.set_tracking_uri(uri)
    mlflow.set_experiment("picks")
    yield tmp_path


def _row_logistic() -> dict:
    return {
        "home_elo": 1600.0, "away_elo": 1500.0, "elo_diff": 100.0,
        "home_form_ppg": 2.0, "away_form_ppg": 1.0,
        "home_form_matches": 5, "away_form_matches": 5,
        "home_days_rest": 7, "away_days_rest": 7,
    }


def _row_with_market() -> dict:
    r = _row_logistic()
    r.update({"market_prob_home": 0.5, "market_prob_draw": 0.25, "market_prob_away": 0.25})
    return r


def test_analytic_market_implied_round_trip(tracking):
    from app.ml.pyfunc_wrapper import save_picks_model
    with mlflow.start_run() as run:
        save_picks_model(model_name="market_implied", trained_model=None)
        model_uri = f"runs:/{run.info.run_id}/picks_model"
    loaded = mlflow.pyfunc.load_model(model_uri)
    df = pd.DataFrame([_row_with_market()])
    out = loaded.predict(df)
    assert list(out.columns) == ["home", "draw", "away"]
    assert abs(out.iloc[0].sum() - 1.0) < 0.01


def test_logistic_round_trip(tracking):
    """Train a small logistic, save, load, predict."""
    import numpy as np
    from app.ml.training import (
        FeatureMatrix, train_logistic, BASE_FEATURE_COLUMNS,
    )
    from app.ml.pyfunc_wrapper import save_picks_model

    rng = np.random.default_rng(0)
    n = 60
    X = rng.normal(size=(n, len(BASE_FEATURE_COLUMNS)))
    y = rng.integers(0, 3, size=n)
    fm = FeatureMatrix(
        X=X, y=y,
        event_ids=[f"E{i}" for i in range(n)],
        kickoffs=[f"2024-01-{(i % 28) + 1:02d}T00:00:00Z" for i in range(n)],
    )
    trained = train_logistic(fm)
    with mlflow.start_run() as run:
        save_picks_model(model_name="logistic", trained_model=trained)
        model_uri = f"runs:/{run.info.run_id}/picks_model"
    loaded = mlflow.pyfunc.load_model(model_uri)
    df = pd.DataFrame([_row_logistic()])
    out = loaded.predict(df)
    assert list(out.columns) == ["home", "draw", "away"]
    assert abs(out.iloc[0].sum() - 1.0) < 0.01
