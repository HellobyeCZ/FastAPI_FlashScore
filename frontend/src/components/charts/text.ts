"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import type { Locale } from "@/lib/i18n";

/**
 * Chart-internal copy: default accessible names, axis titles, legends and
 * the generated <desc> summaries. Every visible string can be overridden
 * through props; these are only the defaults, kept here (en + cs) because the
 * page catalogs in src/lib/i18n are owned per page namespace.
 */
const en = {
  "line.aria": "Line chart",
  "line.desc": "{label}: {points}, last value {value}",
  "line.range": "{from} to {to}",
  "points.one": "{count} point",
  "points.other": "{count} points",
  legend: "Legend",
  "scatter.aria": "Scatter plot",
  "scatter.offScale": "{count} outside the plotted range, drawn hollow at the edge",
  "calibration.aria": "Calibration plot: predicted probability against observed frequency",
  "calibration.x": "Predicted probability",
  "calibration.y": "Observed frequency",
  "calibration.desc": "{buckets}, total n = {n}",
  "calibration.bucket": "{range}: predicted {pred}, observed {obs} (95% CI {lo}–{hi}), n = {n}",
  "calibration.insufficient": "Insufficient data for a calibration curve: n = {n}, at least {min} needed.",
  "calibration.key": "Point area ∝ n · whiskers: 95% CI (Wilson) · faded: n < {min}",
  "buckets.one": "{count} bucket",
  "buckets.other": "{count} buckets",
  "heatmap.aria": "Heatmap",
  "heatmap.rowMean": "Row mean",
  "heatmap.rowMeanHint": "n-weighted mean of every cell in the row",
  "heatmap.cell": "{row} × {col}: {value}, n = {n}",
  "heatmap.cellSmall": "{row} × {col}: n = {n}, below the minimum of {min}",
  "heatmap.cellEmpty": "{row} × {col}: no data",
  "heatmap.scale": "Color scale",
  "hidden.one": "{count} cell hidden (n < {min})",
  "hidden.other": "{count} cells hidden (n < {min})",
  "violin.aria": "Distribution by group",
  "violin.desc": "{label}: n = {n}, median {median}",
  "hbar.aria": "Bar chart",
  "binned.aria": "Bar chart by bin",
  "binned.bar": "{label}: {value}, n = {n}",
  "binned.ci": "95% CI",
  "binned.expected": "Expected",
  "binned.small": "Faded: n < {min}",
  "sparkline.aria": "Trend",
  "sparkline.desc": "From {first} to {last}; min {min}, max {max}"
} as const;

export type ChartTextKey = keyof typeof en;

const cs: Record<ChartTextKey, string> & Partial<Record<`${PluralBase}.${"few" | "many"}`, string>> = {
  "line.aria": "Spojnicový graf",
  "line.desc": "{label}: {points}, poslední hodnota {value}",
  "line.range": "{from} až {to}",
  "points.one": "{count} bod",
  "points.few": "{count} body",
  "points.many": "{count} bodu",
  "points.other": "{count} bodů",
  legend: "Legenda",
  "scatter.aria": "Bodový graf",
  "scatter.offScale": "{count} mimo zobrazený rozsah, vykresleno prázdně na okraji",
  "calibration.aria": "Kalibrační graf: predikovaná pravděpodobnost proti pozorované četnosti",
  "calibration.x": "Predikovaná pravděpodobnost",
  "calibration.y": "Pozorovaná četnost",
  "calibration.desc": "{buckets}, celkem n = {n}",
  "calibration.bucket": "{range}: predikce {pred}, pozorováno {obs} (95% IS {lo}–{hi}), n = {n}",
  "calibration.insufficient": "Nedostatek dat pro kalibrační křivku: n = {n}, potřeba alespoň {min}.",
  "calibration.key": "Plocha bodu ∝ n · úsečky: 95% IS (Wilson) · tlumeně: n < {min}",
  "buckets.one": "{count} interval",
  "buckets.few": "{count} intervaly",
  "buckets.many": "{count} intervalu",
  "buckets.other": "{count} intervalů",
  "heatmap.aria": "Teplotní mapa",
  "heatmap.rowMean": "Průměr řádku",
  "heatmap.rowMeanHint": "Průměr všech buněk řádku vážený počtem n",
  "heatmap.cell": "{row} × {col}: {value}, n = {n}",
  "heatmap.cellSmall": "{row} × {col}: n = {n}, pod minimem {min}",
  "heatmap.cellEmpty": "{row} × {col}: žádná data",
  "heatmap.scale": "Barevná škála",
  "hidden.one": "{count} buňka skryta (n < {min})",
  "hidden.few": "{count} buňky skryty (n < {min})",
  "hidden.many": "{count} buňky skryto (n < {min})",
  "hidden.other": "{count} buněk skryto (n < {min})",
  "violin.aria": "Rozdělení podle skupin",
  "violin.desc": "{label}: n = {n}, medián {median}",
  "hbar.aria": "Pruhový graf",
  "binned.aria": "Sloupcový graf po intervalech",
  "binned.bar": "{label}: {value}, n = {n}",
  "binned.ci": "95% IS",
  "binned.expected": "Očekávané",
  "binned.small": "Tlumeně: n < {min}",
  "sparkline.aria": "Vývoj",
  "sparkline.desc": "Od {first} do {last}; min. {min}, max. {max}"
};

type PluralBase = "points" | "buckets" | "hidden";
type Values = Record<string, string | number>;

const CATALOGS: Record<Locale, Partial<Record<string, string>>> = { en, cs };

function interpolate(template: string, values?: Values): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (values[k] === undefined ? `{${k}}` : String(values[k])));
}

export type ChartText = {
  t: (key: ChartTextKey, values?: Values) => string;
  tp: (base: PluralBase, count: number, values?: Values) => string;
};

function makeText(locale: Locale): ChartText {
  const catalog = CATALOGS[locale];
  const rules = new Intl.PluralRules(locale);
  const lookup = (key: string) => catalog[key] ?? (en as Record<string, string>)[key] ?? key;
  return {
    t: (key, values) => interpolate(lookup(key), values),
    tp: (base, count, values) => {
      const key = `${base}.${rules.select(count)}`;
      const template = catalog[key] ?? catalog[`${base}.other`] ?? lookup(`${base}.other`);
      return interpolate(template, { count, ...values });
    }
  };
}

/** Chart copy for the current locale plus the shared formatters. */
export function useChartText() {
  const { locale, fmt, t: appT } = useLocale();
  const text = useMemo(() => makeText(locale), [locale]);
  return { ...text, locale, fmt, noData: appT("common.noData") };
}
