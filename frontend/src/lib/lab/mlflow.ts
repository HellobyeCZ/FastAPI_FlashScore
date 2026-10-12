"use client";
import { useQuery } from "@tanstack/react-query";
import { ApiError, backendGet } from "@/lib/api/http";
import type { MlflowRun } from "@/types/mlflow";

/**
 * One MLflow run by id (GET /mlflow/runs/{run_id}): 404 when the tracking
 * server doesn't know it, 503 when MLflow is disabled or unreachable.
 *
 * Keyed under "mlflow" so the registry mutations in hooks/useMlflow.ts, which
 * invalidate that prefix, refresh the run's registered versions too.
 */
export function useMlflowRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: ["mlflow", "run", runId ?? ""] as const,
    queryFn: () => backendGet<MlflowRun>(`mlflow/runs/${encodeURIComponent(runId ?? "")}`),
    enabled: Boolean(runId),
    staleTime: 30_000,
    // 404 and 503 are answers, not glitches: show them at once.
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 503)) && count < 1
  });
}

/** True when the backend answered that MLflow is disabled or unreachable. */
export function isMlflowUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

/** True when the tracking server has no run with the requested id. */
export function isMlflowRunMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
