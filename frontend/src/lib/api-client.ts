import type { BookmakerOdds, EventOddsSummary, MarketOdds, RawOddsResponse } from "@/types/odds";
import type { MatchStatsSummary, RawMatchStatsResponse } from "@/types/match-stats";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
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

function normaliseLegacyResponse(raw: RawOddsResponse, fallbackEventId: string): EventOddsSummary {
  const event = isObject(raw.event) ? raw.event : {};
  const markets: MarketOdds[] = [];

  for (const marketCandidate of asArray(raw.markets)) {
    if (!isObject(marketCandidate)) {
      continue;
    }

    const marketId = asString(marketCandidate.id) ?? `market-${markets.length + 1}`;
    const marketName = asString(marketCandidate.name) ?? "Market";
    const selections: BookmakerOdds[] = [];

    for (const selectionCandidate of asArray(marketCandidate.selections)) {
      if (!isObject(selectionCandidate)) {
        continue;
      }

      const bookmaker = isObject(selectionCandidate.bookmaker) ? selectionCandidate.bookmaker : {};
      const bookmakerId = asString(bookmaker.id) ?? "unknown-bookmaker";
      const selectionId = asString(selectionCandidate.id) ?? `${marketId}-selection-${selections.length + 1}`;

      selections.push({
        bookmakerId,
        bookmakerName: asString(bookmaker.name) ?? "Unknown bookmaker",
        selectionId,
        selectionName: asString(selectionCandidate.name) ?? "Selection",
        odds: asNumber(selectionCandidate.odds),
        updatedAt: asString(selectionCandidate.updatedAt)
      });
    }

    if (selections.length > 0) {
      markets.push({
        marketId,
        marketName,
        selections
      });
    }
  }

  return {
    eventId: asString(event.id) ?? fallbackEventId,
    eventName: asString(event.name) ?? `Event ${asString(event.id) ?? fallbackEventId}`,
    markets,
    lastUpdated: asString(raw.lastUpdate)
  };
}

// FlashScore's structured payload labels each outcome with an opaque id
// (e.g. "YBKVe7y0") rather than a human-readable selection name. Recover a
// readable label from the market key + outcome position, falling back to the
// raw label when the payload actually contains one.
function inferOutcomeLabel(
  marketKey: string | undefined,
  rawLabel: string | undefined,
  position: number,
): string {
  // Heuristic: when the raw label looks like an opaque id (alphanumeric, no
  // spaces, mixed case) we replace it. "Over", "Under", "Yes", "No", "1.5",
  // "Selection" etc. all pass through unchanged on the contains-space check
  // first, then we still strip the "looks-like-id" forms.
  const isOpaqueId =
    !rawLabel ||
    rawLabel === "Selection" ||
    (/^[A-Za-z0-9]{6,}$/.test(rawLabel) && /[a-z]/.test(rawLabel) && /[A-Z]/.test(rawLabel));

  if (!isOpaqueId) return rawLabel as string;

  const key = (marketKey ?? "").toUpperCase();
  const prefix = key.split(":")[0];

  switch (prefix) {
    case "HOME_DRAW_AWAY":
      return ["1", "X", "2"][position] ?? `Selection ${position + 1}`;
    case "DRAW_NO_BET":
      return ["1", "2"][position] ?? `Selection ${position + 1}`;
    case "DOUBLE_CHANCE":
      return ["1X", "12", "X2"][position] ?? `Selection ${position + 1}`;
    case "OVER_UNDER":
    case "TOTAL_GOALS":
      return ["Over", "Under"][position] ?? `Selection ${position + 1}`;
    case "BOTH_TEAMS_TO_SCORE":
    case "BTTS":
      return ["Yes", "No"][position] ?? `Selection ${position + 1}`;
    case "ODD_EVEN":
      return ["Odd", "Even"][position] ?? `Selection ${position + 1}`;
    case "ASIAN_HANDICAP":
    case "EUROPEAN_HANDICAP":
      return ["Home", "Away"][position] ?? `Selection ${position + 1}`;
    default:
      return `Selection ${position + 1}`;
  }
}

function normaliseStructuredResponse(payload: JsonObject, fallbackEventId: string): EventOddsSummary {
  const event = isObject(payload.event) ? payload.event : {};
  const marketMap = new Map<string, MarketOdds>();
  const bookmakers = asArray(event.bookmakers);

  for (let bookmakerIndex = 0; bookmakerIndex < bookmakers.length; bookmakerIndex += 1) {
    const bookmakerCandidate = bookmakers[bookmakerIndex];
    if (!isObject(bookmakerCandidate)) {
      continue;
    }

    const bookmakerId = asString(bookmakerCandidate.id) ?? `bookmaker-${bookmakerIndex + 1}`;
    const bookmakerName = asString(bookmakerCandidate.name) ?? "Unknown bookmaker";

    for (const marketCandidate of asArray(bookmakerCandidate.markets)) {
      if (!isObject(marketCandidate)) {
        continue;
      }

      const marketId =
        asString(marketCandidate.id) ??
        asString(marketCandidate.key) ??
        `market-${marketMap.size + 1}`;
      const marketName = asString(marketCandidate.name) ?? "Market";

      const currentMarket = marketMap.get(marketId) ?? {
        marketId,
        marketName,
        selections: []
      };

      const outcomes = asArray(marketCandidate.outcomes);
      for (let position = 0; position < outcomes.length; position += 1) {
        const outcomeCandidate = outcomes[position];
        if (!isObject(outcomeCandidate)) {
          continue;
        }

        const outcomeId =
          asString(outcomeCandidate.id) ??
          asString(outcomeCandidate.selection_key) ??
          `${marketId}-selection-${currentMarket.selections.length + 1}`;

        const marketKey =
          asString(marketCandidate.key) ?? asString(marketCandidate.id) ?? undefined;
        const selectionName = inferOutcomeLabel(
          marketKey,
          asString(outcomeCandidate.label),
          position,
        );

        currentMarket.selections.push({
          bookmakerId,
          bookmakerName,
          selectionId: `${bookmakerId}:${outcomeId}`,
          selectionName,
          odds: asNumber(outcomeCandidate.odds_decimal),
          updatedAt: asString(payload.retrieved_at)
        });
      }

      if (currentMarket.selections.length > 0) {
        marketMap.set(marketId, currentMarket);
      }
    }
  }

  const eventId = asString(event.event_id) ?? fallbackEventId;
  return {
    eventId,
    eventName: asString(event.event_name) ?? `Event ${eventId}`,
    markets: Array.from(marketMap.values()),
    lastUpdated: asString(payload.retrieved_at)
  };
}

function normalisePayload(payload: unknown, fallbackEventId: string): EventOddsSummary {
  if (!isObject(payload)) {
    throw new Error("Unexpected odds response format.");
  }

  if (Array.isArray(payload.markets)) {
    return normaliseLegacyResponse(payload as RawOddsResponse, fallbackEventId);
  }

  if (isObject(payload.event) && Array.isArray((payload.event as JsonObject).bookmakers)) {
    return normaliseStructuredResponse(payload, fallbackEventId);
  }

  throw new Error("Unsupported odds response shape.");
}

function buildOddsUrl(eventId: string): string {
  const encodedEventId = encodeURIComponent(eventId);
  return `/api/odds/${encodedEventId}`;
}

function normaliseMatchStatsPayload(payload: unknown, fallbackEventId: string): MatchStatsSummary {
  if (!isObject(payload)) {
    throw new Error("Unexpected match stats response format.");
  }

  const raw = payload as RawMatchStatsResponse;
  const event = isObject(raw.event) ? raw.event : {};
  const periods = asArray(event.periods)
    .map((periodCandidate, periodIndex) => {
      if (!isObject(periodCandidate)) {
        return undefined;
      }

      const categories = asArray(periodCandidate.categories)
        .map((categoryCandidate, categoryIndex) => {
          if (!isObject(categoryCandidate)) {
            return undefined;
          }

          const stats = asArray(categoryCandidate.stats)
            .map((statCandidate) => {
              if (!isObject(statCandidate)) {
                return undefined;
              }

              const label = asString(statCandidate.label);
              const home = asString(statCandidate.home);
              const away = asString(statCandidate.away);

              if (!label || !home || !away) {
                return undefined;
              }

              return {
                code: asString(statCandidate.code),
                label,
                home,
                away
              };
            })
            .filter((stat): stat is NonNullable<typeof stat> => Boolean(stat));

          if (!stats.length) {
            return undefined;
          }

          return {
            name: asString(categoryCandidate.name) ?? `Category ${categoryIndex + 1}`,
            stats
          };
        })
        .filter((category): category is NonNullable<typeof category> => Boolean(category));

      if (!categories.length) {
        return undefined;
      }

      return {
        name: asString(periodCandidate.name) ?? `Period ${periodIndex + 1}`,
        categories
      };
    })
    .filter((period): period is NonNullable<typeof period> => Boolean(period));

  const eventId = asString(event.event_id) ?? fallbackEventId;
  return {
    eventId,
    homeTeam: asString(event.home_team),
    awayTeam: asString(event.away_team),
    sport: asString(event.sport),
    country: asString(event.country),
    competition: asString(event.competition),
    competitionStage: asString(event.competition_stage),
    competitionPath: asString(event.competition_path),
    startTimeUtc: asString(event.start_time_utc),
    status: asString(event.status),
    statusDetail: asString(event.status_detail),
    outcome: asString(event.outcome),
    periods,
    lastUpdated: asString(raw.retrieved_at),
    source: asString(raw.source)
  };
}

function buildMatchStatsUrl(eventId: string): string {
  const encodedEventId = encodeURIComponent(eventId);
  return `/api/match-stats/${encodedEventId}`;
}

function buildScrapedMatchesUrl(): string {
  return "/api/scraped-matches";
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

function normaliseScrapedMatchesPayload(payload: unknown): ScrapedMatchSummary[] {
  const root = isObject(payload) ? payload : undefined;
  const candidates = root && Array.isArray(root.matches) ? root.matches : [];
  const matches: ScrapedMatchSummary[] = [];

  for (const candidate of candidates) {
    if (!isObject(candidate)) {
      continue;
    }

    const eventId = asString(candidate.eventId);
    const lastFetchedAt = asString(candidate.lastFetchedAt);
    if (!eventId || !lastFetchedAt) {
      continue;
    }

    const normalised: ScrapedMatchSummary = {
      eventId,
      lastFetchedAt,
      statsSnapshotCount: asInteger(candidate.statsSnapshotCount),
      oddsSnapshotCount: asInteger(candidate.oddsSnapshotCount)
    };

    const eventName = asString(candidate.eventName);
    const homeTeam = asString(candidate.homeTeam);
    const awayTeam = asString(candidate.awayTeam);
    const sport = asString(candidate.sport);
    const country = asString(candidate.country);
    const competition = asString(candidate.competition);
    const competitionStage = asString(candidate.competitionStage);
    const competitionPath = asString(candidate.competitionPath);
    const startTimeUtc = asString(candidate.startTimeUtc);
    const status = asString(candidate.status);
    const statusDetail = asString(candidate.statusDetail);
    const outcome = asString(candidate.outcome);
    const latestStatsFetchedAt = asString(candidate.latestStatsFetchedAt);
    const latestOddsFetchedAt = asString(candidate.latestOddsFetchedAt);

    if (eventName) normalised.eventName = eventName;
    if (homeTeam) normalised.homeTeam = homeTeam;
    if (awayTeam) normalised.awayTeam = awayTeam;
    if (sport) normalised.sport = sport;
    if (country) normalised.country = country;
    if (competition) normalised.competition = competition;
    if (competitionStage) normalised.competitionStage = competitionStage;
    if (competitionPath) normalised.competitionPath = competitionPath;
    if (startTimeUtc) normalised.startTimeUtc = startTimeUtc;
    if (status) normalised.status = status;
    if (statusDetail) normalised.statusDetail = statusDetail;
    if (outcome) normalised.outcome = outcome;
    if (latestStatsFetchedAt) normalised.latestStatsFetchedAt = latestStatsFetchedAt;
    if (latestOddsFetchedAt) normalised.latestOddsFetchedAt = latestOddsFetchedAt;

    matches.push(normalised);
  }

  return matches;
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

export async function fetchEventOdds(eventId: string): Promise<EventOddsSummary> {
  const response = await fetch(buildOddsUrl(eventId), {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Odds request failed"));
  }

  const payload = (await response.json()) as unknown;
  return normalisePayload(payload, eventId);
}

export async function fetchEventMatchStats(eventId: string): Promise<MatchStatsSummary> {
  const response = await fetch(buildMatchStatsUrl(eventId), {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Match stats request failed"));
  }

  const payload = (await response.json()) as unknown;
  return normaliseMatchStatsPayload(payload, eventId);
}

export async function fetchScrapedMatches(): Promise<ScrapedMatchSummary[]> {
  const response = await fetch(buildScrapedMatchesUrl(), {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Scraped matches request failed"));
  }

  const payload = (await response.json()) as unknown;
  return normaliseScrapedMatchesPayload(payload);
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
