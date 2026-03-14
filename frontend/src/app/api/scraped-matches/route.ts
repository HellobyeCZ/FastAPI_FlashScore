import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export const runtime = "nodejs";

interface SummaryRow {
  event_id: string;
  event_name: string | null;
  home_team: string | null;
  away_team: string | null;
  sport: string | null;
  country: string | null;
  competition: string | null;
  competition_stage: string | null;
  competition_path: string | null;
  start_time_utc: string | null;
  status: string | null;
  status_detail: string | null;
  outcome: string | null;
  odds_snapshot_count: number | bigint;
  stats_snapshot_count: number | bigint;
  latest_odds_fetched_at: string | null;
  latest_stats_fetched_at: string | null;
}

function trim(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export async function GET() {
  try {
    const rows: SummaryRow[] = await prisma.$queryRawUnsafe(`
      SELECT
        event_id,
        event_name,
        home_team,
        away_team,
        sport,
        country,
        competition,
        competition_stage,
        competition_path,
        start_time_utc,
        status,
        status_detail,
        outcome,
        odds_snapshot_count,
        stats_snapshot_count,
        latest_odds_fetched_at,
        latest_stats_fetched_at
      FROM match_event_summaries
      ORDER BY updated_at DESC
    `);

    const matches: ScrapedMatchSummary[] = rows.map((row) => {
      const homeTeam = trim(row.home_team);
      const awayTeam = trim(row.away_team);
      const eventName =
        trim(row.event_name) ??
        (homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : `Event ${row.event_id}`);

      const latestOddsFetchedAt = trim(row.latest_odds_fetched_at);
      const latestStatsFetchedAt = trim(row.latest_stats_fetched_at);
      const lastFetchedAt =
        latestOddsFetchedAt && latestStatsFetchedAt
          ? latestOddsFetchedAt > latestStatsFetchedAt
            ? latestOddsFetchedAt
            : latestStatsFetchedAt
          : (latestOddsFetchedAt ?? latestStatsFetchedAt ?? new Date(0).toISOString());

      return {
        eventId: row.event_id,
        eventName,
        homeTeam,
        awayTeam,
        sport: trim(row.sport),
        country: trim(row.country),
        competition: trim(row.competition),
        competitionStage: trim(row.competition_stage),
        competitionPath: trim(row.competition_path),
        startTimeUtc: trim(row.start_time_utc),
        status: trim(row.status),
        statusDetail: trim(row.status_detail),
        outcome: trim(row.outcome),
        latestOddsFetchedAt,
        latestStatsFetchedAt,
        lastFetchedAt,
        oddsSnapshotCount: Number(row.odds_snapshot_count),
        statsSnapshotCount: Number(row.stats_snapshot_count)
      };
    });

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
