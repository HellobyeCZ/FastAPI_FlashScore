import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";

export const dynamic = "force-dynamic";

// `paper_bets` and `scrape_jobs` are NOT in Prisma's schema (see CLAUDE.md);
// query via $queryRaw. `paper_bets` has no kickoff column, so we join either
// `upcoming_fixtures` (future) or `bet_labels` / `match_event_summaries` (past)
// to recover the kickoff timestamp. Stored as ISO TEXT in SQLite.
//
// Status normalization: paper_bets.status is "pending"/"settled"; the StatusToken
// UI expects OPEN/PEND/WON/LOST/VOID. We derive WON/LOST/VOID from pnl for
// settled rows (heuristic: pnl > 0 -> WON, < 0 -> LOST, == 0 -> VOID).

type RawBet = {
  id: number;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  recommended_at: string;
  bet_ts: string;
  price_at_recommendation: number;
  closing_price: number | null;
  edge: number | null;
  pnl: number | null;
  status: string;
  settled_at: string | null;
  kickoff: string | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  country: string | null;
};

type RawJob = {
  id: number;
  competition_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  total_events: number;
};

function normalizeStatus(b: RawBet): "OPEN" | "PEND" | "WON" | "LOST" | "VOID" {
  if (b.status === "settled" || b.settled_at) {
    const v = b.pnl ?? 0;
    if (v > 0) return "WON";
    if (v < 0) return "LOST";
    return "VOID";
  }
  // pending and unsettled
  return "OPEN";
}

function mapBet(b: RawBet) {
  const home = b.home_team ?? "";
  const away = b.away_team ?? "";
  const league = b.competition ?? b.country ?? "";
  return {
    id: String(b.id),
    kickoff: b.kickoff ?? b.bet_ts ?? b.recommended_at,
    league,
    homeTeam: home,
    awayTeam: away,
    market: b.market,
    pick: b.selection,
    odds: Number(b.price_at_recommendation ?? 0),
    edge: Number(b.edge ?? 0),
    model: b.model,
    status: normalizeStatus(b),
    eventId: b.event_id,
    pnlUnits: b.pnl ?? undefined,
    settledAt: b.settled_at ?? undefined
  };
}

export async function GET() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 24 * 3600 * 1000);
  const startIso = todayStart.toISOString();
  const endIso = tomorrow.toISOString();

  try {
    // Pull a richer-than-strict-today window so the slate isn't empty if no
    // kickoff joined row matches; we'll filter the open-picks window in JS.
    const allBetsP = prisma.$queryRaw<RawBet[]>`
      SELECT
        pb.id, pb.event_id, pb.model, pb.market, pb.selection,
        pb.recommended_at, pb.bet_ts, pb.price_at_recommendation,
        pb.closing_price, pb.edge, pb.pnl, pb.status, pb.settled_at,
        COALESCE(uf.start_time_utc, mes.start_time_utc, bl.start_time_utc) AS kickoff,
        COALESCE(uf.home_team_raw, mes.home_team, bl.home_team) AS home_team,
        COALESCE(uf.away_team_raw, mes.away_team, bl.away_team) AS away_team,
        COALESCE(uf.competition, mes.competition, bl.competition) AS competition,
        COALESCE(uf.country, mes.country, bl.country) AS country
      FROM paper_bets pb
      LEFT JOIN upcoming_fixtures uf ON uf.event_id = pb.event_id
      LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
      LEFT JOIN bet_labels bl ON bl.event_id = pb.event_id
      ORDER BY pb.recommended_at DESC
      LIMIT 500
    `;

    let runningJobs: RawJob[] = [];
    try {
      runningJobs = await prisma.$queryRaw<RawJob[]>`
        SELECT id, competition_path, status, created_at, updated_at, total_events
        FROM scrape_jobs
        WHERE status IN ('queued', 'running', 'pending')
        ORDER BY updated_at DESC
        LIMIT 20
      `;
    } catch (jobErr) {
      console.warn("[/api/today] scrape_jobs query failed:", jobErr);
      runningJobs = [];
    }

    const allBets = await allBetsP;
    const mapped = allBets.map(mapBet);

    // Open picks: unsettled, kickoff inside the UTC day window.
    const openPicks = mapped.filter((p) => {
      if (p.status !== "OPEN") return false;
      if (!p.kickoff) return false;
      return p.kickoff >= startIso && p.kickoff < endIso;
    });

    // Settled picks: status != OPEN, take last 10 by settledAt desc
    const settledPicks = mapped
      .filter((p) => p.status !== "OPEN")
      .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""))
      .slice(0, 10);

    const jobs = runningJobs.map((j) => ({
      id: String(j.id),
      competitionPath: j.competition_path,
      status: j.status,
      progress: undefined as number | undefined
    }));

    return NextResponse.json({ openPicks, settledPicks, runningJobs: jobs });
  } catch (err) {
    console.error("[/api/today] failed:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
