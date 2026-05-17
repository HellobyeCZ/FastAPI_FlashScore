"""Schema discipline + disable-gate semantics for app.ml.tracking."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import mlflow
import pytest


@pytest.fixture
def isolated_tracking(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    uri = f"sqlite:///{tmp_path / 'mlflow.db'}"
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    # Force a fresh module so _DISABLED is reset.
    import importlib, app.ml.tracking
    importlib.reload(app.ml.tracking)
    yield tmp_path
    importlib.reload(app.ml.tracking)  # leave the module in a clean state


def test_log_training_run_writes_canonical_schema(isolated_tracking):
    from app.ml import tracking
    from app.ml.market_spec import FOOTBALL_1X2_FT

    mlflow_run_id = tracking.log_training_run(
        model_name="logistic", train_until="2024-08-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
        feature_columns=("home_elo", "away_elo"),
        n_train_events=123,
        metrics_uncalibrated={"brier": 0.21, "log_loss": 0.95},
        metrics_calibrated={"brier": 0.20, "log_loss": 0.93},
        trained_model=None,  # analytic-style: no model file
        git_sha="deadbeef",
    )
    assert mlflow_run_id is not None
    client = mlflow.MlflowClient()
    run = client.get_run(mlflow_run_id)
    assert run.data.tags.get("purpose") == "offline_training"
    assert run.data.params.get("model_name") == "logistic"
    assert run.data.params.get("train_until") == "2024-08-01T00:00:00Z"
    assert run.data.params.get("market_spec_key") == "football_1x2_ft"
    assert run.data.params.get("sport") == "football"
    assert run.data.params.get("n_train_events") == "123"
    assert run.data.params.get("git_sha") == "deadbeef"
    assert "uncal_brier" in run.data.metrics
    assert "cal_brier" in run.data.metrics


def test_log_backtest_run_writes_canonical_schema(isolated_tracking):
    from app.ml import tracking
    from app.ml.backtest import BacktestReport
    from app.ml.market_spec import FOOTBALL_1X2_FT

    report = BacktestReport(
        model="logistic", scope_size=10, test_events=10, bets=[],
        total_bets=0, hit_rate=0.0, roi=0.0, mean_clv=None,
        brier=0.2, log_loss=0.7, max_drawdown=0.0,
        reliability_buckets=[],
        config={"min_edge": 0.02, "kelly_fraction": 0.25,
                "force_bets": False, "train_until": "2024-08-01T00:00:00Z",
                "test_until": "2024-12-31T00:00:00Z"},
        n_train_events=0,
        return_per_bet=1.05, rmse_per_bet=0.5, sharpe_adjusted=0.10,
    )
    mlflow_run_id = tracking.log_backtest_run(
        report=report, model_name="logistic",
        train_until="2024-08-01T00:00:00Z", test_until="2024-12-31T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
        feature_columns=("home_elo",),
        backtest_run_id="bt_42",
        git_sha="deadbeef",
    )
    assert mlflow_run_id is not None
    client = mlflow.MlflowClient()
    run = client.get_run(mlflow_run_id)
    assert run.data.tags.get("purpose") == "walk_forward_backtest"
    assert run.data.tags.get("backtest_run_id") == "bt_42"
    assert "sharpe_adjusted" in run.data.metrics
    assert run.data.metrics["sharpe_adjusted"] == pytest.approx(0.10)
    assert "return_per_bet" in run.data.metrics
    assert "rmse_per_bet" in run.data.metrics


def test_disabled_via_env_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_MLFLOW_DISABLED", "1")
    import importlib, app.ml.tracking
    importlib.reload(app.ml.tracking)
    from app.ml.market_spec import FOOTBALL_1X2_FT

    out = app.ml.tracking.log_training_run(
        model_name="logistic", train_until="2024-08-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT, feature_columns=(), n_train_events=0,
        metrics_uncalibrated={}, metrics_calibrated={},
        trained_model=None,
    )
    assert out is None
    importlib.reload(app.ml.tracking)
