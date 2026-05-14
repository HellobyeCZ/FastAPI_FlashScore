// Typed wrappers around /api/picks/* routes.
// Each function returns a parsed, type-safe object. Errors throw.

export type StatsFilters = {
  status?: "settled" | "pending" | "all";
  dateFrom?: string;
  dateTo?: string;
  model?: string[];
  market?: string[];
  sport?: string[];
  country?: string[];
  competition?: string[];
  selection?: string[];
  edgeMin?: number;
  edgeMax?: number;
  priceMin?: number;
  priceMax?: number;
  minNPerGroup?: number;
};

export type StatsGroupBy =
  | "model" | "market" | "sport" | "country" | "competition"
  | "selection" | "edge_bucket" | "price_bucket"
  | "day" | "week" | "month";

export type StatsRow = {
  [dim: string]: string | number | null | undefined;
  n: number;
  wins: number;
  hit_rate: number | null;
  stake_total: number;
  pnl_total: number;
  roi: number | null;
  mean_clv: number | null;
  brier: number | null;
  max_drawdown: number;
};

export type StatsResponse = {
  group_by: StatsGroupBy[];
  filters: Record<string, unknown>;
  rows: StatsRow[];
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

export type HistoryRow = {
  id: number | string;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  recommended_at: string;
  bet_ts: string;
  price_at_recommendation: number;
  closing_price: number | null;
  model_prob: number;
  devigged_prob: number | null;
  edge: number | null;
  kelly_full: number | null;
  result: number | null;
  pnl: number | null;
  clv: number | null;
  status: string;
  // Joined from upcoming_fixtures when available.
  kickoff?: string | null;
  home_team_raw?: string | null;
  away_team_raw?: string | null;
  competition_path?: string | null;
};

export type HistoryResponse = {
  count: number;
  rows: HistoryRow[];
};

function buildQuery(
  groupBy: StatsGroupBy[] | undefined,
  filters: StatsFilters
): string {
  const params = new URLSearchParams();
  if (groupBy && groupBy.length > 0) params.set("group_by", groupBy.join(","));
  if (filters.status) params.set("status", filters.status);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.model?.length) params.set("model", filters.model.join(","));
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.sport?.length) params.set("sport", filters.sport.join(","));
  if (filters.country?.length) params.set("country", filters.country.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  if (filters.selection?.length) params.set("selection", filters.selection.join(","));
  if (filters.edgeMin !== undefined) params.set("edge_min", String(filters.edgeMin));
  if (filters.edgeMax !== undefined) params.set("edge_max", String(filters.edgeMax));
  if (filters.priceMin !== undefined) params.set("price_min", String(filters.priceMin));
  if (filters.priceMax !== undefined) params.set("price_max", String(filters.priceMax));
  if (filters.minNPerGroup) params.set("min_n_per_group", String(filters.minNPerGroup));
  return params.toString();
}

export async function fetchStats(
  groupBy: StatsGroupBy[],
  filters: StatsFilters = {},
  source?: "live" | "backtest" | "both",
  run_id?: string
): Promise<StatsResponse> {
  const qs = buildQuery(groupBy, filters);
  const params = new URLSearchParams(qs);
  if (source) params.set("source", source);
  if (run_id) params.set("run_id", run_id);
  const r = await fetch(`/api/picks/stats?${params.toString()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`stats: HTTP ${r.status}`);
  return (await r.json()) as StatsResponse;
}

export async function fetchCalibration(
  model: string,
  filters: StatsFilters = {},
  source?: "live" | "backtest" | "both",
  run_id?: string
): Promise<CalibrationResponse> {
  const params = new URLSearchParams({ model });
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  if (source) params.set("source", source);
  if (run_id) params.set("run_id", run_id);
  const r = await fetch(`/api/picks/stats/calibration?${params.toString()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`calibration: HTTP ${r.status}`);
  return (await r.json()) as CalibrationResponse;
}

export async function fetchHistory(opts: {
  status?: "settled" | "pending" | "voided";
  limit?: number;
  source?: "live" | "backtest" | "both";
  run_id?: string;
} = {}): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.source) params.set("source", opts.source);
  if (opts.run_id) params.set("run_id", opts.run_id);
  const r = await fetch(`/api/picks/history?${params.toString()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`history: HTTP ${r.status}`);
  return (await r.json()) as HistoryResponse;
}
