import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { BacktestDetailPage } from "@/components/lab/BacktestDetailPage";

export function generateMetadata({ params }: { params: { locale: string; id: string } }): Metadata {
  const locale = isLocale(params.locale) ? params.locale : "en";
  return { title: `${decodeURIComponent(params.id)} · ${formatMessage(locale, "nav.lab.backtests")}` };
}

export default function Page({ params }: { params: { locale: string; id: string } }) {
  return (
    <Suspense fallback={<Loading />}>
      <BacktestDetailPage id={decodeURIComponent(params.id)} />
    </Suspense>
  );
}
