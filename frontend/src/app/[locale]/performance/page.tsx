import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale, locales } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { LeaderboardPage } from "@/components/performance/LeaderboardPage";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return { title: formatMessage(isLocale(params.locale) ? params.locale : "en", "nav.performance") };
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <LeaderboardPage />
    </Suspense>
  );
}
