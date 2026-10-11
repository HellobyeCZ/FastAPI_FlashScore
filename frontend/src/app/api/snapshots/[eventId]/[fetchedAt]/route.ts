import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { LiveSnapshotRows } from "@/types/odds";

export const dynamic = "force-dynamic";

/**
 * Raw rows of one live capture. Returned in insertion order (id ASC) because
 * the client derives home/away from the order upstream lists participants in
 * (lib/matches/odds.ts). 404 when the capture does not exist.
 */
export async function GET(
  _req: Request,
  { params }: { params: { eventId: string; fetchedAt: string } }
) {
  try {
    const fetchedAt = decodeURIComponent(params.fetchedAt);
    const rows = await prisma.liveOddsSnapshot.findMany({
      where: { eventId: params.eventId, fetchedAt },
      orderBy: { id: "asc" },
      select: { bookmaker: true, market: true, selectionKey: true, decimalPrice: true }
    });
    if (rows.length === 0) {
      return NextResponse.json(
        { error: { code: "snapshot_not_found", message: `No live capture at ${fetchedAt} for this match` } },
        { status: 404 }
      );
    }
    const body: LiveSnapshotRows = {
      event_id: params.eventId,
      fetched_at: fetchedAt,
      rows: rows.map((r) => ({
        bookmaker: r.bookmaker,
        market: r.market,
        selection_key: r.selectionKey,
        price: r.decimalPrice
      }))
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load the live capture.";
    return NextResponse.json({ error: { code: "snapshot_load_failed", message } }, { status: 500 });
  }
}
