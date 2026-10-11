"""Router: ops. See app/routes/__init__.py.

``GET /ops/status`` is the one cheap call the shell polls to decide whether
the system can be trusted right now. It must stay fast on the 9 GB archive:
only small tables (``paper_bets``, ``scrape_jobs``, ``backtest_runs``,
``upcoming_*``) are aggregated, ``live_odds_snapshots`` is read through an
index ``MAX()``, the database size comes from ``os.stat`` and the snapshot
tables are never counted.
"""
from __future__ import annotations

import contextlib
import dataclasses
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

import structlog
from fastapi import APIRouter

from app.ml import db as ml_db
from app.ml.paper_trade_stats import (
    SETTLE_GRACE,
    format_timestamp,
    parse_timestamp,
    pipeline_freshness,
    table_names,
)
from app.schemas.ops import (
    DbStatus,
    HealthIssue,
    HealthStatus,
    MlflowStatus,
    OpsStatus,
    PipelineStatus,
    ServedModel,
)

router = APIRouter(tags=["ops"])

_logger = structlog.get_logger("ops")

# Health thresholds (spec §4.1).
PIPELINE_WARN_AFTER = timedelta(hours=36)
PIPELINE_ERROR_AFTER = timedelta(days=7)
LIVE_ODDS_STALE_AFTER = timedelta(hours=24)
UPCOMING_WINDOW = timedelta(hours=72)

_ACTIVE_STATUSES = ("queued", "running")
_LEVEL_RANK = {"ok": 0, "warn": 1, "error": 2}
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _connect() -> sqlite3.Connection:
    return ml_db.connect(read_only=True)


# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _git_sha() -> Optional[str]:
    """Deployed commit: ``APP_GIT_SHA`` when the deploy sets it, else the
    checkout's HEAD. Resolved once per process."""
    configured = (os.getenv("APP_GIT_SHA") or "").strip()
    if configured:
        return configured
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def _db_size_bytes(path: str) -> Optional[int]:
    """Main file plus write-ahead log; None when the file is missing."""
    try:
        size = os.stat(path).st_size
    except OSError:
        return None
    with contextlib.suppress(OSError):
        size += os.stat(f"{path}-wal").st_size
    return size


def _scalar(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> Any:
    row = conn.execute(sql, tuple(params)).fetchone()
    return row[0] if row else None


def _collect_pipeline(conn: sqlite3.Connection, now: datetime) -> Tuple[PipelineStatus, Dict[str, Any]]:
    """Return ``(PipelineStatus, freshness)``; ``freshness`` also carries
    the overdue-settlement figures the health rules need."""
    tables = table_names(conn)
    freshness = pipeline_freshness(conn, now=now)
    active = ",".join("?" for _ in _ACTIVE_STATUSES)
    fields: Dict[str, Any] = {
        "last_pick_recorded_at": format_timestamp(freshness["last_recommended_at"]),
        "last_settled_at": format_timestamp(freshness["last_settled_at"]),
        "pending_bets": freshness["pending_bets"],
        "oldest_pending_at": format_timestamp(freshness["oldest_pending_recommended_at"]),
    }
    if "live_odds_snapshots" in tables:
        # Min/max optimisation over idx_live_odds_snapshots_fetched.
        fields["last_live_odds_at"] = format_timestamp(
            _scalar(conn, "SELECT MAX(fetched_at) FROM live_odds_snapshots")
        )
    if "upcoming_discovery_runs" in tables:
        fields["last_discovery_at"] = format_timestamp(
            _scalar(conn, "SELECT MAX(ran_at) FROM upcoming_discovery_runs")
        )
    if "upcoming_fixtures" in tables:
        # Same window comparison /picks/upcoming uses (kickoffs are stored
        # as +00:00 ISO strings), served by idx_upcoming_fixtures_kickoff.
        fields["upcoming_fixtures_72h"] = int(_scalar(
            conn,
            "SELECT COUNT(*) FROM upcoming_fixtures WHERE start_time_utc >= ? AND start_time_utc <= ?",
            (now.isoformat(), (now + UPCOMING_WINDOW).isoformat()),
        ) or 0)
    if "scrape_jobs" in tables:
        fields["last_scrape_job_at"] = format_timestamp(
            _scalar(conn, "SELECT MAX(updated_at) FROM scrape_jobs")
        )
        fields["active_scrape_jobs"] = int(_scalar(
            conn, f"SELECT COUNT(*) FROM scrape_jobs WHERE status IN ({active})", _ACTIVE_STATUSES,
        ) or 0)
    if "backtest_runs" in tables:
        fields["active_backtests"] = int(_scalar(
            conn, f"SELECT COUNT(*) FROM backtest_runs WHERE status IN ({active})", _ACTIVE_STATUSES,
        ) or 0)
    return PipelineStatus(**fields), freshness


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return dict(vars(value))


def _known_fields(model: Any, values: Mapping[str, Any]) -> Dict[str, Any]:
    """Keep the contract's fields; datetimes become the ISO strings it uses."""
    return {
        k: format_timestamp(v) if isinstance(v, datetime) else v
        for k, v in values.items()
        if k in model.model_fields
    }


def _served_models() -> List[ServedModel]:
    """What the serving layer answers /predict with.

    Prefers ``app.ml.serving.served_models_info()`` (registry-aware); falls
    back to the loaded-artifact flags of the file-based loader in src.py.
    """
    try:
        from app.ml.serving import served_models_info
    except ImportError:
        served_models_info = None
    except Exception:
        # A broken dependency (e.g. mlflow) must degrade, not 500 the poll.
        _logger.exception("serving_import_failed")
        served_models_info = None
    if served_models_info is not None:
        try:
            info = served_models_info()
            if isinstance(info, Mapping):
                info = [{"name": name, **_as_dict(entry)} for name, entry in info.items()]
            return [ServedModel(**_known_fields(ServedModel, _as_dict(entry))) for entry in info]
        except Exception:
            _logger.exception("served_models_info_failed")

    loaded = dict.fromkeys(("logistic", "hgb", "dixon_coles"), False)
    # Read from the running app module rather than imported: src.py includes
    # this router (a module-level import would be circular), and under
    # ``python src.py`` it runs as __main__, where ``import src`` would load
    # (and initialise) a second copy of the app.
    app_module = sys.modules.get("src") or sys.modules.get("__main__")
    get_ml_artifacts = getattr(app_module, "_get_ml_artifacts", None)
    if get_ml_artifacts is None:
        _logger.warning("ml_artifacts_unavailable", reason="app module not loaded")
    else:
        try:
            artifacts = get_ml_artifacts()
            loaded = {
                "logistic": artifacts.logistic is not None,
                "hgb": artifacts.hgb is not None,
                "dixon_coles": artifacts.dc_rates is not None,
            }
        except Exception:
            _logger.exception("ml_artifacts_unavailable")
    return [
        ServedModel(name=name, loaded=is_loaded, source="file" if is_loaded else None)
        for name, is_loaded in loaded.items()
    ]


def _mlflow_status() -> MlflowStatus:
    """Tracking status from ``app.ml.tracking.get_status()``. Without it,
    MLflow counts as enabled unless ``APP_MLFLOW_DISABLED=1`` and its
    reachability as unknown (False) rather than assumed up."""
    try:
        from app.ml.tracking import get_status
    except ImportError:
        get_status = None
    except Exception:
        _logger.exception("tracking_import_failed")
        get_status = None
    if get_status is not None:
        try:
            status = {"experiment_name": "picks", **_as_dict(get_status())}
            return MlflowStatus(**_known_fields(MlflowStatus, status))
        except Exception:
            _logger.exception("mlflow_status_failed")

    tracking_uri = os.getenv("MLFLOW_TRACKING_URI")
    return MlflowStatus(
        enabled=os.getenv("APP_MLFLOW_DISABLED") != "1",
        reachable=False,
        tracking_uri=tracking_uri,
        ui_url=os.getenv("APP_MLFLOW_UI_URL") or tracking_uri,
        experiment_name="picks",
        error="status unavailable",
    )


# ---------------------------------------------------------------------------
# Health rules
# ---------------------------------------------------------------------------

def _ago(delta: timedelta) -> str:
    hours = delta.total_seconds() / 3600
    return f"{hours / 24:.0f} days" if hours >= 48 else f"{hours:.0f} hours"


def evaluate_health(
    *,
    pipeline: PipelineStatus,
    freshness: Mapping[str, Any],
    models: List[ServedModel],
    mlflow: MlflowStatus,
    now: datetime,
) -> HealthStatus:
    """Apply the spec §4.1 rules; ``level`` is the worst issue level.

    ``pipeline_never`` is a warning, not an error: a fresh install without
    picks is expected, whereas a pipeline that ran and then stopped is what
    escalates. A disabled MLflow is a configuration choice, not an issue.
    """
    issues: List[HealthIssue] = []

    last_pick = parse_timestamp(pipeline.last_pick_recorded_at)
    if last_pick is None:
        issues.append(HealthIssue(
            code="pipeline_never",
            level="warn",
            message="The picks pipeline has never recorded a pick.",
        ))
    elif now - last_pick > PIPELINE_WARN_AFTER:
        age = now - last_pick
        issues.append(HealthIssue(
            code="pipeline_stale",
            level="error" if age > PIPELINE_ERROR_AFTER else "warn",
            message=f"The picks pipeline last recorded a pick {_ago(age)} ago.",
            params={"since": pipeline.last_pick_recorded_at},
        ))

    overdue = int(freshness.get("overdue_pending_bets") or 0)
    if overdue:
        issues.append(HealthIssue(
            code="settle_overdue",
            level="warn",
            message=(
                f"{overdue} pending bets kicked off more than "
                f"{_ago(SETTLE_GRACE)} ago and are still unsettled."
            ),
            params={"count": overdue, "since": freshness.get("oldest_overdue_kickoff")},
        ))

    if not any(model.loaded for model in models):
        issues.append(HealthIssue(
            code="no_models_loaded",
            level="warn",
            message="No trained model is being served.",
        ))

    if pipeline.upcoming_fixtures_72h > 0:
        last_live = parse_timestamp(pipeline.last_live_odds_at)
        if last_live is None or now - last_live > LIVE_ODDS_STALE_AFTER:
            issues.append(HealthIssue(
                code="live_odds_stale",
                level="warn",
                message=(
                    "No live odds have been captured for the upcoming fixtures."
                    if last_live is None
                    else f"Live odds were last captured {_ago(now - last_live)} ago."
                ),
                params={"since": pipeline.last_live_odds_at},
            ))

    if mlflow.enabled and not mlflow.reachable:
        issues.append(HealthIssue(
            code="mlflow_unreachable",
            level="warn",
            message=f"MLflow tracking server is unreachable ({mlflow.error or 'no response'}).",
            params={"uri": mlflow.tracking_uri},
        ))

    level = max((issue.level for issue in issues), key=_LEVEL_RANK.__getitem__, default="ok")
    return HealthStatus(level=level, issues=issues)


@router.get("/ops/status", response_model=OpsStatus)
def get_ops_status() -> OpsStatus:
    """Pipeline freshness, served models, MLflow and an overall health
    verdict. A plain ``def``: the SQLite reads run in the threadpool."""
    now = datetime.now(timezone.utc)
    with contextlib.closing(_connect()) as conn:
        pipeline, freshness = _collect_pipeline(conn, now)
    models = _served_models()
    mlflow = _mlflow_status()
    return OpsStatus(
        generated_at=now.isoformat(),
        git_sha=_git_sha(),
        db=DbStatus(size_bytes=_db_size_bytes(ml_db.db_path())),
        pipeline=pipeline,
        models=models,
        mlflow=mlflow,
        health=evaluate_health(
            pipeline=pipeline, freshness=freshness, models=models, mlflow=mlflow, now=now,
        ),
    )
