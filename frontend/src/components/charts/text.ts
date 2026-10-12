"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import type { MessageKey, MessageValues, PluralKey } from "@/lib/i18n";
import type { charts } from "@/lib/i18n/en/charts";

/**
 * Chart-internal copy (defaults for accessible names, axis titles, legends and
 * <desc> summaries). Strings live in the app catalog under "charts.*"
 * (lib/i18n/{en,cs}/charts.ts); this hook keeps the short keys charts use.
 */
type Strip<K> = K extends `charts.${infer R}` ? R : never;
export type ChartTextKey = Strip<keyof typeof charts>;
type PluralBase = "points" | "buckets" | "hidden";

export type ChartText = {
  t: (key: ChartTextKey, values?: MessageValues) => string;
  tp: (base: PluralBase, count: number, values?: MessageValues) => string;
};

/**
 * Chart copy for the current locale plus the shared formatters. `appT` is the
 * app catalog, for the enum labels in lib/labels (model names etc.).
 */
export function useChartText() {
  const { locale, fmt, t: appT, tp: appTp } = useLocale();
  const text = useMemo<ChartText>(
    () => ({
      t: (key, values) => appT(`charts.${key}` as MessageKey, values),
      tp: (base, count, values) => appTp(`charts.${base}` as PluralKey, count, values)
    }),
    [appT, appTp]
  );
  return { ...text, locale, fmt, appT, noData: appT("common.noData") };
}
