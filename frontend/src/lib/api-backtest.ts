"use client";

export type BacktestRunSummary = {
  id: string;
  label: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
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
  mean_clv: number | null;
  brier: number | null;
  log_loss: number | null;
  max_drawdown: number | null;
  stage: string | null;
  market_spec: string;
  sharpe_adjusted: number | null;
  mlflow_run_id: string | null;
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
  scope: [string, string][];
  reliability_buckets: ReliabilityBucket[];
};

export type CreateBacktestRequest = {
  model: string;
  train_until: string;
  test_until?: string | null;
  min_edge?: number;
  kelly_fraction?: number;
  force_bets?: boolean;
  label?: string | null;
  scope?: [string, string][] | null;
  market_spec?: string | null;
};

export async function listBacktestRuns(): Promise<BacktestRunSummary[]> {
  const r = await fetch("/api/backtest/runs", { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).items;
}

export async function getBacktestRun(id: string): Promise<BacktestRunDetail> {
  const r = await fetch(`/api/backtest/runs/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function createBacktestRun(body: CreateBacktestRequest): Promise<{ id: string }> {
  const r = await fetch("/api/backtest/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function deleteBacktestRun(id: string): Promise<void> {
  const r = await fetch(`/api/backtest/runs/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function listBacktestModels(): Promise<string[]> {
  const r = await fetch("/api/backtest/models", { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  const body = await r.json();
  return (body.items as Array<{ name: string; kind: string }>).map((x) => x.name);
}
