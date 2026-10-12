/**
 * GET /ops/status — one cheap call that tells the shell whether the system is
 * trustworthy right now. Contract shared with app/routes/ops.py (FastAPI).
 * All timestamps are ISO-8601 UTC strings.
 */
export type HealthLevel = "ok" | "warn" | "error";

export type HealthIssueCode =
  | "pipeline_stale"
  | "pipeline_never"
  | "settle_overdue"
  | "no_models_loaded"
  | "live_odds_stale"
  | "mlflow_unreachable"
  | "mlflow_disabled";

export type HealthIssue = {
  code: HealthIssueCode | string;
  level: Exclude<HealthLevel, "ok">;
  /** English fallback; the UI localizes by `code` using `params`. */
  message: string;
  params: Record<string, string | number | null>;
};

export type ServedModel = {
  name: string;
  loaded: boolean;
  /** "registry" when resolved from MLflow `@champion`, "file" from $APP_ML_MODELS_DIR. */
  source: "registry" | "file" | null;
  version: string | null;
  run_id: string | null;
  loaded_at: string | null;
};

export type MlflowStatus = {
  enabled: boolean;
  reachable: boolean;
  tracking_uri: string | null;
  /** Browser-facing MLflow UI base URL (APP_MLFLOW_UI_URL, defaults to tracking URI). */
  ui_url: string | null;
  experiment_name: string;
  experiment_id: string | null;
  error: string | null;
  checked_at: string | null;
};

export type OpsStatus = {
  generated_at: string;
  git_sha: string | null;
  db: { size_bytes: number | null };
  pipeline: {
    last_pick_recorded_at: string | null;
    last_settled_at: string | null;
    pending_bets: number;
    oldest_pending_at: string | null;
    last_live_odds_at: string | null;
    last_discovery_at: string | null;
    upcoming_fixtures_72h: number;
    last_scrape_job_at: string | null;
    active_scrape_jobs: number;
    active_backtests: number;
  };
  models: ServedModel[];
  mlflow: MlflowStatus;
  health: { level: HealthLevel; issues: HealthIssue[] };
};
