/**
 * Bulk-scrape job client (Next.js /api/bulk-scrape proxy). Match odds, stats
 * and the stored-matches index moved to React Query hooks in lib/matches.
 */
import type {
  BulkScrapeJob,
  BulkScrapeJobDetail,
  BulkScrapeJobEvent,
  StartBulkScrapeJobPayload
} from "@/types/bulk-scrape";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  return 0;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
}

function buildBulkScrapeJobsUrl(limit = 20): string {
  const query = new URLSearchParams({ limit: String(limit) });
  return `/api/bulk-scrape/jobs?${query.toString()}`;
}

function buildBulkScrapeJobUrl(jobId: number, includeEvents = true, eventLimit = 500): string {
  const query = new URLSearchParams({
    include_events: includeEvents ? "true" : "false",
    event_limit: String(eventLimit)
  });
  return `/api/bulk-scrape/jobs/${encodeURIComponent(String(jobId))}?${query.toString()}`;
}

function normaliseBulkScrapeJob(candidate: unknown): BulkScrapeJob | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const id = asInteger(candidate.id);
  const competitionPath = asString(candidate.competition_path);
  const status = asString(candidate.status);
  const createdAt = asString(candidate.created_at);
  const updatedAt = asString(candidate.updated_at);
  if (!id || !competitionPath || !status || !createdAt || !updatedAt) {
    return undefined;
  }

  const job: BulkScrapeJob = {
    id,
    competitionPath,
    seasons: asInteger(candidate.seasons),
    includeStats: asBoolean(candidate.include_stats),
    includeOdds: asBoolean(candidate.include_odds),
    maxConcurrency: asInteger(candidate.max_concurrency),
    status,
    createdAt,
    updatedAt,
    totalEvents: asInteger(candidate.total_events),
    pendingEvents: asInteger(candidate.pending_events),
    runningEvents: asInteger(candidate.running_events),
    succeededEvents: asInteger(candidate.succeeded_events),
    failedEvents: asInteger(candidate.failed_events),
    skippedEvents: asInteger(candidate.skipped_events)
  };

  const startedAt = asString(candidate.started_at);
  const finishedAt = asString(candidate.finished_at);
  const lastError = asString(candidate.last_error);
  if (startedAt) job.startedAt = startedAt;
  if (finishedAt) job.finishedAt = finishedAt;
  if (lastError) job.lastError = lastError;

  return job;
}

function normaliseBulkScrapeJobEvent(candidate: unknown): BulkScrapeJobEvent | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const eventId = asString(candidate.event_id);
  const status = asString(candidate.status);
  const createdAt = asString(candidate.created_at);
  const updatedAt = asString(candidate.updated_at);
  if (!eventId || !status || !createdAt || !updatedAt) {
    return undefined;
  }

  const event: BulkScrapeJobEvent = {
    eventId,
    status,
    attempts: asInteger(candidate.attempts),
    createdAt,
    updatedAt
  };

  const seasonPath = asString(candidate.season_path);
  const skippedReason = asString(candidate.skipped_reason);
  const lastError = asString(candidate.last_error);
  const startedAt = asString(candidate.started_at);
  const finishedAt = asString(candidate.finished_at);
  if (seasonPath) event.seasonPath = seasonPath;
  if (skippedReason) event.skippedReason = skippedReason;
  if (lastError) event.lastError = lastError;
  if (startedAt) event.startedAt = startedAt;
  if (finishedAt) event.finishedAt = finishedAt;

  return event;
}

function normaliseBulkScrapeJobsPayload(payload: unknown): BulkScrapeJob[] {
  const root = isObject(payload) ? payload : undefined;
  const jobs = root && Array.isArray(root.jobs) ? root.jobs : [];
  return jobs
    .map((candidate) => normaliseBulkScrapeJob(candidate))
    .filter((candidate): candidate is BulkScrapeJob => Boolean(candidate));
}

function normaliseBulkScrapeJobDetailPayload(payload: unknown): BulkScrapeJobDetail {
  const root = isObject(payload) ? payload : undefined;
  const base = normaliseBulkScrapeJob(root);
  if (!base) {
    throw new Error("Unexpected bulk scrape job response format.");
  }

  const events = Array.isArray(root?.events) ? root.events : [];
  return {
    ...base,
    events: events
      .map((candidate) => normaliseBulkScrapeJobEvent(candidate))
      .filter((candidate): candidate is BulkScrapeJobEvent => Boolean(candidate))
  };
}

async function parseErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    if (isObject(payload) && isObject(payload.error) && asString(payload.error.message)) {
      return asString(payload.error.message) as string;
    }
  } catch {
    // Ignore parsing failures and use generic error below.
  }

  return `${fallbackMessage} (${response.status}).`;
}

export async function fetchBulkScrapeJobs(limit = 20): Promise<BulkScrapeJob[]> {
  const response = await fetch(buildBulkScrapeJobsUrl(limit), {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Bulk scrape jobs request failed"));
  }

  const payload = (await response.json()) as unknown;
  return normaliseBulkScrapeJobsPayload(payload);
}

export async function fetchBulkScrapeJob(
  jobId: number,
  options?: { includeEvents?: boolean; eventLimit?: number }
): Promise<BulkScrapeJobDetail> {
  const response = await fetch(
    buildBulkScrapeJobUrl(jobId, options?.includeEvents ?? true, options?.eventLimit ?? 500),
    {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Bulk scrape job request failed"));
  }

  const payload = (await response.json()) as unknown;
  return normaliseBulkScrapeJobDetailPayload(payload);
}

export async function startBulkScrapeJob(payload: StartBulkScrapeJobPayload): Promise<BulkScrapeJob> {
  const response = await fetch("/api/bulk-scrape/jobs", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      competition_path: payload.competitionPath,
      seasons: payload.seasons ?? 5,
      include_stats: payload.includeStats ?? true,
      include_odds: payload.includeOdds ?? true,
      max_concurrency: payload.maxConcurrency ?? 4
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Bulk scrape start request failed"));
  }

  const json = (await response.json()) as unknown;
  const job = normaliseBulkScrapeJob(json);
  if (!job) {
    throw new Error("Unexpected response format when creating bulk scrape job.");
  }
  return job;
}
