"""GET /ops/status — mirrors ``OpsStatus`` in frontend/src/types/ops.ts.

All timestamps are ISO-8601 UTC strings.
"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

HealthLevel = Literal["ok", "warn", "error"]


class HealthIssue(BaseModel):
    code: str = Field(description="Stable issue code the UI localizes, e.g. pipeline_stale.")
    level: Literal["warn", "error"]
    message: str = Field(description="English fallback text.")
    params: Dict[str, Union[str, int, float, None]] = Field(default_factory=dict)


class ServedModel(BaseModel):
    name: str
    loaded: bool
    source: Optional[Literal["registry", "file"]] = Field(
        default=None,
        description='"registry" when resolved from MLflow @champion, "file" from $APP_ML_MODELS_DIR.',
    )
    version: Optional[str] = None
    run_id: Optional[str] = None
    loaded_at: Optional[str] = None


class MlflowStatus(BaseModel):
    enabled: bool
    reachable: bool
    tracking_uri: Optional[str] = None
    ui_url: Optional[str] = Field(
        default=None,
        description="Browser-facing MLflow UI base URL (APP_MLFLOW_UI_URL, defaults to the tracking URI).",
    )
    experiment_name: str
    experiment_id: Optional[str] = None
    error: Optional[str] = None
    checked_at: Optional[str] = None


class DbStatus(BaseModel):
    size_bytes: Optional[int] = Field(description="Main SQLite file plus its -wal file.")


class PipelineStatus(BaseModel):
    last_pick_recorded_at: Optional[str] = None
    last_settled_at: Optional[str] = None
    pending_bets: int = 0
    oldest_pending_at: Optional[str] = Field(
        default=None, description="recommended_at of the oldest pending paper bet."
    )
    last_live_odds_at: Optional[str] = None
    last_discovery_at: Optional[str] = None
    upcoming_fixtures_72h: int = 0
    last_scrape_job_at: Optional[str] = Field(
        default=None, description="Most recent activity (updated_at) on any bulk scrape job."
    )
    active_scrape_jobs: int = 0
    active_backtests: int = 0


class HealthStatus(BaseModel):
    level: HealthLevel
    issues: List[HealthIssue] = Field(default_factory=list)


class OpsStatus(BaseModel):
    generated_at: str
    git_sha: Optional[str] = None
    db: DbStatus
    pipeline: PipelineStatus
    models: List[ServedModel] = Field(default_factory=list)
    mlflow: MlflowStatus
    health: HealthStatus
