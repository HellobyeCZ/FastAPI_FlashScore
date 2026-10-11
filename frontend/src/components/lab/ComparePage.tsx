"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { PageHeader } from "@/components/ui";

// PLACEHOLDER — replaced by the page implementation.
export function ComparePage() {
  const { t } = useLocale();
  return <PageHeader title={t("nav.lab.backtests")} />;
}
