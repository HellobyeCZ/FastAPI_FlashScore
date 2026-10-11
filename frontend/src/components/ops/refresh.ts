"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendGet, backendSend, toSearch } from "@/lib/api/http";

/**
 * One-button refresh (app/services/refresh_now.py):
 * scrape upcoming odds → rebuild labels/closing odds/Elo → settle → record picks.
 * Runs live in backend memory, so history resets when FastAPI restarts.
 */
export const REFRESH_STAGES = ["scrape", "phase1", "settle", "predict"] as const;
export type RefreshStage = (typeof REFRESH_STAGES)[number];
export type RefreshStatus = "queued" | RefreshStage | "done" | "error";

export type RefreshStageBlock = { state?: "running" | "done" } & Record<string, unknown>;

export type RefreshRun = {
  run_id: string;
  status: RefreshStatus;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number;
  stage_progress: Partial<Record<RefreshStage, RefreshStageBlock>>;
  error: string | null;
  summary: Partial<Record<RefreshStage, Record<string, unknown>>>;
};

export type RefreshRunList = { active_run_id: string | null; runs: RefreshRun[] };

/**
 * Parameters sent explicitly (rather than relying on backend defaults) so the
 * confirmation can state exactly what a refresh will do.
 */
export const REFRESH_PARAMS = { window_days: 7, max_concurrency: 4, hours_ahead: 72, min_edge: 0.02 } as const;

export type StageState = "pending" | "running" | "done" | "failed" | "skipped";

export function isRunActive(status: RefreshStatus | undefined): boolean {
  return status !== undefined && status !== "done" && status !== "error";
}

/**
 * Per-stage state. The backend marks a stage "running" before it starts and
 * "done" when it succeeds, so on error the stage still marked running is the
 * one that failed and stages without a block were never reached.
 */
export function stageState(run: RefreshRun, stage: RefreshStage): StageState {
  const block = run.stage_progress[stage];
  if (block?.state === "done") return "done";
  if (block?.state === "running") return run.status === "error" ? "failed" : "running";
  return run.status === "error" ? "skipped" : "pending";
}

export const refreshKeys = {
  all: ["refresh-now"] as const,
  list: ["refresh-now", "list"] as const,
  run: (id: string) => ["refresh-now", "run", id] as const
};

/**
 * Refresh state for the Data ops panel: recent runs, the run being followed
 * (polled every 2 s while active) and the start mutation. When a followed run
 * finishes, every cached query is invalidated — a refresh changes picks,
 * settlements, fixtures and odds, so no view should keep pre-refresh data.
 */
export function useRefreshNow() {
  const qc = useQueryClient();
  const [startedId, setStartedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: refreshKeys.list,
    queryFn: () => backendGet<RefreshRunList>("refresh-now"),
    staleTime: 10_000
  });

  const followId = startedId ?? list.data?.active_run_id ?? list.data?.runs[0]?.run_id ?? null;

  const run = useQuery({
    queryKey: refreshKeys.run(followId ?? ""),
    queryFn: () => backendGet<RefreshRun>(`refresh-now/${encodeURIComponent(followId!)}`),
    enabled: followId !== null,
    // Seeded from the list; a finished run never changes, and an active one is
    // kept current by the interval below, so no staleness refetch is needed.
    initialData: () => list.data?.runs.find((r) => r.run_id === followId),
    initialDataUpdatedAt: () => list.dataUpdatedAt,
    staleTime: Infinity,
    refetchInterval: (query) => (isRunActive(query.state.data?.status) ? 2_000 : false)
  });

  const status = run.data?.status;
  const prevStatus = useRef(status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (isRunActive(prev) && !isRunActive(status)) {
      qc.invalidateQueries();
    }
  }, [status, qc]);

  const start = useMutation({
    mutationFn: () => backendSend<RefreshRun>("POST", `refresh-now${toSearch(REFRESH_PARAMS)}`),
    onSuccess: (r) => {
      // The backend returns the already-running run instead of starting a second one.
      qc.setQueryData(refreshKeys.run(r.run_id), r);
      setStartedId(r.run_id);
      qc.invalidateQueries({ queryKey: refreshKeys.list });
    }
  });

  return { list, run, start, active: isRunActive(status) };
}
