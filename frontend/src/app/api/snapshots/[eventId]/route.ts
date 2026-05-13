import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";

export const dynamic = "force-dynamic";

type SnapshotEntry = {
  fetchedAt: string;
  rowCount: number;
  bookmakerCount: number;
  marketCount: number;
};

export async function GET(
  _req: Request,
  { params }: { params: { eventId: string } }
) {
  try {
    const rows = await prisma.liveOddsSnapshot.findMany({
      where: { eventId: params.eventId },
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true, bookmaker: true, market: true }
    });

    const buckets = new Map<
      string,
      { bookmakers: Set<string>; markets: Set<string>; rowCount: number }
    >();
    for (const r of rows) {
      const b = buckets.get(r.fetchedAt) ?? {
        bookmakers: new Set<string>(),
        markets: new Set<string>(),
        rowCount: 0
      };
      if (r.bookmaker) b.bookmakers.add(r.bookmaker);
      b.markets.add(r.market);
      b.rowCount += 1;
      buckets.set(r.fetchedAt, b);
    }

    const entries: SnapshotEntry[] = Array.from(buckets.entries())
      .map(([fetchedAt, b]) => ({
        fetchedAt,
        rowCount: b.rowCount,
        bookmakerCount: b.bookmakers.size,
        marketCount: b.markets.size
      }))
      .sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));

    return NextResponse.json(entries);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
