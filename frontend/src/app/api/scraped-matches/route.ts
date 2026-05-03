import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function parseObjectPayload(payload: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractOddsEventName(payload: string): string | undefined {
  const parsed = parseObjectPayload(payload);
  if (!parsed) {
    return undefined;
  }

  const event = isObject(parsed.event) ? parsed.event : undefined;
  return asString(event?.event_name) ?? asString(event?.name);
}

function extractMatchMetadata(payload: string): Partial<ScrapedMatchSummary> {
  const parsed = parseObjectPayload(payload);
  if (!parsed) {
    return {};
  }

  const event = isObject(parsed.event) ? parsed.event : undefined;
  if (!event) {
    return {};
  }

  return {
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
    outcome: asString(event.outcome)
  };
}

function toIso(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

function updateLastFetched(item: ScrapedMatchSummary, candidate: string | undefined): void {
  if (!candidate) {
    return;
  }

  if (!item.lastFetchedAt || new Date(candidate).getTime() > new Date(item.lastFetchedAt).getTime()) {
    item.lastFetchedAt = candidate;
  }
}

function buildFallbackName(item: ScrapedMatchSummary): string {
  if (item.homeTeam && item.awayTeam) {
    return `${item.homeTeam} vs ${item.awayTeam}`;
  }
  return `Event ${item.eventId}`;
}

function byLastFetchedDesc(a: ScrapedMatchSummary, b: ScrapedMatchSummary): number {
  return new Date(b.lastFetchedAt).getTime() - new Date(a.lastFetchedAt).getTime();
}

export async function GET() {
  try {
    const [oddsCounts, statsCounts, latestOddsRows, latestStatsRows] = await Promise.all([
      prisma.oddsSnapshot.groupBy({
        by: ["eventId"],
        _count: { _all: true },
        _max: { fetchedAt: true }
      }),
      prisma.matchStatsSnapshot.groupBy({
        by: ["eventId"],
        _count: { _all: true },
        _max: { fetchedAt: true }
      }),
      prisma.oddsSnapshot.findMany({
        distinct: ["eventId"],
        orderBy: [{ eventId: "asc" }, { fetchedAt: "desc" }, { id: "desc" }],
        select: {
          eventId: true,
          fetchedAt: true,
          oddsPayloadJson: true
        }
      }),
      prisma.matchStatsSnapshot.findMany({
        distinct: ["eventId"],
        orderBy: [{ eventId: "asc" }, { fetchedAt: "desc" }, { id: "desc" }],
        select: {
          eventId: true,
          fetchedAt: true,
          matchStatsPayloadJson: true
        }
      })
    ]);

    const byEvent = new Map<string, ScrapedMatchSummary>();

    const getOrCreate = (eventId: string): ScrapedMatchSummary => {
      const existing = byEvent.get(eventId);
      if (existing) {
        return existing;
      }

      const created: ScrapedMatchSummary = {
        eventId,
        lastFetchedAt: new Date(0).toISOString(),
        statsSnapshotCount: 0,
        oddsSnapshotCount: 0
      };
      byEvent.set(eventId, created);
      return created;
    };

    for (const row of oddsCounts) {
      const item = getOrCreate(row.eventId);
      item.oddsSnapshotCount = row._count._all;
      item.latestOddsFetchedAt = toIso(row._max.fetchedAt);
      updateLastFetched(item, item.latestOddsFetchedAt);
    }

    for (const row of statsCounts) {
      const item = getOrCreate(row.eventId);
      item.statsSnapshotCount = row._count._all;
      item.latestStatsFetchedAt = toIso(row._max.fetchedAt);
      updateLastFetched(item, item.latestStatsFetchedAt);
    }

    for (const row of latestOddsRows) {
      const item = getOrCreate(row.eventId);
      const eventName = extractOddsEventName(row.oddsPayloadJson);
      if (eventName && !item.eventName) {
        item.eventName = eventName;
      }
      updateLastFetched(item, row.fetchedAt.toISOString());
    }

    for (const row of latestStatsRows) {
      const item = getOrCreate(row.eventId);
      const metadata = extractMatchMetadata(row.matchStatsPayloadJson);
      Object.assign(item, {
        homeTeam: metadata.homeTeam ?? item.homeTeam,
        awayTeam: metadata.awayTeam ?? item.awayTeam,
        sport: metadata.sport ?? item.sport,
        country: metadata.country ?? item.country,
        competition: metadata.competition ?? item.competition,
        competitionStage: metadata.competitionStage ?? item.competitionStage,
        competitionPath: metadata.competitionPath ?? item.competitionPath,
        startTimeUtc: metadata.startTimeUtc ?? item.startTimeUtc,
        status: metadata.status ?? item.status,
        statusDetail: metadata.statusDetail ?? item.statusDetail,
        outcome: metadata.outcome ?? item.outcome
      });

      if (!item.eventName && metadata.homeTeam && metadata.awayTeam) {
        item.eventName = `${metadata.homeTeam} vs ${metadata.awayTeam}`;
      }
      updateLastFetched(item, row.fetchedAt.toISOString());
    }

    const matches = Array.from(byEvent.values())
      .map((item) => ({
        ...item,
        eventName: item.eventName ?? buildFallbackName(item)
      }))
      .sort(byLastFetchedDesc);

    return NextResponse.json({
      total: matches.length,
      matches
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load scraped matches.";
    return NextResponse.json(
      {
        error: {
          code: "scraped_matches_load_failed",
          message
        }
      },
      { status: 500 }
    );
  }
}
