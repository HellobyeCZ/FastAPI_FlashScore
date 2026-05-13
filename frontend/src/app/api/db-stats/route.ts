import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [odds, stats] = await Promise.all([
      prisma.oddsSnapshot.count(),
      prisma.matchStatsSnapshot.count()
    ]);
    return NextResponse.json({ ok: true, rows: odds + stats, odds, stats });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
