import { Suspense } from "react";
import type { Metadata } from "next";
import { formatMessage, isLocale, locales } from "@/lib/i18n";
import Loading from "@/app/[locale]/loading";
import { ExperimentsPage } from "@/components/lab/ExperimentsPage";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return { title: formatMessage(isLocale(params.locale) ? params.locale : "en", "nav.lab.experiments") };
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <ExperimentsPage />
    </Suspense>
  );
}
