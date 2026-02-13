"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchBulkScrapeJobs } from "@/lib/api-client";
import type { BulkScrapeJob } from "@/types/bulk-scrape";

interface UseBulkScrapeJobsDataOptions {
  enabled?: boolean;
  limit?: number;
}

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export function useBulkScrapeJobsData({
  enabled = true,
  limit = 20
}: UseBulkScrapeJobsDataOptions = {}) {
  return useQuery<BulkScrapeJob[], Error>({
    queryKey: ["bulk-scrape-jobs", limit],
    queryFn: () => fetchBulkScrapeJobs(limit),
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      return jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status)) ? 3_000 : false;
    }
  });
}
