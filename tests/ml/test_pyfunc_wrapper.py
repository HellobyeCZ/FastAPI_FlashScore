"""Round-trip log → load → predict for each model type via the universal pyfunc."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest


def _row_logistic() -> dict:
    return {
        "home_elo": 1600.0, "away_elo": 1500.0, "elo_diff": 100.0,
        "home_form_ppg": 2.0, "away_form_ppg": 1.0,
        "home_form_matches": 5.0, "away_form_matches": 5.0,
        "home_days_rest": 7.0, "away_days_rest": 7.0,
    }


def _row_with_market() -> dict:
    r = _row_logistic()
    r.update({
        "market_prob_home": 0.5, "market_prob_draw": 0.25, "market_prob_away": 0.25,
        "market_implied_home": 0.55, "market_implied_draw": 0.30, "market_implied_away": 0.25,
    })
    return r


def _log(model_name: str, trained_model) -> str:
    import mlflow

    from app.ml import tracking
    from app.ml.pyfunc_wrapper import save_picks_model

    # Log into the fixture's `picks` experiment (artifacts under tmp_path),
    # never MLflow's Default experiment (./mlruns in the working tree).
    with mlflow.start_run(experiment_id=tracking.ensure_experiment_id()):
        return save_picks_model(model_name=model_name, trained_model=trained_model)


def _load(model_uri: str):
    import mlflow

    return mlflow.pyfunc.load_model(model_uri)


def _small_logistic():
    import numpy as np

    from app.ml.training import BASE_FEATURE_COLUMNS, FeatureMatrix, train_logistic

    rng = np.random.default_rng(0)
    n = 60
    fm = FeatureMatrix(
        X=rng.normal(size=(n, len(BASE_FEATURE_COLUMNS))),
        y=rng.integers(0, 3, size=n),
        event_ids=[f"E{i}" for i in range(n)],
        kickoffs=[f"2024-01-{(i % 28) + 1:02d}T00:00:00Z" for i in range(n)],
    )
    return train_logistic(fm)


def test_module_does_not_import_mlflow_eagerly():
    import importlib
    import sys

    saved = sys.modules.pop("app.ml.pyfunc_wrapper", None)
    blocked = sys.modules.get("mlflow")
    sys.modules["mlflow"] = None  # importing mlflow would raise
    try:
        module = importlib.import_module("app.ml.pyfunc_wrapper")
        assert "logistic" in module.SERVABLE_MODELS
    finally:
        sys.modules.pop("app.ml.pyfunc_wrapper", None)
        if blocked is None:
            sys.modules.pop("mlflow", None)
        else:
            sys.modules["mlflow"] = blocked
        if saved is not None:
            sys.modules["app.ml.pyfunc_wrapper"] = saved


def test_analytic_market_implied_round_trip(mlflow_store):
    loaded = _load(_log("market_implied", None))
    out = loaded.predict(pd.DataFrame([_row_with_market()]))
    assert list(out.columns) == ["home", "draw", "away"]
    assert out.iloc[0].tolist() == pytest.approx([0.5, 0.25, 0.25])


def test_analytic_vig_included_reads_market_implied_columns(mlflow_store):
    loaded = _load(_log("vig_included", None))
    out = loaded.predict(pd.DataFrame([_row_with_market()]))
    s = 0.55 + 0.30 + 0.25
    assert out.iloc[0].tolist() == pytest.approx([0.55 / s, 0.30 / s, 0.25 / s])


def test_logistic_round_trip_with_signature_and_code_paths(mlflow_store):
    trained = _small_logistic()
    model_uri = _log("logistic", trained)
    loaded = _load(model_uri)

    inputs = loaded.metadata.get_input_schema().input_names()
    assert inputs == list(trained.feature_columns)

    out = loaded.predict(pd.DataFrame([_row_logistic()]))
    assert list(out.columns) == ["home", "draw", "away"]
    assert abs(out.iloc[0].sum() - 1.0) < 0.01

    import mlflow

    local = Path(mlflow.artifacts.download_artifacts(artifact_uri=model_uri))
    assert (local / "code" / "app" / "ml" / "pyfunc_wrapper.py").exists()
    assert not list((local / "code").rglob("__pycache__"))
    assert (local / "artifacts" / "meta.txt").read_text() == "logistic"


def test_dixon_coles_is_logged_but_not_predictable(mlflow_store):
    loaded = _load(_log("dixon_coles", {"E1": {"home_attack": 1.0}}))
    with pytest.raises(NotImplementedError, match="not servable"):
        loaded.predict(pd.DataFrame([{"event_id": "E1"}]))
