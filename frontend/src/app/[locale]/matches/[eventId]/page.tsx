import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { MatchDetailPage } from "@/components/matches/MatchDetailPage";

/** "Home – Away" for the tab title; never the raw event id. Stored data only. */
async function matchTitle(eventId: string): Promise<string | null> {
  try {
    const { prisma } = await import("@/server/prisma");
    const rows = await prisma.$queryRawUnsafe<{ home: string | null; away: string | null }[]>(
      `SELECT COALESCE(m.home_team, u.home_team_raw) AS home,
              COALESCE(m.away_team, u.away_team_raw) AS away
         FROM (SELECT ? AS id) q
         LEFT JOIN match_event_summaries m ON m.event_id = q.id
         LEFT JOIN upcoming_fixtures u ON u.event_id = q.id`,
      eventId
    );
    const row = rows[0];
    return row?.home && row?.away ? `${row.home} – ${row.away}` : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params
}: {
  params: { locale: string; eventId: string };
}): Promise<Metadata> {
  const locale = isLocale(params.locale) ? params.locale : "en";
  const section = formatMessage(locale, "nav.matches");
  const title = await matchTitle(decodeURIComponent(params.eventId));
  return { title: title ? `${title} · ${section}` : section };
}

export default function Page({ params }: { params: { locale: string; eventId: string } }) {
  return (
    <Suspense fallback={<Loading />}>
      <MatchDetailPage eventId={decodeURIComponent(params.eventId)} />
    </Suspense>
  );
}
