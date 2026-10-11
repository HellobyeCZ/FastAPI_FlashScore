import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma";
import type { TodayPick, TodayPickState, TodayResponse, TodaySettled } from "@/hooks/useToday";

export const dynamic = "force-dynamic";

// `paper_bets`, `upcoming_fixtures`, `match_event_summaries` and `bet_labels`
// are not modelled in Prisma (see CLAUDE.md), so everything here is $queryRaw.
//
// paper_bets has no kick-off column. It is recovered from, in order,
// match_event_summaries (canonical FlashScore metadata, also what the match
// page shows), bet_labels, then upcoming_fixtures (future fixtures only). The
// same order supplies team names: upcoming_fixtures lists some events with
// home/away reversed relative to the other two, and the slate must agree with
// the match page it links to. Bets with no kick-off fall outside every window.
//
// Timestamps are stored as ISO TEXT in mixed shapes ("…+00:00", "…Z", with and
// without microseconds), so every comparison and sort goes through julianday()
// and every timestamp leaves the query normalised to "YYYY-MM-DDTHH:MM:SS.sssZ".
//
// Windows (all relative to one `now`):
//   slate          every pick with kick-off in the viewer's local day
//   upcoming72h    pending picks with kick-off in [now, now + 72 h)
//   pending        pending picks whose kick-off has passed; overdue after 6 h
//                  (the same rule as the settle_overdue health check)
//   pnl30d         settled bets with settled_at in the last 30 days

const HOUR_MS = 3_600_000;
const ROW_LIMIT = 500;
const RECENT_LIMIT = 10;
const OVERDUE_HOURS = 6;

const ISO = "%Y-%m-%dT%H:%M:%fZ";

const BETS = Prisma.sql`
  SELECT
    pb.id, pb.event_id, pb.model, pb.market, pb.selection, pb.status, pb.result, pb.pnl,
    pb.price_at_recommendation AS price, pb.edge,
    strftime(${ISO}, julianday(pb.recommended_at)) AS recommended_at,
    strftime(${ISO}, julianday(pb.settled_at)) AS settled_at,
    julianday(pb.settled_at) AS settled_jd,
    julianday(COALESCE(mes.start_time_utc, bl.start_time_utc, uf.start_time_utc)) AS kickoff_jd,
    COALESCE(mes.home_team, bl.home_team, uf.home_team_raw) AS home_team,
    COALESCE(mes.away_team, bl.away_team, uf.away_team_raw) AS away_team,
    COALESCE(mes.competition, bl.competition, uf.competition) AS competition,
    COALESCE(mes.country, bl.country, uf.country) AS country
  FROM paper_bets pb
  LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
  LEFT JOIN bet_labels bl ON bl.event_id = pb.event_id
  LEFT JOIN upcoming_fixtures uf ON uf.event_id = pb.event_id
`;

type RawBet = {
  id: number | bigint;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  status: string;
  result: number | null;
  pnl: number | null;
  price: number;
  edge: number | null;
  recommended_at: string;
  settled_at: string | null;
  settled_jd: number | null;
  kickoff_jd: number | null;
  kickoff: string | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  country: string | null;
};

type RawSummary = {
  last_recommended_at: string | null;
  last_settled_at: string | null;
  pending_count: number | bigint | null;
  overdue_count: number | bigint | null;
  oldest_kickoff: string | null;
};

type RawSeriesPoint = { settled_at: string; pnl: number };

// ---------------------------------------------------------------------------
// Viewer's local day

type DayWindow = { start: Date; end: Date; tz: string };

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Offset of `timeZone` from UTC at `date`, in ms (local minus UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight on a calendar day (day overflow rolls the month). */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  // A DST switch between the guess and the answer changes the offset; one
  // more pass with the offset at the answer settles it.
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function offsetLabel(offsetMinutes: number): string {
  const east = -offsetMinutes;
  const abs = Math.abs(east);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${east < 0 ? "−" : "+"}${hh}:${mm}`;
}

/**
 * `tz` is an IANA zone ("Europe/Prague") or a `Date#getTimezoneOffset()` value
 * in minutes ("-120"). Anything unrecognised falls back to UTC; the response
 * echoes the zone actually used so the page can label it.
 */
function localDay(tz: string | null, now: Date): DayWindow {
  if (tz && /^[+-]?\d{1,4}$/.test(tz) && Math.abs(Number(tz)) <= 14 * 60) {
    const offset = Number(tz);
    const local = new Date(now.getTime() - offset * 60_000);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + offset * 60_000;
    return { start: new Date(start), end: new Date(start + 24 * HOUR_MS), tz: offsetLabel(offset) };
  }
  const zone = tz && isTimeZone(tz) ? tz : "UTC";
  const p = zonedParts(now, zone);
  return { start: zonedMidnight(p.y, p.m, p.d, zone), end: zonedMidnight(p.y, p.m, p.d + 1, zone), tz: zone };
}

// ---------------------------------------------------------------------------
// Row mapping

function pickState(row: RawBet, nowJd: number): TodayPickState {
  if (row.status === "voided") return "void";
  if (row.status === "settled") {
    if (row.result === null) return "void";
    if (row.result >= 1) return "won";
    if (row.result <= 0) return "lost";
    return "void";
  }
  return row.kickoff_jd !== null && row.kickoff_jd <= nowJd ? "pending" : "open";
}

function toPick(row: RawBet, nowJd: number): TodayPick {
  return {
    id: Number(row.id),
    event_id: row.event_id,
    model: row.model,
    market: row.market,
    selection: row.selection,
    price: Number(row.price),
    edge: row.edge === null ? null : Number(row.edge),
    state: pickState(row, nowJd),
    recommended_at: row.recommended_at,
    kickoff: row.kickoff,
    home_team: row.home_team,
    away_team: row.away_team,
    competition: row.competition,
    country: row.country
  };
}

function toSettled(row: RawBet, nowJd: number): TodaySettled {
  return {
    ...toPick(row, nowJd),
    result: row.status === "settled" && row.result !== null ? Number(row.result) : null,
    pnl: row.status === "settled" && row.pnl !== null ? Number(row.pnl) : null,
    settled_at: row.settled_at ?? row.recommended_at
  };
}

function julian(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const now = new Date();
  const day = localDay(request.nextUrl.searchParams.get("tz"), now);
  const nowJd = julian(now);
  const nowIso = now.toISOString();
  const in72hIso = new Date(now.getTime() + 72 * HOUR_MS).toISOString();
  const since30dIso = new Date(now.getTime() - 30 * 24 * HOUR_MS).toISOString();
  const overdueIso = new Date(now.getTime() - OVERDUE_HOURS * HOUR_MS).toISOString();

  try {
    const [slateRows, upcomingRows, seriesRows, summaryRows, recentRows] = await Promise.all([
      prisma.$queryRaw<RawBet[]>`
        SELECT b.*, strftime(${ISO}, b.kickoff_jd) AS kickoff FROM (${BETS}) b
        WHERE b.kickoff_jd >= julianday(${day.start.toISOString()})
          AND b.kickoff_jd < julianday(${day.end.toISOString()})
        ORDER BY b.kickoff_jd, b.edge DESC, b.id
        LIMIT ${ROW_LIMIT}
      `,
      prisma.$queryRaw<RawBet[]>`
        SELECT b.*, strftime(${ISO}, b.kickoff_jd) AS kickoff FROM (${BETS}) b
        WHERE b.status = 'pending'
          AND b.kickoff_jd >= julianday(${nowIso})
          AND b.kickoff_jd < julianday(${in72hIso})
        ORDER BY b.kickoff_jd, b.edge DESC, b.id
        LIMIT ${ROW_LIMIT}
      `,
      prisma.$queryRaw<RawSeriesPoint[]>`
        SELECT strftime(${ISO}, julianday(settled_at)) AS settled_at, pnl
        FROM paper_bets
        WHERE status = 'settled' AND pnl IS NOT NULL
          AND julianday(settled_at) >= julianday(${since30dIso})
        ORDER BY julianday(settled_at), id
      `,
      prisma.$queryRaw<RawSummary[]>`
        SELECT
          strftime(${ISO}, MAX(julianday(b.recommended_at))) AS last_recommended_at,
          strftime(${ISO}, MAX(b.settled_jd)) AS last_settled_at,
          SUM(CASE WHEN b.status = 'pending' AND b.kickoff_jd < julianday(${nowIso}) THEN 1 ELSE 0 END)
            AS pending_count,
          SUM(CASE WHEN b.status = 'pending' AND b.kickoff_jd < julianday(${overdueIso}) THEN 1 ELSE 0 END)
            AS overdue_count,
          strftime(${ISO}, MIN(CASE WHEN b.status = 'pending' AND b.kickoff_jd < julianday(${nowIso})
            THEN b.kickoff_jd END)) AS oldest_kickoff
        FROM (${BETS}) b
      `,
      prisma.$queryRaw<RawBet[]>`
        SELECT b.*, strftime(${ISO}, b.kickoff_jd) AS kickoff FROM (${BETS}) b
        WHERE b.status IN ('settled', 'voided') AND b.settled_jd IS NOT NULL
        ORDER BY b.settled_jd DESC, b.id DESC
        LIMIT ${RECENT_LIMIT}
      `
    ]);

    let cum = 0;
    const series = seriesRows.map((r) => {
      cum += Number(r.pnl);
      return { settled_at: r.settled_at, cum_pnl: cum };
    });
    const summary = summaryRows[0];

    const body: TodayResponse = {
      generated_at: nowIso,
      window: { today_start: day.start.toISOString(), today_end: day.end.toISOString(), tz: day.tz },
      slate: slateRows.map((r) => toPick(r, nowJd)),
      upcoming72h: upcomingRows.map((r) => toPick(r, nowJd)),
      pnl30d: { n: series.length, pnl: series.length > 0 ? cum : null, series },
      last_settled_at: summary?.last_settled_at ?? null,
      pending: {
        count: Number(summary?.pending_count ?? 0),
        overdue_count: Number(summary?.overdue_count ?? 0),
        oldest_kickoff: summary?.oldest_kickoff ?? null
      },
      last_recommended_at: summary?.last_recommended_at ?? null,
      recent_settled: recentRows.map((r) => toSettled(r, nowJd))
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[/api/today] failed:", err);
    return NextResponse.json(
      { error: { code: "today_query_failed", message: err instanceof Error ? err.message : String(err) } },
      { status: 500 }
    );
  }
}
