import type { BookmakerOdds, EventOddsSummary, MarketOdds, RawOddsResponse } from "@/types/odds";

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

function resolveApiBaseUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_ODDS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return explicit.replace(/\/+$/, "");
}

function buildOddsUrl(eventId: string): string {
  const apiBaseUrl = resolveApiBaseUrl();
  const encodedEventId = encodeURIComponent(eventId);
  return apiBaseUrl ? `${apiBaseUrl}/odds/${encodedEventId}` : `/odds/${encodedEventId}`;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    if (isObject(payload) && isObject(payload.error) && asString(payload.error.message)) {
      return asString(payload.error.message) as string;
    }
  } catch {
    // Ignore parsing failures and use generic error below.
  }

  return `Odds request failed with status ${response.status}.`;
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
    throw new Error(await parseErrorMessage(response));
  }

  const payload = (await response.json()) as unknown;
  return normalisePayload(payload, eventId);
}
