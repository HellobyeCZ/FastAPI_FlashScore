"""Single owner of all MLflow writes.

Two public entry points — `log_training_run` and `log_backtest_run` —
share a canonical schema. Every caller in the codebase routes through
one of these; no other module imports mlflow directly except the
pyfunc wrapper.

Process-level enable gate: `APP_MLFLOW_DISABLED=1` short-circuits both
functions. If the tracking server URI is unreachable, the first call
emits one structured warning, flips `_DISABLED`, and subsequent calls
no-op. Backtests and offline scripts continue uninterrupted.
"""
from __future__ import annotations

import logging
import os
import subprocess
from typing import Any, Mapping, Optional, Sequence

import mlflow

from app.ml.backtest import BacktestReport
from app.ml.market_spec import MarketSpec
from app.ml.pyfunc_wrapper import save_picks_model

_log = logging.getLogger("app.ml.tracking")

# Process-level flag. Tripped by the env var or by an unreachable server.
_DISABLED: bool = False

# Single experiment for Phase A. Phase C may add per-sport sub-experiments.
EXPERIMENT_NAME = "picks"

# Allowed values of the `purpose` tag. Third value reserved for Phase D.
PURPOSES = ("offline_training", "walk_forward_backtest", "scheduled_retrain")


def _ensure_tracking() -> bool:
    """Return True if MLflow writes should proceed, False to no-op."""
    global _DISABLED
    if _DISABLED:
        return False
    if os.getenv("APP_MLFLOW_DISABLED") == "1":
        return False
    uri = os.getenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")
    try:
        mlflow.set_tracking_uri(uri)
        mlflow.set_experiment(EXPERIMENT_NAME)
    except Exception as e:
        _log.warning(
            "mlflow_disabled_for_process",
            extra={"event": "mlflow_disabled_for_process",
                   "reason": str(e), "uri": uri},
        )
        _DISABLED = True
        return False
    return True


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
    import hashlib
    payload = "|".join(columns)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _canonical_params(
    *,
    model_name: str,
    train_until: str,
    market_spec: MarketSpec,
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


def log_training_run(
    *,
    model_name: str,
    train_until: str,
    market_spec: MarketSpec,
    feature_columns: Sequence[str],
    n_train_events: int,
    metrics_uncalibrated: Mapping[str, float],
    metrics_calibrated: Mapping[str, float],
    trained_model: Any,
    artifact_extras: Optional[Mapping[str, str]] = None,
    git_sha: Optional[str] = None,
) -> Optional[str]:
    """Log a single training run. Returns the MLflow run_id, or None if
    tracking is disabled."""
    global _DISABLED
    if not _ensure_tracking():
        return None
    git_sha = git_sha or _git_sha_or_none()
    run_name = f"train_{model_name}_{train_until[:10]}"
    try:
        with mlflow.start_run(run_name=run_name) as run:
            mlflow.set_tag("purpose", "offline_training")
            for k, v in _canonical_params(
                model_name=model_name, train_until=train_until,
                market_spec=market_spec, feature_columns=feature_columns,
                n_train_events=n_train_events, git_sha=git_sha,
            ).items():
                mlflow.log_param(k, v)
            for k, v in metrics_uncalibrated.items():
                mlflow.log_metric(f"uncal_{k}", float(v))
            for k, v in metrics_calibrated.items():
                mlflow.log_metric(f"cal_{k}", float(v))
            save_picks_model(model_name=model_name, trained_model=trained_model,
                             extra_files=dict(artifact_extras or {}))
            return run.info.run_id
    except Exception as e:
        _log.warning(
            "mlflow_disabled_for_process",
            extra={"event": "mlflow_disabled_for_process",
                   "reason": str(e), "stage": "log_training_run"},
        )
        _DISABLED = True
        return None


def log_backtest_run(
    *,
    report: BacktestReport,
    model_name: str,
    train_until: str,
    test_until: Optional[str],
    market_spec: MarketSpec,
    feature_columns: Sequence[str],
    backtest_run_id: str,
    n_train_events: Optional[int] = None,
    git_sha: Optional[str] = None,
) -> Optional[str]:
    """Log a single walk-forward backtest. Returns the MLflow run_id, or
    None if tracking is disabled."""
    global _DISABLED
    if not _ensure_tracking():
        return None
    git_sha = git_sha or _git_sha_or_none()
    run_name = f"bt_{model_name}_{train_until[:10]}"
    try:
        with mlflow.start_run(run_name=run_name) as run:
            mlflow.set_tag("purpose", "walk_forward_backtest")
            mlflow.set_tag("backtest_run_id", backtest_run_id)
            params = _canonical_params(
                model_name=model_name, train_until=train_until,
                market_spec=market_spec, feature_columns=feature_columns,
                n_train_events=n_train_events if n_train_events is not None else report.n_train_events,
                git_sha=git_sha,
            )
            params["test_until"] = test_until or ""
            params["min_edge"] = report.config.get("min_edge")
            params["kelly_fraction"] = report.config.get("kelly_fraction")
            for k, v in params.items():
                mlflow.log_param(k, v)
            metrics = {
                "n_bets": float(report.total_bets),
                "hit_rate": float(report.hit_rate),
                "roi": float(report.roi),
                "brier": float(report.brier),
                "log_loss": float(report.log_loss),
                "mean_clv": float(report.mean_clv) if report.mean_clv is not None else 0.0,
                "max_drawdown": float(report.max_drawdown),
                "return_per_bet": float(report.return_per_bet),
                "rmse_per_bet": float(report.rmse_per_bet),
                "sharpe_adjusted": float(report.sharpe_adjusted),
            }
            for k, v in metrics.items():
                mlflow.log_metric(k, v)
            if report.reliability_svg:
                mlflow.log_text(report.reliability_svg, "reliability.svg")
            return run.info.run_id
    except Exception as e:
        _log.warning(
            "mlflow_disabled_for_process",
            extra={"event": "mlflow_disabled_for_process",
                   "reason": str(e), "stage": "log_backtest_run"},
        )
        _DISABLED = True
        return None
