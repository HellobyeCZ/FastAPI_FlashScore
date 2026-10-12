import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { LiveSnapshotSummary } from "@/types/odds";

export const dynamic = "force-dynamic";

/**
 * Live captures for one event (live_odds_snapshots, written by the live odds
 * scheduler), newest first. Aggregated in SQL over the (event_id, fetched_at)
 * index instead of pulling every row into Node.
 */
export async function GET(_req: Request, { params }: { params: { eventId: string } }) {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT fetched_at,
              COUNT(*) AS n_rows,
              COUNT(DISTINCT bookmaker) AS n_books,
              COUNT(DISTINCT market) AS n_markets
       FROM live_odds_snapshots
       WHERE event_id = ?
       GROUP BY fetched_at
       ORDER BY fetched_at DESC`,
      params.eventId
    )) as { fetched_at: string; n_rows: number | bigint; n_books: number | bigint; n_markets: number | bigint }[];

    const body: LiveSnapshotSummary[] = rows.map((r) => ({
      fetched_at: r.fetched_at,
      rows: Number(r.n_rows),
      bookmakers: Number(r.n_books),
      markets: Number(r.n_markets)
    }));
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Driver messages can carry SQL and file paths: log them, return a generic one.
    console.error("[/api/snapshots/[eventId]] failed:", error);
    const busy = error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
    const message = busy ? "The database is busy; try again in a moment" : "Failed to load live snapshots.";
    return NextResponse.json({ error: { code: "snapshots_load_failed", message } }, { status: busy ? 503 : 500 });
  }
}
