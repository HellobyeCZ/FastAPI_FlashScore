/**
 * Bulk scrape jobs — FastAPI wire contract (app/schemas/bulk_scrape.py),
 * reached through the /api/backend proxy. Timestamps are ISO-8601 UTC.
 */
export type BulkScrapeJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

export type BulkScrapeJobRow = {
  id: number;
  competition_path: string;
  seasons: number;
  include_stats: boolean;
  include_odds: boolean;
  max_concurrency: number;
  status: BulkScrapeJobStatus | string;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  last_error: string | null;
  total_events: number;
  pending_events: number;
  running_events: number;
  succeeded_events: number;
  failed_events: number;
  skipped_events: number;
};

/** One event of a job, as listed by GET /bulk-scrape/jobs/{id}. */
export type BulkScrapeEventRow = {
  event_id: string;
  season_path: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  attempts: number;
  skipped_reason: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
};

/** GET /bulk-scrape/jobs/{id}: the job plus its first `event_limit` events (by id). */
export type BulkScrapeJobDetailRow = BulkScrapeJobRow & { events: BulkScrapeEventRow[] };

export type BulkScrapeJobList = {
  total: number;
  jobs: BulkScrapeJobRow[];
};

/** POST /bulk-scrape/jobs body. */
export type BulkScrapeJobCreate = {
  competition_path: string;
  seasons: number;
  include_stats: boolean;
  include_odds: boolean;
  max_concurrency: number;
};
