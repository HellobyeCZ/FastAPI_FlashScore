"use client";
import { useMutation, useQueries, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { backendGet, backendSend } from "@/lib/api/http";
import { opsStatusKey } from "@/hooks/useOpsStatus";

/**
 * Backtest API surface (FastAPI /backtest/* and the backtest branch of
 * /picks/*), shared by the Model lab pages and anything else that lists runs.
 * All calls go through the allowlisted /api/backend proxy.
 */

export type BacktestStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type BacktestRunSummary = {
  id: string;
  /** Free text; auto-generated runs carry "<model>_<ISO timestamp>". */
  label: string;
  model: string;
  status: BacktestStatus;
  created_at: string;
  train_until: string;
  test_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  test_events: number | null;
  total_bets: number | null;
  hit_rate: number | null;
  roi: number | null;
  /** Undefined for backtests (bets are priced at the close) — never display it. */
  mean_clv: number | null;
  brier: number | null;
  log_loss: number | null;
  max_drawdown: number | null;
  /** Current step while running (e.g. "training", "backtesting"). */
  stage: string | null;
  market_spec: string;
  sharpe_adjusted: number | null;
  mlflow_run_id: string | null;
  /** Number of matches the model was trained on (absent on older backends). */
  n_train_events?: number | null;
  /** Backend-built MLflow UI deep link; null when the run was never logged. */
  mlflow_ui_url?: string | null;
};

export type ReliabilityBucket = {
  lower: number;
  upper: number;
  n: number;
  mean_pred: number;
  hit_rate: number;
};

export type BacktestRunDetail = BacktestRunSummary & {
  min_edge: number;
  kelly_fraction: number;
  force_bets: boolean;
  /** (country, competition) pairs the run was restricted to. */
  scope: [string, string][];
  reliability_buckets: ReliabilityBucket[];
};

export type BacktestModel = { name: string; kind: "analytic" | "trainable" | string };

export type CreateBacktestRequest = {
  model: string;
  train_until: string;
  test_until?: string | null;
  min_edge?: number;
  kelly_fraction?: number;
  force_bets?: boolean;
  label?: string | null;
};

/** One placed backtest bet, normalised across the two endpoints that serve them. */
export type RunBet = {
  key: string;
  event_id: string;
  bet_ts: string;
  kickoff: string | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  market: string;
  selection: string;
  price: number | null;
  model_prob: number | null;
  edge: number | null;
  result: number | null;
  pnl: number | null;
};

export type RunBetsPage = { rows: RunBet[]; total: number };

/** Running totals at the end of one betting day (UTC calendar day). */
export type PnlDay = { day: string; bets: number; pnl: number };

/** Cumulative P&L of a run by bet date; `days` is chronological. */
export type PnlCurve = {
  days: PnlDay[];
  first_day: string | null;
  last_day: string | null;
  bets: number;
  pnl: number;
};

const ACTIVE: readonly string[] = ["queued", "running"];

export function isActiveRun(run: Pick<BacktestRunSummary, "status"> | null | undefined): boolean {
  return Boolean(run && ACTIVE.includes(run.status));
}

export const backtestKeys = {
  all: ["backtest"] as const,
  runs: ["backtest", "runs"] as const,
  run: (id: string) => ["backtest", "run", id] as const,
  bets: (id: string, page: number, size: number) => ["backtest", "bets", id, page, size] as const,
  pnl: (id: string) => ["backtest", "pnl", id] as const,
  models: ["backtest", "models"] as const
};

const POLL_MS = 3_000;

/** Run list; polls every 3 s only while something is queued or running. */
export function useBacktestRuns() {
  return useQuery({
    queryKey: backtestKeys.runs,
    queryFn: () => backendGet<{ items: BacktestRunSummary[] }>("backtest/runs", { limit: 200 }).then((r) => r.items),
    refetchInterval: (q) => (q.state.data?.some(isActiveRun) ? POLL_MS : false)
  });
}

export function backtestRunQuery(id: string) {
  return {
    queryKey: backtestKeys.run(id),
    queryFn: () => backendGet<BacktestRunDetail>(`backtest/runs/${encodeURIComponent(id)}`)
  };
}

/** One run with params + reliability; polls while it is queued or running. */
export function useBacktestRun(id: string) {
  return useQuery({
    ...backtestRunQuery(id),
    refetchInterval: (q) => (isActiveRun(q.state.data) ? POLL_MS : false)
  });
}

export function useBacktestRunsById(ids: readonly string[]) {
  return useQueries({ queries: ids.map((id) => backtestRunQuery(id)) });
}

export function useBacktestModels() {
  return useQuery({
    queryKey: backtestKeys.models,
    queryFn: () => backendGet<{ items: BacktestModel[] }>("backtest/models").then((r) => r.items),
    staleTime: 5 * 60_000
  });
}

type HistoryRow = {
  id: string | number;
  event_id: string;
  market: string;
  selection: string;
  recommended_at: string;
  price_at_recommendation: number | null;
  model_prob: number | null;
  edge: number | null;
  result: number | null;
  pnl: number | null;
  home_team?: string | null;
  away_team?: string | null;
  competition?: string | null;
  kickoff?: string | null;
};

type BetRow = {
  event_id: string;
  bet_ts: string;
  kickoff_ts: string;
  market: string;
  selection: string;
  price_taken: number;
  model_prob: number;
  edge: number;
  result: number;
  pnl: number;
};

async function fetchRunBets(runId: string, offset: number, limit: number): Promise<RunBetsPage> {
  const res = await backendGet<{ count: number; rows: HistoryRow[] }>("picks/history", {
    source: "backtest",
    run_id: runId,
    offset,
    limit
  });
  if (res.rows.length === 0 || res.rows.some((r) => "home_team" in r)) {
    return {
      total: res.count,
      rows: res.rows.map((r) => ({
        key: String(r.id),
        event_id: r.event_id,
        bet_ts: r.recommended_at,
        kickoff: r.kickoff ?? null,
        home_team: r.home_team ?? null,
        away_team: r.away_team ?? null,
        competition: r.competition ?? null,
        market: r.market,
        selection: r.selection,
        price: r.price_at_recommendation,
        model_prob: r.model_prob,
        edge: r.edge,
        result: r.result,
        pnl: r.pnl
      }))
    };
  }
  // Backends without team names on backtest history also ignore `offset`
  // there; page through the run's own bet table instead.
  const raw = await backendGet<{ items: BetRow[]; total: number }>(
    `backtest/runs/${encodeURIComponent(runId)}/bets`,
    { offset, limit }
  );
  return {
    total: raw.total,
    rows: raw.items.map((b) => ({
      key: `${b.event_id}_${b.market}_${b.selection}`,
      event_id: b.event_id,
      bet_ts: b.bet_ts,
      kickoff: b.kickoff_ts,
      home_team: null,
      away_team: null,
      competition: null,
      market: b.market,
      selection: b.selection,
      price: b.price_taken,
      model_prob: b.model_prob,
      edge: b.edge,
      result: b.result,
      pnl: b.pnl
    }))
  };
}

/** One page (1-based) of a run's bets, newest first. Enabled once the run completed. */
export function useRunBets(runId: string, page: number, size: number, enabled: boolean) {
  return useQuery({
    queryKey: backtestKeys.bets(runId, page, size),
    queryFn: () => fetchRunBets(runId, (page - 1) * size, size),
    enabled,
    placeholderData: keepPreviousData
  });
}

type DayRow = { day: string; n: number; pnl_total: number | null };

function toCurve(rows: DayRow[]): PnlCurve {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const days: PnlDay[] = [];
  let bets = 0;
  let pnl = 0;
  for (const r of sorted) {
    bets += r.n;
    pnl += r.pnl_total ?? 0;
    days.push({ day: r.day, bets, pnl });
  }
  return {
    days,
    first_day: sorted[0]?.day ?? null,
    last_day: sorted[sorted.length - 1]?.day ?? null,
    bets,
    pnl
  };
}

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));

/**
 * Chart points over bet time: x = whole days since `origin` (YYYY-MM-DD),
 * y = cumulative units. A shared origin keeps several runs on one time axis.
 */
export function curvePoints(curve: PnlCurve, origin: string): { x: number; y: number }[] {
  const start = dayStart(origin);
  return curve.days.map((d) => ({ x: Math.round((dayStart(d.day) - start) / DAY_MS), y: d.pnl }));
}

function runPnlQuery(runId: string) {
  return {
    queryKey: backtestKeys.pnl(runId),
    // Daily aggregates keep the payload small (one row per betting day).
    queryFn: () =>
      backendGet<{ rows: DayRow[] }>("picks/stats", { source: "backtest", run_id: runId, group_by: "day" }).then((r) =>
        toCurve(r.rows)
      )
  };
}

export function useRunPnl(runId: string, enabled: boolean) {
  return useQuery({ ...runPnlQuery(runId), enabled });
}

export function useRunsPnl(runIds: readonly string[], enabled: (id: string) => boolean) {
  return useQueries({ queries: runIds.map((id) => ({ ...runPnlQuery(id), enabled: enabled(id) })) });
}

function useInvalidateBacktests() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: backtestKeys.all });
    qc.invalidateQueries({ queryKey: opsStatusKey });
  };
}

export function useCreateBacktest() {
  const invalidate = useInvalidateBacktests();
  return useMutation({
    mutationFn: (req: CreateBacktestRequest) => backendSend<{ id: string }>("POST", "backtest/runs", req),
    onSuccess: invalidate
  });
}

/** Queued runs are dropped at once; running runs stop at their next checkpoint. */
export function useCancelBacktest() {
  const invalidate = useInvalidateBacktests();
  return useMutation({
    mutationFn: (id: string) => backendSend<unknown>("POST", `backtest/runs/${encodeURIComponent(id)}/cancel`),
    onSuccess: invalidate
  });
}

export function useDeleteBacktest() {
  const qc = useQueryClient();
  const invalidate = useInvalidateBacktests();
  return useMutation({
    mutationFn: (id: string) => backendSend<{ ok: boolean }>("DELETE", `backtest/runs/${encodeURIComponent(id)}`),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: backtestKeys.run(id) });
      invalidate();
    }
  });
}
