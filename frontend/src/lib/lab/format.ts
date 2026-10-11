import { modelLabel } from "@/lib/labels";
import { parseDate } from "@/lib/format";
import type { Locale, MessageKey, MessageValues } from "@/lib/i18n";
import type { BacktestRunDetail, BacktestRunSummary } from "./backtests";

type T = (key: MessageKey, values?: MessageValues) => string;

/** Most runs a comparison can hold (one table column / chart series each). */
export const MAX_COMPARE = 6;

const utcFormatters = new Map<Locale, Intl.DateTimeFormat>();

/**
 * Calendar date in UTC. Train/test cutoffs are UTC midnights; formatting
 * them in the viewer's zone would show "31 Jul" for a 1 Aug cutoff.
 */
export function utcDate(locale: Locale, iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  let f = utcFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    utcFormatters.set(locale, f);
  }
  return f.format(d);
}

/** "2024-08-01" for a date input; empty when missing. */
export function isoDay(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? d.toISOString().slice(0, 10) : "";
}

/** Auto-generated labels look like "logistic_2026-05-18T21:27:18.358543Z". */
export function isAutoLabel(run: Pick<BacktestRunSummary, "label" | "model">): boolean {
  return !run.label || /^[a-z0-9_]+_\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/i.test(run.label);
}

/** "1 Aug 2024 → 1 Sep 2024" / "1 Aug 2024 → open". */
export function runWindow(
  run: Pick<BacktestRunSummary, "train_until" | "test_until">,
  locale: Locale,
  t: T
): string {
  return t("lab.window", {
    train: utcDate(locale, run.train_until),
    test: run.test_until ? utcDate(locale, run.test_until) : t("lab.window.open")
  });
}

/** Human title: the operator's own label, else "Logistic · 1 Aug 2024 → open". */
export function runTitle(
  run: Pick<BacktestRunSummary, "label" | "model" | "train_until" | "test_until">,
  locale: Locale,
  t: T
): string {
  if (!isAutoLabel(run)) return run.label;
  return `${modelLabel(run.model, t)} · ${runWindow(run, locale, t)}`;
}

/** First 8 hex chars, enough to tell runs with identical titles apart. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * ROI, hit rate and Brier are undefined when no bet was placed. Older runs
 * store 0.0 for them, which would read as a measured break-even.
 */
export function betMetric(run: Pick<BacktestRunSummary, "total_bets">, value: number | null | undefined): number | null {
  return run.total_bets && run.total_bets > 0 && typeof value === "number" ? value : null;
}

/** Compact elapsed time: "42s", "12m", "3h", "146d" (narrow units, localized). */
export function formatDuration(ms: number, locale: Locale): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [value, unit]: [number, "second" | "minute" | "hour" | "day"] =
    s < 60 ? [s, "second"] : s < 3600 ? [Math.floor(s / 60), "minute"] : s < 86_400 ? [Math.floor(s / 3600), "hour"] : [Math.floor(s / 86_400), "day"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(value);
}

export type Difference = "window" | "scope" | "market" | "staking";

const scopeKey = (run: BacktestRunDetail) =>
  run.scope
    .map(([country, competition]) => `${country.toUpperCase()}|${competition}`)
    .sort()
    .join(";");

/** Which run settings differ — any difference makes KPIs not directly comparable. */
export function differences(runs: BacktestRunDetail[]): Difference[] {
  if (runs.length < 2) return [];
  const differs = (f: (r: BacktestRunDetail) => string) => new Set(runs.map(f)).size > 1;
  const out: Difference[] = [];
  if (differs((r) => `${isoDay(r.train_until)}|${isoDay(r.test_until)}`)) out.push("window");
  if (differs(scopeKey)) out.push("scope");
  if (differs((r) => r.market_spec)) out.push("market");
  if (differs((r) => `${r.min_edge}|${r.kelly_fraction}|${r.force_bets}`)) out.push("staking");
  return out;
}
