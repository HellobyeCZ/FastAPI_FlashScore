import os

import pytest

os.environ.setdefault("APP_MLFLOW_DISABLED", "1")


@pytest.fixture
def mlflow_store(tmp_path, monkeypatch):
    """Opt one test back into MLflow against a throwaway sqlite store.

    The `picks` experiment is pre-created with its artifact root under
    tmp_path (a sqlite tracking URI would otherwise write ./mlruns into
    the working tree). Tracking caches are reset on both sides and any
    run left active is closed, so tests can't leak MLflow state."""
    import mlflow

    from app.ml import tracking

    uri = f"sqlite:///{tmp_path / 'mlflow.db'}"
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    monkeypatch.delenv("APP_MLFLOW_UI_URL", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    tracking._reset_state()
    mlflow.set_tracking_uri(uri)
    mlflow.MlflowClient(tracking_uri=uri).create_experiment(
        tracking.EXPERIMENT_NAME,
        artifact_location=(tmp_path / "mlartifacts").as_uri(),
    )
    yield uri
    while mlflow.active_run() is not None:
        mlflow.end_run()
    tracking._reset_state()
