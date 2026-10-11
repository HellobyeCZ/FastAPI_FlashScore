"""/mlflow/* and /ml/reload: degraded mode when MLflow is off, and a
register -> promote -> serve round trip against a temp sqlite store."""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from tests.ml.test_registry import log_backtest, small_logistic

STATUS_KEYS = {
    "enabled", "reachable", "tracking_uri", "ui_url", "experiment_name",
    "experiment_id", "error", "checked_at",
}
RUN_KEYS = {
    "run_id", "run_name", "status", "start_time", "end_time", "purpose",
    "model_name", "train_until", "test_until", "backtest_run_id", "has_model",
    "params", "metrics", "registered_versions", "ui_url",
}


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> Iterator[TestClient]:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    monkeypatch.setenv("APP_ML_MODELS_DIR", str(tmp_path / "models"))
    from app.config import get_settings

    get_settings.cache_clear()
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS odds_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT)"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS match_stats_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT, is_terminal INTEGER DEFAULT 0)"
        )
        c.commit()
    from app.services.storage import SnapshotStore

    asyncio.run(SnapshotStore(str(db)).initialize())

    from app.ml import serving

    monkeypatch.setattr(serving, "_served", None)
    from src import _get_backtest_manager, app

    _get_backtest_manager.cache_clear()
    with TestClient(app) as c:
        yield c
    _get_backtest_manager.cache_clear()


def test_degraded_mode_when_disabled(client: TestClient):
    status = client.get("/mlflow/status")
    assert status.status_code == 200
    body = status.json()
    assert set(body) == STATUS_KEYS
    assert body["enabled"] is False and body["reachable"] is False

    runs = client.get("/mlflow/runs", params={"purpose": "walk_forward_backtest"})
    assert runs.status_code == 200
    assert runs.json()["runs"] == []
    assert runs.json()["status"]["reachable"] is False
    assert set(runs.json()) == {"status", "experiment_id", "experiment_ui_url", "runs"}

    registry = client.get("/mlflow/registry")
    assert registry.status_code == 200
    assert registry.json()["models"] == []

    for method, path, payload in (
        ("post", "/mlflow/registry/register", {"run_id": "abc"}),
        ("post", "/mlflow/registry/logistic/aliases", {"version": "1", "alias": "champion"}),
        ("delete", "/mlflow/registry/logistic/aliases/champion", None),
        ("get", "/mlflow/runs/abc", None),
    ):
        resp = getattr(client, method)(path, **({"json": payload} if payload else {}))
        assert resp.status_code == 503, (path, resp.text)
        assert "disabled" in resp.json()["detail"]

    reload = client.post("/ml/reload")
    assert reload.status_code == 200
    models = reload.json()["models"]
    assert [m["name"] for m in models] == ["logistic", "hgb", "hgb_pca", "dixon_coles"]
    assert all(m["loaded"] is False for m in models)


def test_request_validation(client: TestClient):
    assert client.get("/mlflow/runs", params={"model": "x' or 1=1"}).status_code == 400
    bad_alias = client.post(
        "/mlflow/registry/logistic/aliases", json={"version": "1", "alias": "production"},
    )
    assert bad_alias.status_code == 422


def test_runs_register_promote_and_serve(client: TestClient, mlflow_store, monkeypatch):
    monkeypatch.setenv("APP_MLFLOW_UI_URL", "http://mlflow.test")
    bt_run = log_backtest("logistic", small_logistic(seed=2))
    no_model_run = log_backtest("hgb", None)

    status = client.get("/mlflow/status").json()
    assert status["reachable"] is True and status["experiment_id"]

    listing = client.get("/mlflow/runs").json()
    assert listing["experiment_ui_url"] == f"http://mlflow.test/#/experiments/{status['experiment_id']}"
    by_id = {r["run_id"]: r for r in listing["runs"]}
    assert set(by_id) == {bt_run, no_model_run}
    run = by_id[bt_run]
    assert set(run) == RUN_KEYS
    assert run["has_model"] is True
    assert run["purpose"] == "walk_forward_backtest"
    assert run["model_name"] == "logistic"
    assert run["backtest_run_id"] == "bt_logistic"
    assert run["test_until"] is None
    assert run["ui_url"] == f"http://mlflow.test/#/experiments/{status['experiment_id']}/runs/{bt_run}"
    assert by_id[no_model_run]["has_model"] is False

    filtered = client.get("/mlflow/runs", params={"model": "hgb"}).json()["runs"]
    assert [r["run_id"] for r in filtered] == [no_model_run]

    assert client.post("/mlflow/registry/register", json={"run_id": no_model_run}).status_code == 400
    assert client.post("/mlflow/registry/register", json={"run_id": "0" * 32}).status_code == 404

    registered = client.post(
        "/mlflow/registry/register", json={"run_id": bt_run, "alias": "challenger"},
    )
    assert registered.status_code == 200, registered.text
    assert registered.json() == {
        "name": "picks-logistic", "version": "1", "alias": "challenger", "reloaded": False,
    }
    detail = client.get(f"/mlflow/runs/{bt_run}").json()
    assert detail["registered_versions"] == [{"name": "picks-logistic", "version": "1"}]
    assert client.get("/mlflow/runs/" + "0" * 32).status_code == 404

    promoted = client.post(
        "/mlflow/registry/picks-logistic/aliases", json={"version": 1, "alias": "champion"},
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json() == {
        "name": "picks-logistic", "version": "1", "alias": "champion", "reloaded": True,
    }
    served = {m["name"]: m for m in client.post("/ml/reload").json()["models"]}
    assert served["logistic"]["source"] == "registry"
    assert served["logistic"]["version"] == "1"
    assert served["logistic"]["run_id"] == bt_run

    [model] = client.get("/mlflow/registry").json()["models"]
    assert model["aliases"] == {"champion": "1", "challenger": "1"}
    assert model["versions"][0]["aliases"] == ["challenger", "champion"]

    removed = client.delete("/mlflow/registry/logistic/aliases/champion")
    assert removed.status_code == 200
    assert removed.json() == {
        "ok": True, "name": "picks-logistic", "alias": "champion", "reloaded": True,
    }
    served = {m["name"]: m for m in client.post("/ml/reload").json()["models"]}
    assert served["logistic"]["loaded"] is False  # no file fallback in this test
    assert client.delete("/mlflow/registry/logistic/aliases/champion").status_code == 404
