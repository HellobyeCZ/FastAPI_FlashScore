"""Register / alias / list / champion round trip for app.ml.registry on a
throwaway sqlite MLflow store."""
from __future__ import annotations

import pytest

from app.ml.backtest import BacktestReport, BetRecord
from app.ml.market_spec import FOOTBALL_1X2_FT


def small_logistic(seed: int = 0):
    import numpy as np

    from app.ml.training import BASE_FEATURE_COLUMNS, FeatureMatrix, train_logistic

    rng = np.random.default_rng(seed)
    n = 60
    fm = FeatureMatrix(
        X=rng.normal(size=(n, len(BASE_FEATURE_COLUMNS))),
        y=rng.integers(0, 3, size=n),
        event_ids=[f"E{i}" for i in range(n)],
        kickoffs=[f"2024-01-{(i % 28) + 1:02d}T00:00:00Z" for i in range(n)],
    )
    return train_logistic(fm)


def log_backtest(model_name: str, trained_model, *, roi: float = 0.04) -> str:
    """Log a walk-forward backtest run (with picks_model when there is
    something to log) and return its MLflow run id."""
    from app.ml import tracking

    bet = BetRecord(
        event_id="E1", bet_ts="2024-08-10T14:55:00Z",
        market="HOME_DRAW_AWAY:FULL_TIME", selection="home",
        price_taken=2.0, closing_price=2.0, model_prob=0.55, implied_prob=0.5,
        devigged_prob=0.48, edge=0.07, stake_kelly_fraction=0.05,
        result=1.0, pnl=0.05, clv=0.0,
    )
    report = BacktestReport(
        model=model_name, scope_size=1, test_events=1, bets=[bet], total_bets=1,
        hit_rate=1.0, roi=roi, mean_clv=0.0, brier=0.2, log_loss=0.6,
        max_drawdown=0.0, reliability_buckets=[], config={"min_edge": 0.02},
        return_per_bet=2.0, rmse_per_bet=1.0, sharpe_adjusted=1.0,
    )
    run_id = tracking.log_backtest_run(
        report=report, model_name=model_name,
        train_until="2024-08-01T00:00:00Z", test_until=None,
        market_spec=FOOTBALL_1X2_FT, feature_columns=("home_elo",),
        backtest_run_id=f"bt_{model_name}", trained_model=trained_model,
    )
    assert run_id is not None
    return run_id


def test_register_alias_list_and_champion_round_trip(mlflow_store, monkeypatch):
    from app.ml import registry

    monkeypatch.setenv("APP_MLFLOW_UI_URL", "http://mlflow.test")
    run_v1 = log_backtest("logistic", small_logistic(0), roi=0.04)
    run_v2 = log_backtest("logistic", small_logistic(1), roi=0.07)

    assert registry.get_champion("logistic") is None

    first = registry.register_run(run_v1, description="first")
    assert first == {"name": "picks-logistic", "version": "1", "alias": None}
    second = registry.register_run(run_v2, alias="champion")
    assert second == {"name": "picks-logistic", "version": "2", "alias": "champion"}

    assert registry.set_alias("logistic", "1", "challenger") == {
        "name": "picks-logistic", "version": "1", "alias": "challenger",
    }
    assert registry.get_champion("picks-logistic") == ("2", run_v2)

    models = registry.list_registry()
    assert len(models) == 1
    model = models[0]
    assert model["name"] == "picks-logistic"
    assert model["model_name"] == "logistic"
    assert model["aliases"] == {"champion": "2", "challenger": "1"}
    assert model["servable"] is True
    assert model["ui_url"] == "http://mlflow.test/#/models/picks-logistic"
    assert [v["version"] for v in model["versions"]] == ["2", "1"]
    v2, v1 = model["versions"]
    assert v2["run_id"] == run_v2
    assert v2["aliases"] == ["champion"]
    assert v2["metrics"]["roi"] == pytest.approx(0.07)
    assert v2["purpose"] == "walk_forward_backtest"
    assert v2["train_until"] == "2024-08-01T00:00:00Z"
    assert v2["ui_url"] == "http://mlflow.test/#/models/picks-logistic/versions/2"
    assert v2["created_at"].endswith("Z")
    assert v1["description"] == "first"

    assert registry.versions_by_run() == {
        run_v1: [{"name": "picks-logistic", "version": "1"}],
        run_v2: [{"name": "picks-logistic", "version": "2"}],
    }

    loaded = registry.load_champion("logistic")
    assert loaded is not None
    assert (loaded.version, loaded.run_id) == ("2", run_v2)
    assert type(loaded.trained).__name__ == "TrainedLogistic"

    assert registry.delete_alias("logistic", "champion") == {
        "name": "picks-logistic", "alias": "champion",
    }
    assert registry.get_champion("logistic") is None
    with pytest.raises(registry.RegistryNotFound):
        registry.delete_alias("logistic", "champion")


def test_register_requires_a_logged_model(mlflow_store):
    from app.ml import registry

    run_id = log_backtest("logistic", None)  # trainable without fitted object
    with pytest.raises(registry.RegistryError, match="no 'picks_model'"):
        registry.register_run(run_id)


def test_register_unknown_run_is_not_found(mlflow_store):
    from app.ml import registry

    with pytest.raises(registry.RegistryNotFound):
        registry.register_run("0" * 32)


def test_non_servable_models_register_but_cannot_be_champion(mlflow_store):
    from app.ml import registry

    run_id = log_backtest("market_implied", None)  # analytic wrapper is logged
    with pytest.raises(registry.RegistryError, match="not servable"):
        registry.register_run(run_id, alias="champion")
    out = registry.register_run(run_id, alias="challenger")
    assert out["name"] == "picks-market_implied"
    [model] = registry.list_registry()
    assert model["servable"] is False
    with pytest.raises(registry.RegistryError):
        registry.set_alias("market_implied", out["version"], "champion")


def test_alias_validation_and_unknown_version(mlflow_store):
    from app.ml import registry

    run_id = log_backtest("logistic", small_logistic())
    registry.register_run(run_id)
    with pytest.raises(registry.RegistryError, match="alias"):
        registry.set_alias("logistic", "1", "production")
    with pytest.raises(registry.RegistryNotFound):
        registry.set_alias("logistic", "9", "challenger")


def test_unavailable_when_disabled_or_unreachable(monkeypatch):
    from app.ml import registry, tracking

    monkeypatch.setenv("APP_MLFLOW_DISABLED", "1")
    with pytest.raises(registry.MlflowUnavailable, match="disabled"):
        registry.list_registry()

    monkeypatch.delenv("APP_MLFLOW_DISABLED")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:1")
    tracking._reset_state()
    try:
        with pytest.raises(registry.MlflowUnavailable, match="unreachable"):
            registry.get_champion("logistic")
    finally:
        tracking._reset_state()
