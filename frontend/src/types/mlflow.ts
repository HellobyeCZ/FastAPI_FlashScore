/**
 * MLflow surface exposed by FastAPI (app/routes/mlflow.py). The browser never
 * talks to MLflow directly: the backend owns tracking + registry and returns
 * ready-to-use UI deep links (`ui_url`).
 */
import type { MlflowStatus } from "./ops";

export type MlflowPurpose =
  | "offline_training"
  | "walk_forward_backtest"
  | "scheduled_retrain"
  | "backfill";

export type MlflowRun = {
  run_id: string;
  run_name: string | null;
  status: string; // RUNNING | FINISHED | FAILED | KILLED
  start_time: string | null;
  end_time: string | null;
  purpose: MlflowPurpose | string | null;
  model_name: string | null;
  train_until: string | null;
  test_until: string | null;
  /** SQLite backtest_runs.id when purpose = walk_forward_backtest. */
  backtest_run_id: string | null;
  /** True when the run logged a `picks_model` pyfunc and can be registered. */
  has_model: boolean;
  params: Record<string, string>;
  metrics: Record<string, number>;
  /** Registered versions created from this run: [{ name, version }]. */
  registered_versions: { name: string; version: string }[];
  ui_url: string | null;
};

export type MlflowRunsResponse = {
  status: MlflowStatus;
  experiment_id: string | null;
  experiment_ui_url: string | null;
  runs: MlflowRun[];
};

export type RegistryAlias = "champion" | "challenger";

export type ModelVersion = {
  version: string;
  run_id: string | null;
  created_at: string | null;
  aliases: string[];
  status: string | null;
  description: string | null;
  /** Metrics copied from the source run (roi, sharpe_adjusted, n_bets, brier, …). */
  metrics: Record<string, number>;
  purpose: string | null;
  train_until: string | null;
  ui_url: string | null;
};

export type RegisteredModel = {
  /** MLflow registered model name, e.g. "picks-logistic". */
  name: string;
  /** App model key, e.g. "logistic". */
  model_name: string;
  aliases: Partial<Record<RegistryAlias, string>>;
  versions: ModelVersion[];
  /** Whether the live serving layer can load this model from the registry. */
  servable: boolean;
  ui_url: string | null;
};

export type RegistryResponse = {
  status: MlflowStatus;
  models: RegisteredModel[];
};

export type RegisterRequest = { run_id: string; alias?: RegistryAlias | null; description?: string | null };
export type RegisterResponse = { name: string; version: string; alias: RegistryAlias | null; reloaded: boolean };

export type SetAliasRequest = { version: string; alias: RegistryAlias };
export type SetAliasResponse = { name: string; version: string; alias: RegistryAlias; reloaded: boolean };
