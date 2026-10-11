/**
 * Live paper-trading contracts (FastAPI /picks/* and /backtest/runs).
 * Fields marked optional are additive backend changes (spec §4.3); the pages
 * fall back to the older fields when they are absent.
 */

export type StatsGroupBy =
  | "model"
  | "market"
  | "sport"
  | "country"
  | "competition"
  | "selection"
  | "edge_bucket"
  | "price_bucket"
  | "day"
  | "week"
  | "month";

/** One aggregate row of GET /picks/stats. Metrics are null when undefined (n = 0, no stake). */
export type StatsRow = {
  model?: string | null;
  market?: string | null;
  sport?: string | null;
  country?: string | null;
  competition?: string | null;
  selection?: string | null;
  edge_bucket?: string | null;
  price_bucket?: string | null;
  day?: string | null;
  week?: string | null;
  month?: string | null;
  n: number;
  wins: number | null;
  stake_total: number | null;
  pnl_total: number | null;
  hit_rate: number | null;
  roi: number | null;
  mean_clv: number | null;
  brier: number | null;
  max_drawdown: number | null;
};

export type StatsResponse = {
  group_by: StatsGroupBy[];
  filters: Record<string, unknown>;
  rows: StatsRow[];
};

/** One paper bet from GET /picks/history (newest first). */
export type HistoryRow = {
  id: number | string;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  recommended_at: string | null;
  bet_ts?: string | null;
  price_at_recommendation: number | null;
  closing_price?: number | null;
  model_prob: number | null;
  devigged_prob?: number | null;
  edge: number | null;
  /** Live stake (fraction of bankroll at full Kelly). */
  kelly_full?: number | null;
  /** 1 = won, 0 = lost, null = unsettled. */
  result: number | null;
  pnl: number | null;
  clv: number | null;
  status: string;
  settled_at?: string | null;
  kickoff?: string | null;
  /** Joined from match_event_summaries / upcoming_fixtures (spec §4.3). */
  home_team?: string | null;
  away_team?: string | null;
  competition?: string | null;
  country?: string | null;
  /** Older payloads: names from upcoming_fixtures only. */
  home_team_raw?: string | null;
  away_team_raw?: string | null;
  competition_path?: string | null;
};

export type HistoryResponse = {
  /** Total matching rows (newer backends) or the page size (older ones). */
  count: number;
  rows: HistoryRow[];
};

export type CalibrationBucket = {
  lower: number;
  upper: number;
  n: number;
  mean_pred: number;
  hit_rate: number;
};

export type CalibrationResponse = {
  model: string;
  n_buckets: number;
  buckets: CalibrationBucket[];
};

export type FacetsResponse = {
  models: string[];
  markets: string[];
  sports: string[];
  countries: string[];
  competitions: string[];
  selections: string[];
};

export type PicksSummary = {
  totals: {
    n: number;
    settled: number;
    pending: number;
    voided: number;
    total_pnl: number | null;
    mean_clv: number | null;
  };
  settled_series: { settled_at: string; pnl: number | null; clv: number | null }[];
  last_recommended_at?: string | null;
  last_settled_at?: string | null;
  oldest_pending_kickoff?: string | null;
};

/** The subset of GET /backtest/runs the model page needs. */
export type BacktestRunLite = {
  id: string;
  label: string;
  model: string;
  status: string;
  created_at: string;
  train_until: string | null;
  test_until: string | null;
  error: string | null;
  total_bets: number | null;
  hit_rate: number | null;
  roi: number | null;
  brier: number | null;
  sharpe_adjusted: number | null;
  mlflow_run_id: string | null;
  /** Backend-built MLflow deep link (spec §4.4); null when not logged. */
  mlflow_ui_url?: string | null;
};

export type BacktestRunsResponse = { items: BacktestRunLite[] };
