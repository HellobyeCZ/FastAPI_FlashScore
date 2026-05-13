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

// FlashScore writes the competition stage into the `competition` text itself
// (e.g. "NHL - Play Offs", "Extraliga - Relegation"), in addition to the
// dedicated `competition_stage` column. For grouping + filtering we strip the
// suffix so a single "NHL" facet covers regular season + every play-off stage.
function competitionRoot(c: string | null | undefined): string | undefined {
  if (!c) return undefined;
  const idx = c.indexOf(" - ");
  return idx > 0 ? c.slice(0, idx) : c;
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
  // Display value matches the sort expression: max of all three timestamps.
  // updatedAt is bumped on any change to the summary row, including backfills
  // that touch teams/competition without re-fetching odds/stats — so it can be
  // newer than either latestOdds or latestStats.
  const candidates = [latestOdds, latestStats, r.updatedAt].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const lastFetchedAt =
    candidates.length > 0
      ? candidates.reduce((max, v) => (v > max ? v : max))
      : r.updatedAt;
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
    // Match the league root and any stage-suffixed variant
    // ("NHL", "NHL - Play Offs", ...).
    and.push({
      OR: opts.leagues.flatMap((l) => [
        { competition: l },
        { competition: { startsWith: `${l} - ` } },
      ]),
    });
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
    let rows: Awaited<ReturnType<typeof prisma.matchEventSummary.findMany>>;
    let totalUnfiltered: number;

    if (sort === "last_fetch_desc") {
      // Sort by the same expression the UI displays as "last fetch":
      // max(latest_odds_fetched_at, latest_stats_fetched_at, updated_at).
      // Prisma's typed orderBy can't express GREATEST(...), so use raw SQL.
      // Keyset pagination by (last_fetch_value, event_id) keeps it O(limit)
      // even on huge tables.
      const sqlWhere: string[] = [];
      const sqlBinds: (string | number)[] = [];

      if (q && q.trim()) {
        const like = `%${q.trim()}%`;
        sqlWhere.push(
          "(home_team LIKE ? OR away_team LIKE ? OR competition LIKE ? OR event_name LIKE ? OR event_id LIKE ?)",
        );
        sqlBinds.push(like, like, like, like, like);
      }
      if (countries.length > 0) {
        sqlWhere.push(`country IN (${countries.map(() => "?").join(",")})`);
        sqlBinds.push(...countries);
      }
      if (leagues.length > 0) {
        const parts: string[] = [];
        for (const l of leagues) {
          parts.push("competition = ?");
          sqlBinds.push(l);
          parts.push("competition LIKE ?");
          sqlBinds.push(`${l} - %`);
        }
        sqlWhere.push(`(${parts.join(" OR ")})`);
      }

      const LAST_FETCH = `MAX(
        COALESCE(latest_odds_fetched_at, ''),
        COALESCE(latest_stats_fetched_at, ''),
        COALESCE(updated_at, '')
      )`;

      if (cursor) {
        // cursor format: "<lastFetchISO>|<eventId>" (URI-encoded by caller)
        const decoded = decodeURIComponent(cursor);
        const sep = decoded.lastIndexOf("|");
        if (sep > 0) {
          const cursorLast = decoded.slice(0, sep);
          const cursorEventId = decoded.slice(sep + 1);
          sqlWhere.push(
            `(${LAST_FETCH} < ? OR (${LAST_FETCH} = ? AND event_id < ?))`,
          );
          sqlBinds.push(cursorLast, cursorLast, cursorEventId);
        }
      }

      const whereClause = sqlWhere.length > 0 ? `WHERE ${sqlWhere.join(" AND ")}` : "";

      // Fetch one extra row to detect next page.
      const sql = `
        SELECT event_id AS eventId,
               event_name AS eventName,
               home_team AS homeTeam,
               away_team AS awayTeam,
               sport,
               country,
               competition,
               competition_stage AS competitionStage,
               competition_path AS competitionPath,
               start_time_utc AS startTimeUtc,
               status,
               status_detail AS statusDetail,
               outcome,
               odds_snapshot_count AS oddsSnapshotCount,
               stats_snapshot_count AS statsSnapshotCount,
               latest_odds_fetched_at AS latestOddsFetchedAt,
               latest_stats_fetched_at AS latestStatsFetchedAt,
               updated_at AS updatedAt
        FROM match_event_summaries
        ${whereClause}
        ORDER BY ${LAST_FETCH} DESC, event_id DESC
        LIMIT ?
      `;
      const fetched = (await prisma.$queryRawUnsafe(sql, ...sqlBinds, limit + 1)) as Array<{
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
        oddsSnapshotCount: number | bigint;
        statsSnapshotCount: number | bigint;
        latestOddsFetchedAt: string | null;
        latestStatsFetchedAt: string | null;
        updatedAt: string;
      }>;

      // Normalize bigints from raw query.
      rows = fetched.map((r) => ({
        ...r,
        oddsSnapshotCount: Number(r.oddsSnapshotCount),
        statsSnapshotCount: Number(r.statsSnapshotCount),
      }));

      // Total count uses the same filter set (no cursor).
      const countSql = `SELECT COUNT(*) AS c FROM match_event_summaries ${whereClause.replace(/\bAND \(MAX\([^)]*\)[^)]*\)[^)]*\)/, "")}`;
      // Strip the cursor predicate from the count: simpler to rebuild it.
      const countWhere: string[] = [];
      const countBinds: (string | number)[] = [];
      if (q && q.trim()) {
        const like = `%${q.trim()}%`;
        countWhere.push(
          "(home_team LIKE ? OR away_team LIKE ? OR competition LIKE ? OR event_name LIKE ? OR event_id LIKE ?)",
        );
        countBinds.push(like, like, like, like, like);
      }
      if (countries.length > 0) {
        countWhere.push(`country IN (${countries.map(() => "?").join(",")})`);
        countBinds.push(...countries);
      }
      if (leagues.length > 0) {
        countWhere.push(`competition IN (${leagues.map(() => "?").join(",")})`);
        countBinds.push(...leagues);
      }
      const countWhereClause = countWhere.length > 0 ? `WHERE ${countWhere.join(" AND ")}` : "";
      const countRows = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS c FROM match_event_summaries ${countWhereClause}`,
        ...countBinds,
      )) as Array<{ c: number | bigint }>;
      totalUnfiltered = Number(countRows[0]?.c ?? 0);
    } else {
      // Other sorts: typed Prisma path with eventId-only keyset cursor.
      const args: Prisma.MatchEventSummaryFindManyArgs = {
        where,
        orderBy,
        take: limit + 1,
      };
      if (cursor) {
        args.cursor = { eventId: decodeURIComponent(cursor) };
        args.skip = 1;
      }
      [rows, totalUnfiltered] = await Promise.all([
        prisma.matchEventSummary.findMany(args),
        prisma.matchEventSummary.count({ where }),
      ]);
    }

    let summaries = rows.map(toSummary);
    if (statuses.length > 0) {
      const allow = new Set(statuses.map((s) => s.toUpperCase()));
      summaries = summaries.filter((m) => allow.has(statusToKind(m.status)));
    }

    let nextCursor: string | null = null;
    if (summaries.length > limit) {
      const next = summaries[limit];
      if (sort === "last_fetch_desc") {
        // Composite cursor: <lastFetchValue>|<eventId>, URI-encoded so
        // a possible '|' in the timestamp can't confuse the parser.
        nextCursor = encodeURIComponent(`${next.lastFetchedAt}|${next.eventId}`);
      } else {
        nextCursor = encodeURIComponent(next.eventId);
      }
      summaries = summaries.slice(0, limit);
    }

    let facets: {
      country: { value: string; count: number }[];
      league: { value: string; count: number }[];
      status: { value: string; count: number }[];
    } | undefined;

    if (wantFacets) {
      const [byCountry, byLeagueRaw] = await Promise.all([
        prisma.matchEventSummary.groupBy({
          by: ["country"],
          where,
          _count: { _all: true },
          orderBy: { _count: { eventId: "desc" } },
          take: 30,
        }),
        // Pull more raw rows than we ultimately surface so that, after we
        // fold stage suffixes into a single root, the top-N is stable.
        prisma.matchEventSummary.groupBy({
          by: ["competition"],
          where,
          _count: { _all: true },
          orderBy: { _count: { eventId: "desc" } },
          take: 300,
        }),
      ]);

      // Collapse "NHL", "NHL - Play Offs", "NHL - Pre-season", ... into "NHL".
      const rootCounts = new Map<string, number>();
      for (const row of byLeagueRaw) {
        const root = competitionRoot(row.competition);
        if (!root) continue;
        rootCounts.set(root, (rootCounts.get(root) ?? 0) + row._count._all);
      }
      const byLeague = Array.from(rootCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50);

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
        league: byLeague.map(([value, count]) => ({ value, count })),
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
