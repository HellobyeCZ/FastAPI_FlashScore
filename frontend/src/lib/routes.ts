import type { Route } from "next";
import type { Locale } from "@/lib/i18n";

type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(","));
    } else {
      p.set(k, String(v));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** typedRoutes can't follow dynamic strings; centralise the one cast here. */
export const asRoute = (path: string) => path as Route;

/** Every app URL. Pages and links must build hrefs through this table. */
export const routes = {
  today: (l: Locale) => asRoute(`/${l}/today`),
  matches: (l: Locale, q?: Query) => asRoute(`/${l}/matches${qs(q)}`),
  match: (l: Locale, eventId: string) => asRoute(`/${l}/matches/${encodeURIComponent(eventId)}`),
  performance: (l: Locale, q?: Query) => asRoute(`/${l}/performance${qs(q)}`),
  explore: (l: Locale, q?: Query) => asRoute(`/${l}/performance/explore${qs(q)}`),
  model: (l: Locale, name: string, q?: Query) =>
    asRoute(`/${l}/models/${encodeURIComponent(name)}${qs(q)}`),
  backtests: (l: Locale, q?: Query) => asRoute(`/${l}/lab/backtests${qs(q)}`),
  backtest: (l: Locale, id: string) => asRoute(`/${l}/lab/backtests/${encodeURIComponent(id)}`),
  compare: (l: Locale, ids: readonly string[]) => asRoute(`/${l}/lab/compare${qs({ ids })}`),
  experiments: (l: Locale, q?: Query) => asRoute(`/${l}/lab/experiments${qs(q)}`),
  registry: (l: Locale) => asRoute(`/${l}/lab/registry`),
  ops: (l: Locale) => asRoute(`/${l}/ops`),
  settings: (l: Locale) => asRoute(`/${l}/settings`)
};

export { qs as buildQuery };
