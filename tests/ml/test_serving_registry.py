"""Serving resolution: registry @champion first, $APP_ML_MODELS_DIR
fallback, provenance in served_models_info(), reload swaps the set."""
from __future__ import annotations

import pytest

from tests.ml.test_registry import log_backtest, small_logistic


@pytest.fixture
def models_dir(tmp_path, monkeypatch):
    """$APP_ML_MODELS_DIR holding a file-based logistic model."""
    root = tmp_path / "models"
    small_logistic(seed=7).save(str(root / "logistic_phase3a" / "model.pkl"))
    monkeypatch.setenv("APP_ML_MODELS_DIR", str(root))
    return root


@pytest.fixture
def fresh_holder(monkeypatch):
    from app.ml import serving

    monkeypatch.setattr(serving, "_served", None)
    return serving


def _info(models, name):
    return next(m for m in models if m["name"] == name)


def test_champion_is_served_from_registry(mlflow_store, models_dir, fresh_holder):
    from app.ml import registry

    serving = fresh_holder
    run_id = log_backtest("logistic", small_logistic(seed=1))
    registry.register_run(run_id, alias="champion")

    artifacts = serving.load_models()
    assert type(artifacts.logistic).__name__ == "TrainedLogistic"
    info = artifacts.served["logistic"]
    assert (info.loaded, info.source, info.version, info.run_id) == (True, "registry", "1", run_id)
    assert info.loaded_at.endswith("Z")
    assert artifacts.model_version("logistic") == "1"
    # No champion and no file for the others.
    assert artifacts.served["hgb"].loaded is False
    assert artifacts.served["dixon_coles"].loaded is False
    assert artifacts.model_version("hgb") is None


def test_falls_back_to_file_without_champion(mlflow_store, models_dir, fresh_holder):
    from app.ml import registry

    serving = fresh_holder
    registry.register_run(log_backtest("logistic", small_logistic()))  # no alias
    artifacts = serving.load_models()
    info = artifacts.served["logistic"]
    assert (info.loaded, info.source, info.version, info.run_id) == (True, "file", None, None)
    assert artifacts.model_version("logistic") == "file"


def test_falls_back_to_file_when_registry_unreachable(models_dir, fresh_holder, monkeypatch):
    from app.ml import tracking

    serving = fresh_holder
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:1")
    tracking._reset_state()
    try:
        artifacts = serving.load_models()
    finally:
        tracking._reset_state()
    assert artifacts.served["logistic"].source == "file"


def test_served_models_info_and_reload(mlflow_store, models_dir, fresh_holder):
    from app.ml import registry

    serving = fresh_holder
    before = serving.served_models_info()
    assert [m["name"] for m in before] == ["logistic", "hgb", "hgb_pca", "dixon_coles"]
    assert all(m["loaded"] is False and m["source"] is None for m in before)
    assert set(before[0]) == {"name", "loaded", "source", "version", "run_id", "loaded_at"}

    first = serving.get_served_artifacts()
    assert serving.get_served_artifacts() is first  # cached
    assert _info(serving.served_models_info(), "logistic")["source"] == "file"

    run_id = log_backtest("logistic", small_logistic(seed=3))
    registry.register_run(run_id, alias="champion")
    reloaded = serving.reload_models()
    assert serving.get_served_artifacts() is reloaded is not first
    logistic = _info(serving.served_models_info(), "logistic")
    assert (logistic["source"], logistic["version"], logistic["run_id"]) == ("registry", "1", run_id)


def test_reload_keeps_registry_champion_when_registry_goes_down(
    mlflow_store, models_dir, fresh_holder, monkeypatch
):
    """An outage must not demote a served champion to the file fallback:
    the registry's answer is unknown, not 'no champion'."""
    from app.ml import registry, tracking

    serving = fresh_holder
    run_id = log_backtest("logistic", small_logistic(seed=5))
    registry.register_run(run_id, alias="champion")
    served = serving.reload_models()
    assert served.served["logistic"].source == "registry"

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:1")
    tracking._reset_state()
    try:
        after = serving.reload_models()
    finally:
        tracking._reset_state()
    info = after.served["logistic"]
    assert (info.source, info.version, info.run_id) == ("registry", "1", run_id)
    assert after.logistic is served.logistic


def test_set_built_without_registry_is_re_resolved_when_mlflow_returns(
    mlflow_store, models_dir, fresh_holder, monkeypatch
):
    """Backend started before MLflow: the champion is picked up later
    without a manual reload."""
    from app.ml import registry, tracking

    serving = fresh_holder
    run_id = log_backtest("logistic", small_logistic(seed=9))
    registry.register_run(run_id, alias="champion")
    store_uri = tracking.tracking_uri()

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:1")
    tracking._reset_state()
    first = serving.get_served_artifacts()
    assert first.registry_answered is False
    assert first.served["logistic"].source == "file"

    monkeypatch.setenv("MLFLOW_TRACKING_URI", store_uri)
    tracking._reset_state()
    again = serving.get_served_artifacts()
    assert again.registry_answered is True
    assert (again.served["logistic"].source, again.served["logistic"].version) == ("registry", "1")


def test_failed_champion_download_keeps_the_served_version(
    mlflow_store, models_dir, fresh_holder, monkeypatch
):
    from app.ml import registry

    serving = fresh_holder
    registry.register_run(log_backtest("logistic", small_logistic(seed=2)), alias="champion")
    served = serving.reload_models()
    assert served.served["logistic"].version == "1"

    registry.register_run(log_backtest("logistic", small_logistic(seed=4)), alias="champion")

    def broken(name):
        raise RuntimeError("artifact download timed out")

    monkeypatch.setattr(registry, "load_champion", broken)
    after = serving.reload_models()
    info = after.served["logistic"]
    assert (info.source, info.version) == ("registry", "1")
    assert after.logistic is served.logistic
