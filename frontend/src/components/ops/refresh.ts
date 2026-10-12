"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, backendGet, backendSend, toSearch } from "@/lib/api/http";

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

/**
 * Query roots whose fetch scrapes FlashScore (useOddsData, useMatchStatsData).
 * They are only ever fetched on an explicit operator action, never by an
 * invalidation.
 */
const UPSTREAM_QUERY_ROOTS: readonly unknown[] = ["odds", "match-stats"];

export const refreshKeys = {
  list: ["refresh-now", "list"] as const,
  run: (id: string) => ["refresh-now", "run", id] as const
};

/**
 * Refresh state for the Data ops panel: recent runs, the run being followed
 * (polled every 2 s while active) and the start mutation. When a followed run
 * finishes, every cached query except the upstream fetches is invalidated — a
 * refresh changes picks, settlements, fixtures and odds, so no view should keep
 * pre-refresh data.
 *
 * `current` is the followed run, or undefined while its fetch is failing: React
 * Query keeps the last good data on error, and showing a run as still running
 * when its state is unknown would contradict the enabled refresh button. A 404
 * means the backend forgot the run (it keeps them in memory and loses them on
 * restart); `gone` reports that until it is dismissed or a new run starts.
 */
export function useRefreshNow() {
  const qc = useQueryClient();
  const [startedId, setStartedId] = useState<string | null>(null);
  const [goneId, setGoneId] = useState<string | null>(null);

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
    // Polling stops on any error; the panel offers a retry instead.
    refetchInterval: (query) =>
      query.state.status !== "error" && isRunActive(query.state.data?.status) ? 2_000 : false
  });

  const forgotten = run.error instanceof ApiError && run.error.status === 404 ? followId : null;
  useEffect(() => {
    // Keyed on the run id, so a list that keeps naming the forgotten run
    // doesn't refetch in a loop.
    if (forgotten === null) return;
    setGoneId(forgotten);
    setStartedId((id) => (id === forgotten ? null : id));
    qc.invalidateQueries({ queryKey: refreshKeys.list });
  }, [forgotten, qc]);

  // Invalidate once per run, when the backend reports that run finished
  // (data survives a failed poll, so a run that ends during an outage still
  // counts once it loads again).
  const reported = run.data?.status;
  const prev = useRef({ id: followId, status: reported });
  useEffect(() => {
    const last = prev.current;
    prev.current = { id: followId, status: reported };
    if (last.id === followId && isRunActive(last.status) && reported !== undefined && !isRunActive(reported)) {
      qc.invalidateQueries({ predicate: (q) => !UPSTREAM_QUERY_ROOTS.includes(q.queryKey[0]) });
    }
  }, [followId, reported, qc]);

  const current = run.isError ? undefined : run.data;

  const start = useMutation({
    mutationFn: () => backendSend<RefreshRun>("POST", `refresh-now${toSearch(REFRESH_PARAMS)}`),
    onSuccess: (r) => {
      // The backend returns the already-running run instead of starting a second one.
      qc.setQueryData(refreshKeys.run(r.run_id), r);
      setStartedId(r.run_id);
      setGoneId(null);
      qc.invalidateQueries({ queryKey: refreshKeys.list });
    }
  });

  return {
    list,
    run,
    current,
    /** The followed run failed to load for a reason other than being forgotten. */
    runFailing: run.isError && forgotten === null,
    start,
    active: isRunActive(current?.status),
    gone: goneId !== null && goneId !== current?.run_id,
    dismissGone: () => setGoneId(null)
  };
}
