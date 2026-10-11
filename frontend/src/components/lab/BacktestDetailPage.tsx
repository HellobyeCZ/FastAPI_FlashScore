"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { PageHeader } from "@/components/ui";

// PLACEHOLDER — replaced by the page implementation.
export function BacktestDetailPage({ id }: { id: string }) {
  const { t } = useLocale();
  return <PageHeader title={t("nav.lab.backtests")} description={id} />;
}
