import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { eventId: string } }
) {
  try {
    const rows = await prisma.oddsSnapshot.findMany({
      where: { eventId: params.eventId },
      orderBy: { fetchedAt: "desc" },
      take: 5,
      select: { id: true, fetchedAt: true }
    });
    return NextResponse.json(
      rows.map((r) => ({ id: r.id, fetchedAt: r.fetchedAt.toISOString() }))
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
