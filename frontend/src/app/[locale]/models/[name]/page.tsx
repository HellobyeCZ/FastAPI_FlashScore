import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { ModelPage } from "@/components/performance/ModelPage";

export function generateMetadata({ params }: { params: { locale: string; name: string } }): Metadata {
  const locale = isLocale(params.locale) ? params.locale : "en";
  return { title: `${decodeURIComponent(params.name)} · ${formatMessage(locale, "nav.performance")}` };
}

export default function Page({ params }: { params: { locale: string; name: string } }) {
  return (
    <Suspense fallback={<Loading />}>
      <ModelPage name={decodeURIComponent(params.name)} />
    </Suspense>
  );
}
