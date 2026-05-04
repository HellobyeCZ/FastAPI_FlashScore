import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The competition-browser tree on the dashboard groups every event by sport
// → country → competition → season, so it needs the full set. With 52K rows
// the JSON payload is ~12 MB — fine for a one-shot dashboard load and faster
// than paginating client-side. Cap at 100K so a runaway dataset can't OOM.
const MAX_LIMIT = 100_000;
const DEFAULT_LIMIT = MAX_LIMIT;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function buildFallbackName(row: {
  eventName: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  eventId: string;
}): string {
  if (row.eventName) return row.eventName;
  if (row.homeTeam && row.awayTeam) return `${row.homeTeam} vs ${row.awayTeam}`;
  return `Event ${row.eventId}`;
}

function pickLastFetched(
  oddsAt: Date | null,
  statsAt: Date | null,
  fallback: Date,
): string {
  const candidates = [oddsAt, statsAt, fallback].filter(
    (d): d is Date => d instanceof Date,
  );
  const newest = candidates.reduce(
    (acc, d) => (d.getTime() > acc.getTime() ? d : acc),
    candidates[0] ?? new Date(0),
  );
  return newest.toISOString();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const offset = parseOffset(url.searchParams.get("offset"));

    // MatchEventSummary is a pre-aggregated index of all events with their
    // metadata, snapshot counts, and latest fetch timestamps. Reading from it
    // is O(limit) regardless of how many snapshots exist (52K events at the
    // time of writing), unlike the previous implementation that fetched
    // every event's full payload and grouped in memory (heap-OOM risk).

    const [total, rows] = await Promise.all([
      prisma.matchEventSummary.count(),
      prisma.matchEventSummary.findMany({
        orderBy: [{ updatedAt: "desc" }, { eventId: "asc" }],
        take: limit,
        skip: offset,
      }),
    ]);

    const matches: ScrapedMatchSummary[] = rows.map((row) => ({
      eventId: row.eventId,
      eventName: buildFallbackName(row),
      homeTeam: row.homeTeam ?? undefined,
      awayTeam: row.awayTeam ?? undefined,
      sport: row.sport ?? undefined,
      country: row.country ?? undefined,
      competition: row.competition ?? undefined,
      competitionStage: row.competitionStage ?? undefined,
      competitionPath: row.competitionPath ?? undefined,
      startTimeUtc: row.startTimeUtc?.toISOString(),
      status: row.status ?? undefined,
      statusDetail: row.statusDetail ?? undefined,
      outcome: row.outcome ?? undefined,
      oddsSnapshotCount: row.oddsSnapshotCount,
      statsSnapshotCount: row.statsSnapshotCount,
      latestOddsFetchedAt: row.latestOddsFetchedAt?.toISOString(),
      latestStatsFetchedAt: row.latestStatsFetchedAt?.toISOString(),
      lastFetchedAt: pickLastFetched(
        row.latestOddsFetchedAt,
        row.latestStatsFetchedAt,
        row.updatedAt,
      ),
    }));

    return NextResponse.json({ total, matches, limit, offset });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load scraped matches.";
    return NextResponse.json(
      { error: { code: "scraped_matches_load_failed", message } },
      { status: 500 },
    );
  }
}
