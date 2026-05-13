import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export const runtime = "nodejs";

function fallbackName(s: ScrapedMatchSummary): string {
  if (s.homeTeam && s.awayTeam) return `${s.homeTeam} vs ${s.awayTeam}`;
  return `Event ${s.eventId}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const take = Math.min(Number(url.searchParams.get("take") ?? "500"), 2000);

  try {
    const rows = await prisma.matchEventSummary.findMany({
      orderBy: { updatedAt: "desc" },
      take
    });

    const matches: ScrapedMatchSummary[] = rows.map((r) => {
      const latestOdds = r.latestOddsFetchedAt ?? undefined;
      const latestStats = r.latestStatsFetchedAt ?? undefined;
      const lastFetchedAt =
        latestOdds && latestStats
          ? (new Date(latestOdds) > new Date(latestStats) ? latestOdds : latestStats)
          : latestOdds ?? latestStats ?? r.updatedAt;
      const item: ScrapedMatchSummary = {
        eventId: r.eventId,
        lastFetchedAt,
        statsSnapshotCount: r.statsSnapshotCount,
        oddsSnapshotCount: r.oddsSnapshotCount,
        latestOddsFetchedAt: latestOdds,
        latestStatsFetchedAt: latestStats,
        eventName: r.eventName ?? undefined,
        homeTeam: r.homeTeam ?? undefined,
        awayTeam: r.awayTeam ?? undefined,
        sport: r.sport ?? undefined,
        country: r.country ?? undefined,
        competition: r.competition ?? undefined,
        competitionStage: r.competitionStage ?? undefined,
        competitionPath: r.competitionPath ?? undefined,
        startTimeUtc: r.startTimeUtc ?? undefined,
        status: r.status ?? undefined,
        statusDetail: r.statusDetail ?? undefined,
        outcome: r.outcome ?? undefined
      };
      item.eventName = item.eventName ?? fallbackName(item);
      return item;
    });

    return NextResponse.json(
      { total: matches.length, matches },
      { headers: { "Cache-Control": "private, max-age=30" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load scraped matches.";
    return NextResponse.json(
      { error: { code: "scraped_matches_load_failed", message } },
      { status: 500 }
    );
  }
}
