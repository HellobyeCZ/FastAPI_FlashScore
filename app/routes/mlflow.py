"""Router: mlflow. See app/routes/__init__.py.

The backend owns MLflow; the browser never talks to it. These endpoints
expose tracking status, runs and the model registry with ready-made UI
deep links. Contract: frontend/src/types/mlflow.ts and ops.ts.

Every handler is a plain `def`, so FastAPI runs the blocking MLflow
client calls in its threadpool instead of on the event loop.

Degradation: when MLflow is disabled or unreachable, GETs answer 200
with `status.reachable = false` and empty lists; mutations answer 503
`{"detail": "..."}`.
"""
from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator

from app.ml import registry, serving, tracking
from app.ml.registry import MlflowUnavailable, RegistryError, RegistryNotFound

_log = logging.getLogger("app.routes.mlflow")

router = APIRouter(tags=["mlflow"])

Alias = Literal["champion", "challenger"]

# Filter values are interpolated into MLflow search strings, which have
# no escaping; model names and purposes never need more than this.
_FILTER_VALUE = re.compile(r"^[A-Za-z0-9_.\-]+$")


class RegisterRequest(BaseModel):
    run_id: str
    alias: Optional[Alias] = None
    description: Optional[str] = None


class SetAliasRequest(BaseModel):
    version: str
    alias: Alias

    @field_validator("version", mode="before")
    @classmethod
    def _version_as_str(cls, v: Any) -> Any:
        return str(v) if isinstance(v, int) else v


@contextmanager
def _http_errors() -> Iterator[None]:
    try:
        yield
    except MlflowUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RegistryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _ms_to_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _run_payload(
    run,
    *,
    has_model: bool,
    registered_versions: List[Dict[str, str]],
) -> Dict[str, Any]:
    """`MlflowRun` in frontend/src/types/mlflow.ts."""
    info, params, tags = run.info, run.data.params, run.data.tags
    return {
        "run_id": info.run_id,
        "run_name": info.run_name,
        "status": info.status,
        "start_time": _ms_to_iso(info.start_time),
        "end_time": _ms_to_iso(info.end_time),
        "purpose": tags.get("purpose"),
        "model_name": params.get("model_name"),
        "train_until": params.get("train_until") or None,
        "test_until": params.get("test_until") or None,
        "backtest_run_id": tags.get("backtest_run_id"),
        "has_model": has_model,
        "params": dict(params),
        "metrics": dict(run.data.metrics),
        "registered_versions": registered_versions,
        "ui_url": tracking.run_ui_url(info.run_id, info.experiment_id),
    }


def _degraded_status(exc: Exception) -> Dict[str, Any]:
    """Status after a call failed mid-request: re-probed, with the error."""
    tracking.connection_lost()
    status = tracking.get_status()
    status["error"] = status["error"] or f"{type(exc).__name__}: {exc}"
    return status


def _reload_after_champion_change() -> bool:
    """Swap the served models after @champion moved. The alias change has
    already succeeded, so a failed reload is reported, not raised."""
    try:
        serving.reload_models()
        return True
    except Exception:
        _log.exception("served_models_reload_failed")
        return False


@router.get("/mlflow/status")
def mlflow_status() -> Dict[str, Any]:
    return tracking.get_status()


@router.get("/mlflow/runs")
def mlflow_runs(
    purpose: Optional[str] = Query(default=None, description="tags.purpose"),
    model: Optional[str] = Query(default=None, description="params.model_name"),
    limit: int = Query(default=100, ge=1, le=1000),
) -> Dict[str, Any]:
    """Runs of the `picks` experiment, newest first (`MlflowRunsResponse`)."""
    for value in (purpose, model):
        if value is not None and not _FILTER_VALUE.match(value):
            raise HTTPException(status_code=400, detail=f"invalid filter value {value!r}")
    status = tracking.get_status()
    experiment_id = status["experiment_id"]
    response: Dict[str, Any] = {
        "status": status,
        "experiment_id": experiment_id,
        "experiment_ui_url": tracking.experiment_ui_url(experiment_id),
        "runs": [],
    }
    if not status["reachable"] or experiment_id is None:
        return response

    filters = []
    if purpose:
        filters.append(f"tags.purpose = '{purpose}'")
    if model:
        filters.append(f"params.model_name = '{model}'")
    try:
        _, client = tracking.require_client()
        runs = client.search_runs(
            [experiment_id],
            filter_string=" and ".join(filters),
            max_results=limit,
            order_by=["attributes.start_time DESC"],
        )
        versions = registry.versions_by_run(client)
        response["runs"] = [
            _run_payload(
                run,
                # Only MLflow-2-era training runs lack both the tag and a
                # logged-model output; list their artifacts to be sure.
                has_model=registry.run_has_model(
                    client, run,
                    check_artifacts=run.data.tags.get("purpose") == "offline_training",
                ),
                registered_versions=versions.get(run.info.run_id, []),
            )
            for run in runs
        ]
    except Exception as exc:
        _log.warning("mlflow_runs_listing_failed", exc_info=True)
        response["status"] = _degraded_status(exc)
        response["runs"] = []
    return response


@router.get("/mlflow/runs/{run_id}")
def mlflow_run(run_id: str) -> Dict[str, Any]:
    """One run (`MlflowRun`). 404 unknown, 503 when MLflow is unavailable."""
    with _http_errors():
        _, client = tracking.require_client()
        with registry.translate_errors():
            run = client.get_run(run_id)
            has_model = registry.run_has_model(client, run, check_artifacts=True)
        versions = registry.versions_by_run(client).get(run_id, [])
    return _run_payload(run, has_model=has_model, registered_versions=versions)


@router.get("/mlflow/registry")
def mlflow_registry() -> Dict[str, Any]:
    """Every `picks-*` registered model (`RegistryResponse`)."""
    status = tracking.get_status()
    if not status["reachable"]:
        return {"status": status, "models": []}
    try:
        models = registry.list_registry()
    except Exception as exc:
        _log.warning("mlflow_registry_listing_failed", exc_info=True)
        return {"status": _degraded_status(exc), "models": []}
    return {"status": status, "models": models}


@router.post("/mlflow/registry/register")
def mlflow_register(body: RegisterRequest) -> Dict[str, Any]:
    """Register a run's `picks_model` as a new version (`RegisterResponse`).
    Registering straight to @champion reloads serving."""
    with _http_errors():
        out = registry.register_run(body.run_id, alias=body.alias, description=body.description)
    reloaded = body.alias == "champion" and _reload_after_champion_change()
    return {**out, "reloaded": reloaded}


@router.post("/mlflow/registry/{model_name}/aliases")
def mlflow_set_alias(model_name: str, body: SetAliasRequest) -> Dict[str, Any]:
    """Point @champion / @challenger at a version (`SetAliasResponse`).
    `model_name` may be `logistic` or `picks-logistic`."""
    with _http_errors():
        out = registry.set_alias(model_name, body.version, body.alias)
    reloaded = body.alias == "champion" and _reload_after_champion_change()
    return {**out, "reloaded": reloaded}


@router.delete("/mlflow/registry/{model_name}/aliases/{alias}")
def mlflow_delete_alias(model_name: str, alias: str) -> Dict[str, Any]:
    """Remove an alias. Removing @champion reloads serving (the model falls
    back to $APP_ML_MODELS_DIR)."""
    with _http_errors():
        out = registry.delete_alias(model_name, alias)
    reloaded = alias == "champion" and _reload_after_champion_change()
    return {"ok": True, **out, "reloaded": reloaded}


@router.post("/ml/reload")
def ml_reload() -> Dict[str, Any]:
    """Re-resolve every served model; returns `{models: ServedModel[]}`."""
    serving.reload_models()
    return {"models": serving.served_models_info()}
