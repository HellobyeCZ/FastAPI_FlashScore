"""MLflow Model Registry helpers ("Phase C-lite").

Naming: every app model `<model_name>` registers as `picks-<model_name>`.
Aliases: `@champion` is what live serving loads (app.ml.serving);
`@challenger` is tracked for comparison only.

A version is registered from a run's `picks_model` logged model (written
by app.ml.tracking for training runs and walk-forward backtests).
Registration is always an explicit operator action — nothing here is
called automatically.

Every function raises :class:`MlflowUnavailable` (from app.ml.tracking)
when MLflow is disabled, unreachable, or its client can't be imported;
routes map that to 503. Bad input raises :class:`RegistryNotFound`
(404) or :class:`RegistryError` (400). Blocking — call from a thread.
"""
from __future__ import annotations

import logging
import pickle
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from app.ml import tracking
from app.ml.pyfunc_wrapper import ARTIFACT_NAME, META_FILE, MODEL_PICKLE, SERVABLE_MODELS
from app.ml.tracking import MlflowUnavailable

_log = logging.getLogger("app.ml.registry")

NAME_PREFIX = "picks-"
ALIASES = ("champion", "challenger")

__all__ = [
    "ALIASES",
    "LoadedVersion",
    "MlflowUnavailable",
    "RegistryError",
    "RegistryNotFound",
    "delete_alias",
    "get_champion",
    "list_registry",
    "load_champion",
    "register_run",
    "registered_name",
    "run_has_model",
    "set_alias",
    "translate_errors",
    "versions_by_run",
]


class RegistryError(ValueError):
    """The request can't be satisfied as asked (maps to HTTP 400)."""


class RegistryNotFound(LookupError):
    """Unknown run, registered model, version, or alias (HTTP 404)."""


def registered_name(model_name: str) -> str:
    """`logistic` -> `picks-logistic`; already-prefixed names pass through."""
    return model_name if model_name.startswith(NAME_PREFIX) else f"{NAME_PREFIX}{model_name}"


def app_model_name(name: str) -> str:
    """`picks-logistic` -> `logistic`."""
    return name.removeprefix(NAME_PREFIX)


def _ms_to_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


@contextmanager
def translate_errors() -> Iterator[None]:
    """Map MLflow client exceptions onto the module's error types:
    missing resources -> RegistryNotFound, invalid values -> RegistryError,
    anything while the server is down -> MlflowUnavailable."""
    try:
        yield
    except (MlflowUnavailable, RegistryError, RegistryNotFound):
        raise
    except Exception as exc:
        code = getattr(exc, "error_code", None)
        if code == "RESOURCE_DOES_NOT_EXIST":
            raise RegistryNotFound(str(getattr(exc, "message", exc))) from exc
        if code == "INVALID_PARAMETER_VALUE":
            raise RegistryError(str(getattr(exc, "message", exc))) from exc
        if tracking.connection_lost():
            raise MlflowUnavailable(
                f"MLflow tracking server unreachable at {tracking.tracking_uri()}: {exc}"
            ) from exc
        raise


def _client():
    _, client = tracking.require_client()
    return client


# ---------------------------------------------------------------------------
# Logged-model resolution
# ---------------------------------------------------------------------------

def _logged_model_id(client, run) -> Optional[str]:
    """Id of the run's `picks_model` LoggedModel (MLflow 3), if any."""
    outputs = getattr(run, "outputs", None)
    for output in getattr(outputs, "model_outputs", None) or ():
        model = client.get_logged_model(output.model_id)
        if model.name == ARTIFACT_NAME:
            return model.model_id
    return None


def run_has_model(client, run, *, check_artifacts: bool = False) -> bool:
    """Whether a run carries a registrable `picks_model`.

    Order: the `has_model` tag our logger sets; MLflow 3 logged-model
    outputs (already in search results, no extra call); optionally a run
    artifact listing for runs logged with MLflow 2 (one extra request)."""
    tag = run.data.tags.get("has_model")
    if tag is not None:
        return tag == "true"
    outputs = getattr(run, "outputs", None)
    if getattr(outputs, "model_outputs", None):
        return True
    if check_artifacts:
        return any(a.path == ARTIFACT_NAME for a in client.list_artifacts(run.info.run_id))
    return False


def _model_source(client, run) -> Tuple[str, Optional[str]]:
    """(source URI, logged model id) to register from, or RegistryError."""
    model_id = _logged_model_id(client, run)
    if model_id is not None:
        return f"models:/{model_id}", model_id
    run_id = run.info.run_id
    if any(a.path == ARTIFACT_NAME for a in client.list_artifacts(run_id)):
        return f"runs:/{run_id}/{ARTIFACT_NAME}", None
    raise RegistryError(
        f"run {run_id} has no '{ARTIFACT_NAME}' model to register "
        "(backfilled runs and models without a fitted object log none)"
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------

def _validate_alias(alias: str) -> None:
    if alias not in ALIASES:
        raise RegistryError(f"alias must be one of {', '.join(ALIASES)}; got {alias!r}")


def _check_champion_allowed(model_name: str, alias: str) -> None:
    if alias == "champion" and model_name not in SERVABLE_MODELS:
        raise RegistryError(
            f"{model_name} is not servable from the registry, so @champion would "
            f"have no effect (servable: {', '.join(sorted(SERVABLE_MODELS))})"
        )


def register_run(
    run_id: str,
    alias: Optional[str] = None,
    description: Optional[str] = None,
) -> Dict[str, Optional[str]]:
    """Register `run_id`'s `picks_model` as a new version of
    `picks-<model_name>` (creating the registered model on first use),
    optionally pointing `alias` at it. Returns {name, version, alias}."""
    if alias is not None:
        _validate_alias(alias)
    client = _client()
    with translate_errors():
        run = client.get_run(run_id)
        model_name = run.data.params.get("model_name")
        if not model_name:
            raise RegistryError(f"run {run_id} has no 'model_name' param")
        if alias is not None:
            _check_champion_allowed(model_name, alias)
        source, model_id = _model_source(client, run)
        name = registered_name(model_name)
        try:
            client.get_registered_model(name)
        except Exception as exc:
            if getattr(exc, "error_code", None) != "RESOURCE_DOES_NOT_EXIST":
                raise
            client.create_registered_model(
                name,
                tags={"app_model_name": model_name},
                description=f"FlashScore picks model '{model_name}'.",
            )
        version = client.create_model_version(
            name=name,
            source=source,
            run_id=run_id,
            model_id=model_id,
            description=description,
            tags={"purpose": run.data.tags.get("purpose", "")},
        )
        if alias is not None:
            client.set_registered_model_alias(name, alias, version.version)
    _log.info(
        "registry_version_created",
        extra={"event": "registry_version_created", "registered_model": name,
               "version": version.version, "run_id": run_id, "alias": alias},
    )
    return {"name": name, "version": str(version.version), "alias": alias}


def set_alias(model_name: str, version: str, alias: str) -> Dict[str, str]:
    """Point `@alias` of `picks-<model_name>` at `version`."""
    _validate_alias(alias)
    name = registered_name(model_name)
    _check_champion_allowed(app_model_name(name), alias)
    client = _client()
    with translate_errors():
        client.get_model_version(name, str(version))
        client.set_registered_model_alias(name, alias, str(version))
    _log.info(
        "registry_alias_set",
        extra={"event": "registry_alias_set", "registered_model": name, "version": str(version),
               "alias": alias},
    )
    return {"name": name, "version": str(version), "alias": alias}


def delete_alias(model_name: str, alias: str) -> Dict[str, str]:
    """Remove `@alias` from `picks-<model_name>` (404 if it isn't set)."""
    _validate_alias(alias)
    name = registered_name(model_name)
    client = _client()
    with translate_errors():
        model = client.get_registered_model(name)
        if alias not in (model.aliases or {}):
            raise RegistryNotFound(f"{name} has no @{alias} alias")
        client.delete_registered_model_alias(name, alias)
    _log.info(
        "registry_alias_deleted",
        extra={"event": "registry_alias_deleted", "registered_model": name, "alias": alias},
    )
    return {"name": name, "alias": alias}


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def _registered_models(client) -> list:
    models: list = []
    page_token = None
    while True:
        page = client.search_registered_models(
            filter_string=f"name LIKE '{NAME_PREFIX}%'",
            page_token=page_token,
        )
        models.extend(page)
        page_token = page.token
        if not page_token:
            return sorted(models, key=lambda m: m.name)


def _versions(client, name: str) -> list:
    versions = client.search_model_versions(filter_string=f"name = '{name}'")
    return sorted(versions, key=lambda v: int(v.version), reverse=True)


def versions_by_run(client=None) -> Dict[str, List[Dict[str, str]]]:
    """{run_id: [{name, version}, ...]} across all `picks-*` models."""
    client = client or _client()
    out: Dict[str, List[Dict[str, str]]] = {}
    with translate_errors():
        for model in _registered_models(client):
            for v in _versions(client, model.name):
                if v.run_id:
                    out.setdefault(v.run_id, []).append(
                        {"name": model.name, "version": str(v.version)}
                    )
    return out


def list_registry() -> List[Dict[str, Any]]:
    """Every `picks-*` registered model with versions and their source-run
    evidence, shaped like `RegisteredModel` in frontend/src/types/mlflow.ts."""
    client = _client()
    runs: Dict[str, Any] = {}
    out: List[Dict[str, Any]] = []
    with translate_errors():
        for model in _registered_models(client):
            aliases = {a: str(v) for a, v in (model.aliases or {}).items()}
            versions = []
            for v in _versions(client, model.name):
                run = None
                if v.run_id:
                    if v.run_id not in runs:
                        try:
                            runs[v.run_id] = client.get_run(v.run_id)
                        except Exception as exc:
                            if getattr(exc, "error_code", None) != "RESOURCE_DOES_NOT_EXIST":
                                raise
                            runs[v.run_id] = None  # source run deleted
                    run = runs[v.run_id]
                versions.append({
                    "version": str(v.version),
                    "run_id": v.run_id,
                    "created_at": _ms_to_iso(v.creation_timestamp),
                    # search_model_versions doesn't populate aliases;
                    # derive them from the registered model's alias map.
                    "aliases": sorted(a for a, ver in aliases.items() if ver == str(v.version)),
                    "status": v.status,
                    "description": v.description or None,
                    "metrics": dict(run.data.metrics) if run else {},
                    "purpose": run.data.tags.get("purpose") if run else None,
                    "train_until": run.data.params.get("train_until") if run else None,
                    "ui_url": tracking.model_ui_url(model.name, str(v.version)),
                })
            model_name = app_model_name(model.name)
            out.append({
                "name": model.name,
                "model_name": model_name,
                "aliases": aliases,
                "versions": versions,
                "servable": model_name in SERVABLE_MODELS,
                "ui_url": tracking.model_ui_url(model.name),
            })
    return out


def get_champion(model_name: str) -> Optional[Tuple[str, Optional[str]]]:
    """(version, run_id) behind `picks-<model_name>@champion`, or None
    when the model or the alias doesn't exist."""
    client = _client()
    name = registered_name(model_name)
    try:
        with translate_errors():
            model = client.get_registered_model(name)
            champion = (model.aliases or {}).get("champion")
            if champion is None:
                return None
            version = client.get_model_version(name, str(champion))
    except RegistryNotFound:
        return None
    return str(version.version), version.run_id


@dataclass(frozen=True)
class LoadedVersion:
    model_name: str
    version: str
    run_id: Optional[str]
    trained: Any


def load_champion(model_name: str) -> Optional[LoadedVersion]:
    """Download `picks-<model_name>@champion` and unpickle its trained
    object straight from the pyfunc artifacts (no pyfunc predict at serve
    time). None when no champion is set; RegistryError when the artifact
    is not a servable model of that name."""
    champion = get_champion(model_name)
    if champion is None:
        return None
    version, run_id = champion
    mlflow = tracking.import_mlflow()
    name = registered_name(model_name)
    with tempfile.TemporaryDirectory() as tmp, translate_errors():
        local = Path(mlflow.artifacts.download_artifacts(
            artifact_uri=f"models:/{name}/{version}",
            dst_path=tmp,
            tracking_uri=tracking.tracking_uri(),
            registry_uri=tracking.tracking_uri(),
        ))
        meta_path = local / "artifacts" / META_FILE
        pickle_path = local / "artifacts" / MODEL_PICKLE
        if not meta_path.exists() or not pickle_path.exists():
            raise RegistryError(f"{name} v{version} is not a picks_model artifact")
        logged_name = meta_path.read_text().strip()
        if logged_name != model_name:
            raise RegistryError(
                f"{name} v{version} holds a '{logged_name}' model, not '{model_name}'"
            )
        with open(pickle_path, "rb") as f:
            trained = pickle.load(f)
    if not (hasattr(trained, "predict_proba") and hasattr(trained, "feature_columns")):
        raise RegistryError(f"{name} v{version} has no fitted model object")
    return LoadedVersion(model_name=model_name, version=version, run_id=run_id, trained=trained)
