import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { Prisma } from "@prisma/client";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export const runtime = "nodejs";

type SortKey = "last_fetch_desc" | "kickoff_desc" | "kickoff_asc" | "snaps_desc";

// "last fetch" in the UI is max(latestOdds, latestStats, updatedAt).
// SQLite via Prisma can't express GREATEST(...) directly in orderBy, so
// approximate it: order by the strictly-newer of the two scrape timestamps
// first (nulls last so rows that have only one column populated still rank
// by the populated one), then fall back to updatedAt. This matches what
// the displayed value resolves to for ~all rows in practice.
const SORT_KEYS: Record<SortKey, Prisma.MatchEventSummaryOrderByWithRelationInput[]> = {
  last_fetch_desc: [
    { latestOddsFetchedAt: { sort: "desc", nulls: "last" } },
    { latestStatsFetchedAt: { sort: "desc", nulls: "last" } },
    { updatedAt: "desc" },
    { eventId: "desc" },
  ],
  kickoff_desc: [{ startTimeUtc: "desc" }, { eventId: "desc" }],
  kickoff_asc: [{ startTimeUtc: "asc" }, { eventId: "asc" }],
  snaps_desc: [{ oddsSnapshotCount: "desc" }, { eventId: "desc" }],
};

function statusToKind(raw?: string | null): "LIVE" | "FT" | "SCHED" {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("live") || s.includes("in_play") || s.includes("running")) return "LIVE";
  if (s.includes("finished") || s.includes("ft") || s.includes("ended") || s.includes("completed"))
    return "FT";
  return "SCHED";
}

function fallbackName(s: ScrapedMatchSummary): string {
  if (s.homeTeam && s.awayTeam) return `${s.homeTeam} vs ${s.awayTeam}`;
  return `Event ${s.eventId}`;
}

function toSummary(r: {
  eventId: string;
  eventName: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  sport: string | null;
  country: string | null;
  competition: string | null;
  competitionStage: string | null;
  competitionPath: string | null;
  startTimeUtc: string | null;
  status: string | null;
  statusDetail: string | null;
  outcome: string | null;
  oddsSnapshotCount: number;
  statsSnapshotCount: number;
  latestOddsFetchedAt: string | null;
  latestStatsFetchedAt: string | null;
  updatedAt: string;
}): ScrapedMatchSummary {
  const latestOdds = r.latestOddsFetchedAt ?? undefined;
  const latestStats = r.latestStatsFetchedAt ?? undefined;
  const lastFetchedAt =
    latestOdds && latestStats
      ? new Date(latestOdds) > new Date(latestStats)
        ? latestOdds
        : latestStats
      : (latestOdds ?? latestStats ?? r.updatedAt);
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
    outcome: r.outcome ?? undefined,
  };
  item.eventName = item.eventName ?? fallbackName(item);
  return item;
}

function buildWhere(opts: {
  q?: string;
  countries: string[];
  leagues: string[];
  statuses: string[];
}): Prisma.MatchEventSummaryWhereInput {
  const where: Prisma.MatchEventSummaryWhereInput = {};
  const and: Prisma.MatchEventSummaryWhereInput[] = [];

  if (opts.q && opts.q.trim()) {
    const q = opts.q.trim();
    and.push({
      OR: [
        { homeTeam: { contains: q } },
        { awayTeam: { contains: q } },
        { competition: { contains: q } },
        { eventName: { contains: q } },
        { eventId: { contains: q } },
      ],
    });
  }
  if (opts.countries.length > 0) {
    and.push({ country: { in: opts.countries } });
  }
  if (opts.leagues.length > 0) {
    and.push({ competition: { in: opts.leagues } });
  }
  // status filter is post-query because we normalize raw strings to LIVE/FT/SCHED
  // and the raw `status` text is too varied to map via SQL. The route applies
  // it after fetching one page.

  if (and.length > 0) where.AND = and;
  return where;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = url.searchParams;

  const q = params.get("q") ?? undefined;
  const countries = params.getAll("country");
  const leagues = params.getAll("league");
  const statuses = params.getAll("status"); // LIVE | FT | SCHED
  const sort = (params.get("sort") ?? "last_fetch_desc") as SortKey;
  const limit = Math.min(Math.max(Number(params.get("limit") ?? "50"), 1), 200);
  const cursor = params.get("cursor") ?? undefined;
  const wantFacets = params.get("withFacets") === "1";
  const orderBy = SORT_KEYS[sort] ?? SORT_KEYS.last_fetch_desc;

  const where = buildWhere({ q, countries, leagues, statuses });

  try {
    // Fetch one extra row to know whether there's a next page.
    const args: Prisma.MatchEventSummaryFindManyArgs = {
      where,
      orderBy,
      take: limit + 1,
    };
    if (cursor) {
      args.cursor = { eventId: cursor };
      args.skip = 1;
    }

    const [rows, totalUnfiltered] = await Promise.all([
      prisma.matchEventSummary.findMany(args),
      // Total respects filters but not pagination; useful for "X matches" badge.
      prisma.matchEventSummary.count({ where }),
    ]);

    let summaries = rows.map(toSummary);
    if (statuses.length > 0) {
      const allow = new Set(statuses.map((s) => s.toUpperCase()));
      summaries = summaries.filter((m) => allow.has(statusToKind(m.status)));
    }

    let nextCursor: string | null = null;
    if (summaries.length > limit) {
      const next = summaries[limit];
      nextCursor = next.eventId;
      summaries = summaries.slice(0, limit);
    }

    let facets: {
      country: { value: string; count: number }[];
      league: { value: string; count: number }[];
      status: { value: string; count: number }[];
    } | undefined;

    if (wantFacets) {
      const [byCountry, byLeague] = await Promise.all([
        prisma.matchEventSummary.groupBy({
          by: ["country"],
          where,
          _count: { _all: true },
          orderBy: { _count: { eventId: "desc" } },
          take: 30,
        }),
        prisma.matchEventSummary.groupBy({
          by: ["competition"],
          where,
          _count: { _all: true },
          orderBy: { _count: { eventId: "desc" } },
          take: 50,
        }),
      ]);

      // For status we only need the three tokens; compute from a small sample of
      // recent rows. groupBy on raw status would explode into dozens of variants.
      const sample = await prisma.matchEventSummary.findMany({
        where,
        select: { status: true },
        take: 2000,
      });
      const statusCounts = new Map<string, number>();
      for (const s of sample) {
        const kind = statusToKind(s.status);
        statusCounts.set(kind, (statusCounts.get(kind) ?? 0) + 1);
      }

      facets = {
        country: byCountry
          .filter((r) => r.country)
          .map((r) => ({ value: r.country as string, count: r._count._all })),
        league: byLeague
          .filter((r) => r.competition)
          .map((r) => ({ value: r.competition as string, count: r._count._all })),
        status: Array.from(statusCounts.entries()).map(([value, count]) => ({ value, count })),
      };
    }

    return NextResponse.json(
      {
        matches: summaries,
        nextCursor,
        total: totalUnfiltered,
        facets,
      },
      { headers: { "Cache-Control": "private, max-age=15" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load scraped matches.";
    return NextResponse.json(
      { error: { code: "scraped_matches_load_failed", message } },
      { status: 500 },
    );
  }
}
