"""Single owner of all MLflow writes, plus the tracking-server status gate.

Two logging entry points — `log_training_run` and `log_backtest_run` —
share a canonical schema. Every caller routes through one of these; the
pyfunc wrapper and the registry helpers are the only other modules that
touch mlflow, and only through `import_mlflow()`.

`mlflow` is never imported at module level. The API imports this module
on its boot path (src.py -> backtest_manager -> tracking), so a broken or
missing mlflow install must cost the MLflow features, not the API.

Enable gate, evaluated on every call:
  - `APP_MLFLOW_DISABLED=1` turns all MLflow work into no-ops.
  - Otherwise the tracking server is probed with `GET {uri}/health`
    (2 s timeout). The result is cached for 60 s per tracking URI, so an
    unreachable server costs one probe per minute, not one per call, and
    logging resumes on its own once the server is back.
  - Only connectivity failures gate. A logging error while the server is
    healthy (bad value, serialization) is logged as a warning, the MLflow
    run is closed as FAILED, and the next call proceeds normally.
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Dict, Mapping, Optional, Sequence

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.ml.backtest import BacktestReport
    from app.ml.market_spec import MarketSpec

_log = logging.getLogger("app.ml.tracking")

# Single experiment for every model fit. Phase C may add per-sport ones.
EXPERIMENT_NAME = "picks"

# macOS AirPlay Receiver owns :5000, so the local server runs on :5050.
DEFAULT_TRACKING_URI = "http://127.0.0.1:5050"

# Allowed values of the `purpose` tag. `scheduled_retrain` is reserved
# for Phase D; `backfill` marks runs reconstructed from backtest_runs rows.
PURPOSES = ("offline_training", "walk_forward_backtest", "scheduled_retrain", "backfill")

PROBE_TIMEOUT_S = 2.0
PROBE_TTL_S = 60.0

# Applied (setdefault) before mlflow is first imported. MLflow's own
# defaults (7 retries with exponential backoff, 120 s timeout) can stall
# the single backtest worker for minutes when the server dies mid-run.
_MLFLOW_HTTP_DEFAULTS = {
    "MLFLOW_HTTP_REQUEST_MAX_RETRIES": "1",
    "MLFLOW_HTTP_REQUEST_TIMEOUT": "10",
}


class MlflowUnavailable(RuntimeError):
    """MLflow is disabled, unreachable, or its client cannot be imported."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def is_enabled() -> bool:
    return os.getenv("APP_MLFLOW_DISABLED") != "1"


def tracking_uri() -> str:
    return os.getenv("MLFLOW_TRACKING_URI") or DEFAULT_TRACKING_URI


def _is_http(uri: str) -> bool:
    return uri.startswith(("http://", "https://"))


def redact_uri(uri: Optional[str]) -> Optional[str]:
    """The URI without user:password@ — anything shown to a browser or
    written into an error message goes through this (a hosted tracking
    server may be configured with basic-auth credentials in the URI)."""
    if not uri:
        return uri
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(uri)
    if "@" not in parts.netloc:
        return uri
    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def ui_base_url() -> Optional[str]:
    """Browser-facing MLflow UI base: `APP_MLFLOW_UI_URL`, else the
    tracking URI when it is an http(s) server. None for local stores."""
    explicit = os.getenv("APP_MLFLOW_UI_URL")
    if explicit:
        return redact_uri(explicit.rstrip("/"))
    uri = tracking_uri()
    return redact_uri(uri.rstrip("/")) if _is_http(uri) else None


def import_mlflow():
    """Import and return the mlflow module, applying our HTTP defaults
    first. Raises whatever the import raises (callers decide)."""
    for key, value in _MLFLOW_HTTP_DEFAULTS.items():
        os.environ.setdefault(key, value)
    import mlflow

    return mlflow


# ---------------------------------------------------------------------------
# Reachability probe (TTL-cached per tracking URI)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Probe:
    reachable: bool
    error: Optional[str]
    checked_at: str
    expires_at: float


_probe_lock = threading.Lock()
_probes: Dict[str, _Probe] = {}
_experiment_ids: Dict[str, str] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _health_check(uri: str) -> Optional[str]:
    """Return None when the server answers /health with 200, else a
    short error string."""
    if not _is_http(uri):
        # sqlite:// and file stores are local; there is no server to probe.
        return None
    import httpx

    try:
        resp = httpx.get(f"{uri.rstrip('/')}/health", timeout=PROBE_TIMEOUT_S)
    except httpx.HTTPError as exc:
        return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    if resp.status_code != 200:
        return f"/health returned HTTP {resp.status_code}"
    return None


def probe(*, force: bool = False) -> _Probe:
    """Reachability of the configured tracking server, cached for
    `PROBE_TTL_S`. `force=True` bypasses (and refreshes) the cache."""
    uri = tracking_uri()
    with _probe_lock:
        cached = _probes.get(uri)
        if cached is not None and not force and cached.expires_at > time.monotonic():
            return cached
    error = _health_check(uri)
    result = _Probe(
        reachable=error is None,
        error=error,
        checked_at=_now_iso(),
        expires_at=time.monotonic() + PROBE_TTL_S,
    )
    with _probe_lock:
        _probes[uri] = result
    return result


def _reset_state() -> None:
    """Forget cached probes and experiment ids (tests, URI changes)."""
    with _probe_lock:
        _probes.clear()
        _experiment_ids.clear()


def require_client():
    """(mlflow, MlflowClient) for the configured URI, or raise
    MlflowUnavailable with an operator-readable reason."""
    if not is_enabled():
        raise MlflowUnavailable("MLflow is disabled (APP_MLFLOW_DISABLED=1)")
    uri = tracking_uri()
    status = probe()
    if not status.reachable:
        raise MlflowUnavailable(f"MLflow tracking server unreachable at {redact_uri(uri)}: {status.error}")
    try:
        mlflow = import_mlflow()
    except Exception as exc:
        raise MlflowUnavailable(f"mlflow client cannot be imported: {exc!r}") from exc
    return mlflow, mlflow.MlflowClient(tracking_uri=uri)


def connection_lost() -> bool:
    """Classify a failed MLflow call by re-probing the server. True means
    the failure was connectivity (the fresh 'unreachable' result stays
    cached for the TTL, gating further calls); False means the server is
    healthy and the error was about the data."""
    return not probe(force=True).reachable


# ---------------------------------------------------------------------------
# Experiment id + UI deep links
# ---------------------------------------------------------------------------

def _experiment_id(client, *, create: bool) -> Optional[str]:
    uri = tracking_uri()
    with _probe_lock:
        cached = _experiment_ids.get(uri)
    if cached is not None:
        return cached
    exp = client.get_experiment_by_name(EXPERIMENT_NAME)
    if exp is not None:
        exp_id = exp.experiment_id
    elif create:
        exp_id = client.create_experiment(EXPERIMENT_NAME)
    else:
        return None
    with _probe_lock:
        _experiment_ids[uri] = exp_id
    return exp_id


def cached_experiment_id() -> Optional[str]:
    """Experiment id if already resolved for the current URI. Never
    touches the network — safe inside async handlers."""
    with _probe_lock:
        return _experiment_ids.get(tracking_uri())


def resolve_experiment_id() -> Optional[str]:
    """Resolve (and cache) the `picks` experiment id. Blocking: at most
    one health probe per TTL plus one lookup per process. Returns None
    when MLflow is disabled/unreachable or the experiment does not exist
    yet; never raises."""
    cached = cached_experiment_id()
    if cached is not None or not is_enabled():
        return cached
    try:
        _, client = require_client()
        return _experiment_id(client, create=False)
    except Exception as exc:
        _log.debug("mlflow_experiment_lookup_failed", extra={"reason": str(exc)})
        return None


def ensure_experiment_id() -> str:
    """Resolve the `picks` experiment id, creating the experiment when
    missing. Raises MlflowUnavailable when MLflow can't be used."""
    _, client = require_client()
    return _experiment_id(client, create=True)


def experiment_ui_url(experiment_id: Optional[str] = None) -> Optional[str]:
    base = ui_base_url()
    exp_id = experiment_id or cached_experiment_id()
    if not base or not exp_id:
        return None
    return f"{base}/#/experiments/{exp_id}"


def run_ui_url(run_id: Optional[str], experiment_id: Optional[str] = None) -> Optional[str]:
    """MLflow 3 UI deep link to a run, or None when it can't be built
    (no UI base, unknown experiment, no run)."""
    if not run_id:
        return None
    exp_url = experiment_ui_url(experiment_id)
    return f"{exp_url}/runs/{run_id}" if exp_url else None


def model_ui_url(name: str, version: Optional[str] = None) -> Optional[str]:
    base = ui_base_url()
    if not base:
        return None
    url = f"{base}/#/models/{name}"
    return f"{url}/versions/{version}" if version is not None else url


def get_status() -> Dict[str, Any]:
    """Status payload matching `MlflowStatus` in frontend/src/types/ops.ts.

    Blocking (≤ 2 s health probe, cached 60 s) — call it from a thread
    or a sync route, not directly inside an async handler."""
    uri = tracking_uri()
    status: Dict[str, Any] = {
        "enabled": is_enabled(),
        "reachable": False,
        "tracking_uri": redact_uri(uri),
        "ui_url": ui_base_url(),
        "experiment_name": EXPERIMENT_NAME,
        "experiment_id": cached_experiment_id(),
        "error": None,
        "checked_at": None,
    }
    if not status["enabled"]:
        status["error"] = "disabled via APP_MLFLOW_DISABLED=1"
        return status
    result = probe()
    status["checked_at"] = result.checked_at
    if not result.reachable:
        status["error"] = result.error
        return status
    try:
        _, client = require_client()
        status["experiment_id"] = _experiment_id(client, create=False)
    except MlflowUnavailable as exc:
        status["error"] = str(exc)
        return status
    except Exception as exc:
        if connection_lost():
            status["error"] = f"{type(exc).__name__}: {exc}"
            return status
        status["error"] = f"experiment lookup failed: {exc}"
    status["reachable"] = True
    return status


# ---------------------------------------------------------------------------
# Canonical schema helpers
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _git_sha_or_none() -> Optional[str]:
    """Return the current git HEAD sha, or None if not in a git repo."""
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return None


def _feature_set_hash(columns: Sequence[str]) -> str:
    """Stable hex hash of the feature column ordering."""
    payload = "|".join(columns)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _canonical_params(
    *,
    model_name: str,
    train_until: str,
    market_spec: "MarketSpec",
    feature_columns: Sequence[str],
    n_train_events: int,
    git_sha: Optional[str],
) -> dict[str, Any]:
    return {
        "model_name": model_name,
        "train_until": train_until,
        "market_spec_key": market_spec.key,
        "sport": market_spec.sport,
        "market": market_spec.market,
        "feature_set_hash": _feature_set_hash(feature_columns),
        "n_features": len(feature_columns),
        "n_train_events": n_train_events,
        "git_sha": git_sha or "unknown",
    }


def _finite_metrics(metrics: Mapping[str, Any]) -> dict[str, float]:
    """Drop None / NaN / inf: an undefined metric is not logged rather
    than logged as a misleading number."""
    out: dict[str, float] = {}
    for key, value in metrics.items():
        if value is None:
            continue
        f = float(value)
        if math.isfinite(f):
            out[key] = f
    return out


def _begin(stage: str):
    """Gate + lazy import for a logging call. Returns (mlflow,
    experiment_id) or None when logging should be skipped."""
    if not is_enabled():
        return None
    status = probe()
    if not status.reachable:
        _log.info(
            "mlflow_logging_skipped",
            extra={"event": "mlflow_logging_skipped", "stage": stage,
                   "reason": status.error, "uri": tracking_uri()},
        )
        return None
    try:
        mlflow, client = require_client()
        mlflow.set_tracking_uri(tracking_uri())
        return mlflow, _experiment_id(client, create=True)
    except Exception as exc:
        _warn_failure(exc, stage)
        return None


def _warn_failure(exc: BaseException, stage: str) -> None:
    down = connection_lost()
    if not down:
        # The server is healthy, so the cached experiment id may be what
        # broke (experiment deleted or recreated): resolve it again on the
        # next call instead of failing every run until a restart.
        with _probe_lock:
            _experiment_ids.pop(tracking_uri(), None)
    event = "mlflow_unreachable" if down else "mlflow_logging_failed"
    _log.warning(
        event,
        extra={"event": event, "stage": stage, "reason": f"{type(exc).__name__}: {exc}",
               "uri": tracking_uri(),
               "retry_after_s": PROBE_TTL_S if down else 0},
    )


def _log_model_safely(
    mlflow,
    *,
    model_name: str,
    trained_model: Any,
    stage: str,
) -> bool:
    """Log `picks_model` into the active run. Returns True on success.

    Trainable models without a fitted object are skipped (there is
    nothing to serve); analytic baselines log their stateless wrapper.
    A failure here never loses the run's params/metrics."""
    from app.ml.pyfunc_wrapper import ANALYTIC_MODELS, save_picks_model

    if trained_model is None and model_name not in ANALYTIC_MODELS:
        return False
    try:
        save_picks_model(model_name=model_name, trained_model=trained_model)
        return True
    except Exception as exc:
        _warn_failure(exc, f"{stage}.save_picks_model")
        return False


# ---------------------------------------------------------------------------
# Public logging entry points
# ---------------------------------------------------------------------------

def log_training_run(
    *,
    model_name: str,
    train_until: str,
    market_spec: "MarketSpec",
    feature_columns: Sequence[str],
    n_train_events: int,
    metrics_uncalibrated: Mapping[str, float],
    metrics_calibrated: Mapping[str, float],
    trained_model: Any,
    artifact_extras: Optional[Mapping[str, str]] = None,
    extra_params: Optional[Mapping[str, Any]] = None,
    git_sha: Optional[str] = None,
) -> Optional[str]:
    """Log one offline training run. Returns the MLflow run_id, or None
    when tracking is disabled/unreachable or the run failed to log.

    `extra_params` carries the script's hyper-parameters; canonical
    params win on a key clash (MLflow rejects re-logging a param with a
    different value)."""
    began = _begin("log_training_run")
    if began is None:
        return None
    mlflow, experiment_id = began
    params = {
        **dict(extra_params or {}),
        **_canonical_params(
            model_name=model_name, train_until=train_until,
            market_spec=market_spec, feature_columns=feature_columns,
            n_train_events=n_train_events, git_sha=git_sha or _git_sha_or_none(),
        ),
    }
    metrics = {
        **{f"uncal_{k}": v for k, v in metrics_uncalibrated.items()},
        **{f"cal_{k}": v for k, v in metrics_calibrated.items()},
    }
    try:
        with mlflow.start_run(
            experiment_id=experiment_id,
            run_name=f"train_{model_name}_{train_until[:10]}",
        ) as run:
            mlflow.set_tags({"purpose": "offline_training"})
            mlflow.log_params({k: v for k, v in params.items() if v is not None})
            mlflow.log_metrics(_finite_metrics(metrics))
            for filename, content in (artifact_extras or {}).items():
                mlflow.log_text(content, filename)
            has_model = _log_model_safely(
                mlflow, model_name=model_name, trained_model=trained_model,
                stage="log_training_run",
            )
            mlflow.set_tags({"has_model": "true" if has_model else "false"})
            return run.info.run_id
    except Exception as exc:
        _warn_failure(exc, "log_training_run")
        return None


def clv_available(report: "BacktestReport") -> bool:
    """CLV needs a price taken before the close. Archive backtests price
    every bet at the closing line, so CLV is undefined there even though
    the bet rows carry a number."""
    if report.mean_clv is None:
        return False
    return any(b.price_taken != b.closing_price for b in report.bets)


def backtest_metrics(report: "BacktestReport") -> Dict[str, Optional[float]]:
    """A backtest's summary metrics with undefined values as None
    (undefined is not zero): every rate metric is None when the run
    placed no bets, and `mean_clv` is None unless CLV is defined.

    The one definition shared by the MLflow run (None -> not logged) and
    the persisted `backtest_runs` row (None -> NULL)."""
    placed = report.total_bets > 0
    return {
        "hit_rate": report.hit_rate if placed else None,
        "roi": report.roi if placed else None,
        "brier": report.brier if placed else None,
        "log_loss": report.log_loss if placed else None,
        "max_drawdown": report.max_drawdown if placed else None,
        "return_per_bet": report.return_per_bet if placed else None,
        "rmse_per_bet": report.rmse_per_bet if placed else None,
        "sharpe_adjusted": report.sharpe_adjusted if placed else None,
        "mean_clv": report.mean_clv if clv_available(report) else None,
    }


def log_backtest_run(
    *,
    report: "BacktestReport",
    model_name: str,
    train_until: str,
    test_until: Optional[str],
    market_spec: "MarketSpec",
    feature_columns: Sequence[str],
    backtest_run_id: str,
    n_train_events: Optional[int] = None,
    trained_model: Any = None,
    scope_size: Optional[int] = None,
    git_sha: Optional[str] = None,
) -> Optional[str]:
    """Log one walk-forward backtest, including the fitted model as
    `picks_model` so the run can be registered and promoted. Returns the
    MLflow run_id, or None when tracking is disabled/unreachable or the
    run failed to log.

    Undefined metrics are omitted (see `backtest_metrics`): rate metrics
    when the run placed no bets, `mean_clv` unless CLV is defined (tag
    `clv_available`)."""
    began = _begin("log_backtest_run")
    if began is None:
        return None
    mlflow, experiment_id = began

    config = report.config or {}
    params = _canonical_params(
        model_name=model_name, train_until=train_until,
        market_spec=market_spec, feature_columns=feature_columns,
        n_train_events=n_train_events if n_train_events is not None else report.n_train_events,
        git_sha=git_sha or _git_sha_or_none(),
    )
    params.update({
        "test_until": test_until or "",
        "min_edge": config.get("min_edge"),
        "kelly_fraction": config.get("kelly_fraction"),
        "force_bets": config.get("force_bets"),
        "scope_size": scope_size,
    })

    metrics: dict[str, Any] = {
        "n_bets": report.total_bets,
        "n_test_events": report.test_events,
        **backtest_metrics(report),
    }

    try:
        with mlflow.start_run(
            experiment_id=experiment_id,
            run_name=f"bt_{model_name}_{train_until[:10]}",
        ) as run:
            mlflow.set_tags({
                "purpose": "walk_forward_backtest",
                "backtest_run_id": backtest_run_id,
                "clv_available": "true" if clv_available(report) else "false",
            })
            mlflow.log_params({k: v for k, v in params.items() if v is not None})
            mlflow.log_metrics(_finite_metrics(metrics))
            svg = report.reliability_svg
            if svg is None and report.reliability_buckets:
                from app.ml.backtest import render_reliability_svg

                svg = render_reliability_svg(report.reliability_buckets)
            if svg:
                mlflow.log_text(svg, "reliability.svg")
            has_model = _log_model_safely(
                mlflow, model_name=model_name, trained_model=trained_model,
                stage="log_backtest_run",
            )
            mlflow.set_tags({"has_model": "true" if has_model else "false"})
            return run.info.run_id
    except Exception as exc:
        _warn_failure(exc, "log_backtest_run")
        return None
