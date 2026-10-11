import type { BulkScrapeJobCreate, BulkScrapeJobRow } from "@/types/bulk-scrape";

/** Form limits. The backend accepts more; these keep a manual backfill sane. */
export const SEASONS = { min: 1, max: 10, initial: 5 } as const;
export const CONCURRENCY = { min: 1, max: 8, initial: 4 } as const;

const SEGMENT = /^[a-z0-9-]+$/i;
const PAGE_SUFFIXES = ["/archive", "/results", "/fixtures", "/standings"];

/**
 * Mirrors FlashscoreDiscoveryClient._normalize_competition_path: accepts a
 * bare path or a full URL, drops the page suffix and surrounding slashes.
 * Returns null when what is left is not a slash-separated list of
 * letters/digits/hyphens (e.g. "nhl" or "football/england/premier-league").
 */
export function normalizeCompetitionPath(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate) return null;
  if (candidate.includes("://")) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      return null;
    }
  }
  candidate = candidate.replace(/^\/+|\/+$/g, "");
  const suffix = PAGE_SUFFIXES.find((s) => candidate.endsWith(s));
  if (suffix) candidate = candidate.slice(0, -suffix.length).replace(/\/+$/, "");
  if (!candidate) return null;
  return candidate.split("/").every((s) => SEGMENT.test(s)) ? candidate.toLowerCase() : null;
}

export type ScrapeForm = {
  path: string;
  seasons: string;
  concurrency: string;
  includeStats: boolean;
  includeOdds: boolean;
};

export const INITIAL_FORM: ScrapeForm = {
  path: "",
  seasons: String(SEASONS.initial),
  concurrency: String(CONCURRENCY.initial),
  includeStats: true,
  includeOdds: true
};

export type ScrapeFormErrors = Partial<
  Record<"path" | "seasons" | "concurrency" | "include", "required" | "format" | "range" | "none">
>;

function intInRange(raw: string, { min, max }: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** Validates the form; returns the request body or the errors to show. */
export function validateScrapeForm(
  form: ScrapeForm
): { ok: true; body: BulkScrapeJobCreate } | { ok: false; errors: ScrapeFormErrors } {
  const errors: ScrapeFormErrors = {};
  const path = normalizeCompetitionPath(form.path);
  if (!form.path.trim()) errors.path = "required";
  else if (!path) errors.path = "format";
  const seasons = intInRange(form.seasons, SEASONS);
  if (seasons === null) errors.seasons = "range";
  const concurrency = intInRange(form.concurrency, CONCURRENCY);
  if (concurrency === null) errors.concurrency = "range";
  if (!form.includeStats && !form.includeOdds) errors.include = "none";
  if (Object.keys(errors).length > 0 || !path || seasons === null || concurrency === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      competition_path: path,
      seasons,
      include_stats: form.includeStats,
      include_odds: form.includeOdds,
      max_concurrency: concurrency
    }
  };
}

export type ScrapeEstimate = {
  /** Expected number of events the job will discover. */
  events: number;
  basis: BulkScrapeJobRow;
  /** True when the basis job covered a different number of seasons. */
  scaled: boolean;
};

/**
 * Event count expected for a new job, from the latest earlier job on the same
 * competition that discovered events. Prefers a job with the same number of
 * seasons; otherwise scales the closest one linearly by seasons.
 */
export function estimateEvents(jobs: BulkScrapeJobRow[], body: BulkScrapeJobCreate): ScrapeEstimate | null {
  const candidates = jobs.filter(
    (j) => j.total_events > 0 && normalizeCompetitionPath(j.competition_path) === body.competition_path
  );
  if (candidates.length === 0) return null;
  const newest = (a: BulkScrapeJobRow, b: BulkScrapeJobRow) => b.id - a.id;
  const exact = candidates.filter((j) => j.seasons === body.seasons).sort(newest)[0];
  if (exact) return { events: exact.total_events, basis: exact, scaled: false };
  const closest = [...candidates].sort(
    (a, b) => Math.abs(a.seasons - body.seasons) - Math.abs(b.seasons - body.seasons) || newest(a, b)
  )[0];
  return {
    events: Math.round((closest.total_events * body.seasons) / Math.max(1, closest.seasons)),
    basis: closest,
    scaled: true
  };
}

/** Distinct competitions of the most recent jobs, newest first. */
export function recentPaths(jobs: BulkScrapeJobRow[], limit = 5): string[] {
  const seen: string[] = [];
  for (const j of [...jobs].sort((a, b) => b.id - a.id)) {
    const p = normalizeCompetitionPath(j.competition_path) ?? j.competition_path;
    if (!seen.includes(p)) seen.push(p);
    if (seen.length === limit) break;
  }
  return seen;
}

/**
 * One-line summary of a job error for the table. Discovery errors embed the
 * full FlashScore URL and often end in ": " with no reason, which says nothing
 * at table width; the full text stays available behind a disclosure.
 */
export function summarizeJobError(error: string): string {
  const first = error.split("\n")[0] ?? error;
  return first
    .replace(/https?:\/\/(www\.)?flashscore\.[a-z.]+\//gi, "")
    .replace(/[:\s]+$/, "")
    .trim();
}
