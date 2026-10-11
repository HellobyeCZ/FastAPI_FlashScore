"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendGet, backendSend } from "@/lib/api/http";
import { opsStatusKey } from "@/hooks/useOpsStatus";
import type { BulkScrapeJobCreate, BulkScrapeJobList, BulkScrapeJobRow } from "@/types/bulk-scrape";

export const bulkScrapeKeys = {
  all: ["bulk-scrape-jobs"] as const,
  list: (limit: number) => ["bulk-scrape-jobs", limit] as const
};

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
