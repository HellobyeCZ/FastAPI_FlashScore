import type { BookmakerOdds, EventOddsSummary, MarketOdds, RawOddsResponse } from "@/types/odds";
import type { MatchStatsSummary, RawMatchStatsResponse } from "@/types/match-stats";

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

      for (const outcomeCandidate of asArray(marketCandidate.outcomes)) {
        if (!isObject(outcomeCandidate)) {
          continue;
        }

        const outcomeId =
          asString(outcomeCandidate.id) ??
          asString(outcomeCandidate.selection_key) ??
          `${marketId}-selection-${currentMarket.selections.length + 1}`;

        currentMarket.selections.push({
          bookmakerId,
          bookmakerName,
          selectionId: `${bookmakerId}:${outcomeId}`,
          selectionName: asString(outcomeCandidate.label) ?? "Selection",
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
