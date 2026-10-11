"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendGet, backendSend } from "@/lib/api/http";
import { opsStatusKey } from "@/hooks/useOpsStatus";
import type {
  BulkScrapeJobCreate,
  BulkScrapeJobDetailRow,
  BulkScrapeJobList,
  BulkScrapeJobRow
} from "@/types/bulk-scrape";

export const bulkScrapeKeys = {
  all: ["bulk-scrape-jobs"] as const,
  list: (limit: number) => ["bulk-scrape-jobs", limit] as const,
  detail: (id: number) => ["bulk-scrape-jobs", "detail", id] as const
};

/** Most events GET /bulk-scrape/jobs/{id} returns (its event_limit cap). */
export const JOB_EVENT_LIMIT = 5_000;

const ACTIVE = new Set(["queued", "running"]);

export function isActiveJob(job: Pick<BulkScrapeJobRow, "status">): boolean {
  return ACTIVE.has(job.status);
}

/** Newest jobs first. Polls every 3 s only while a job is queued or running. */
export function useBulkScrapeJobs(limit = 50) {
  return useQuery({
    queryKey: bulkScrapeKeys.list(limit),
    queryFn: () => backendGet<BulkScrapeJobList>("bulk-scrape/jobs", { limit }),
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.jobs.some(isActiveJob) ? 3_000 : false)
  });
}

/**
 * One job with its events, for showing why events failed. Events come back in
 * discovery order, so every event is requested (up to the backend cap) to
 * catch failures anywhere in the job; fetch only on demand.
 */
export function useBulkScrapeJobEvents(job: BulkScrapeJobRow, enabled: boolean) {
  return useQuery({
    queryKey: bulkScrapeKeys.detail(job.id),
    queryFn: () =>
      backendGet<BulkScrapeJobDetailRow>(`bulk-scrape/jobs/${job.id}`, {
        event_limit: Math.min(JOB_EVENT_LIMIT, Math.max(1, job.total_events))
      }),
    enabled,
    // A finished job's events never change.
    staleTime: isActiveJob(job) ? 5_000 : Infinity
  });
}

function useInvalidateJobs() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: bulkScrapeKeys.all });
    qc.invalidateQueries({ queryKey: opsStatusKey });
  };
}

/** Queue a scrape job. Starts upstream requests to FlashScore — confirm first. */
export function useStartBulkScrapeJob() {
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: (body: BulkScrapeJobCreate) => backendSend<BulkScrapeJobRow>("POST", "bulk-scrape/jobs", body),
    onSuccess: invalidate
  });
}

/** Ask the backend to stop a queued/running job (404 when unsupported or unknown). */
export function useCancelBulkScrapeJob() {
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: (id: number) => backendSend<unknown>("POST", `bulk-scrape/jobs/${id}/cancel`),
    onSuccess: invalidate
  });
}
