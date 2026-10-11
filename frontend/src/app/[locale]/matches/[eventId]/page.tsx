import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { MatchDetailPage } from "@/components/matches/MatchDetailPage";

export function generateMetadata({ params }: { params: { locale: string; eventId: string } }): Metadata {
  const locale = isLocale(params.locale) ? params.locale : "en";
  return { title: `${decodeURIComponent(params.eventId)} · ${formatMessage(locale, "nav.matches")}` };
}

export default function Page({ params }: { params: { locale: string; eventId: string } }) {
  return (
    <Suspense fallback={<Loading />}>
      <MatchDetailPage eventId={decodeURIComponent(params.eventId)} />
    </Suspense>
  );
}
