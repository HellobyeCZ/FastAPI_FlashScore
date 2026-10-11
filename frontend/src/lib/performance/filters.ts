import { competitionRoot } from "@/lib/competition";
import { parseDate } from "@/lib/format";
import type { FacetsResponse, HistoryResponse, HistoryRow, PicksSummary } from "./types";

/**
 * Performance filter state. The URL is the single source of truth: every
 * filter is a search param, so back/forward, reload and shared links restore
 * the exact view. Helpers here are pure; `usePerformanceFilters` wires them to
 * the router.
 */

export const WINDOW_PRESETS = ["7d", "30d", "90d", "all", "custom"] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];

const WINDOW_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;

/** Window used when the URL names none and live bets settled recently. */
export const DEFAULT_WINDOW = "90d" satisfies WindowPreset;

/** Below this many settled bets a number is noise: dimmed, never ranked "best". */
export const MIN_N = 30;

export type PerfFilters = {
  /** null = not in the URL; the page picks a default anchored to the data. */
  window: WindowPreset | null;
  /** Custom window bounds, local calendar days (YYYY-MM-DD). */
  from: string | null;
  to: string | null;
  market: string | null;
  /** Competition root (stage suffixes folded, see competitionRoot). */
  competition: string | null;
  model: string | null;
  selection: string | null;
  /** Edge bounds in percentage points (model prob − de-vigged prob). */
  edgeMin: number | null;
  edgeMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
};

export type FilterKey = keyof PerfFilters;

const PARAM: Record<FilterKey, string> = {
  window: "window",
  from: "from",
  to: "to",
  market: "market",
  competition: "competition",
  model: "model",
  selection: "selection",
  edgeMin: "edge_min",
  edgeMax: "edge_max",
  priceMin: "price_min",
  priceMax: "price_max"
};

/** Filters carried between Leaderboard, Bet explorer and model pages. */
export const SHARED_KEYS: readonly FilterKey[] = ["window", "from", "to", "market", "competition", "model"];

/** Explorer-only refinements. */
export const RANGE_KEYS: readonly FilterKey[] = ["selection", "edgeMin", "edgeMax", "priceMin", "priceMax"];

type ParamReader = { get(name: string): string | null };

const DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;

/**
 * A complete calendar day (YYYY-MM-DD) in a plausible year. Date inputs emit
 * intermediate values such as 0002-05-01 while a year is being typed; those
 * must never reach the URL.
 */
export function isPlausibleDay(v: string | null | undefined): v is string {
  const m = v ? DATE_RE.exec(v) : null;
  if (!m) return false;
  const year = Number(m[1]);
  return year >= 2000 && year <= 2100 && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function readNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readText(raw: string | null): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

export function isWindowPreset(v: string | null | undefined): v is WindowPreset {
  return !!v && (WINDOW_PRESETS as readonly string[]).includes(v);
}

export function parseFilters(sp: ParamReader): PerfFilters {
  const window = sp.get(PARAM.window);
  const from = sp.get(PARAM.from);
  const to = sp.get(PARAM.to);
  return {
    window: isWindowPreset(window) ? window : null,
    from: isPlausibleDay(from) ? from : null,
    to: isPlausibleDay(to) ? to : null,
    market: readText(sp.get(PARAM.market)),
    competition: readText(sp.get(PARAM.competition)),
    model: readText(sp.get(PARAM.model)),
    selection: readText(sp.get(PARAM.selection)),
    edgeMin: readNumber(sp.get(PARAM.edgeMin)),
    edgeMax: readNumber(sp.get(PARAM.edgeMax)),
    priceMin: readNumber(sp.get(PARAM.priceMin)),
    priceMax: readNumber(sp.get(PARAM.priceMax))
  };
}

/** Search-param form of `keys` (all keys by default), omitting empty values. */
export function filtersToParams(
  f: PerfFilters,
  keys: readonly FilterKey[] = Object.keys(PARAM) as FilterKey[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = f[k];
    if (v === null || v === "") continue;
    out[PARAM[k]] = String(v);
  }
  return out;
}

/** Writes `patch` into a copy of `sp` (null removes the param). */
export function applyPatch(sp: ParamReader & { toString(): string }, patch: Partial<PerfFilters>): URLSearchParams {
  const next = new URLSearchParams(sp.toString());
  for (const [k, v] of Object.entries(patch) as [FilterKey, PerfFilters[FilterKey]][]) {
    if (v === null || v === undefined || v === "") next.delete(PARAM[k]);
    else next.set(PARAM[k], String(v));
  }
  return next;
}

/** Number of non-window filters set (shown on the mobile filter toggle). */
export function activeFilterCount(f: PerfFilters, keys: readonly FilterKey[]): number {
  return keys.filter((k) => k !== "window" && k !== "from" && k !== "to" && f[k] !== null).length;
}

// ---------------------------------------------------------------------------
// Window anchoring

/** Latest settlement time known to the summary endpoint (newer field first). */
export function lastSettledAt(summary: PicksSummary | undefined): string | null {
  if (!summary) return null;
  if (summary.last_settled_at) return summary.last_settled_at;
  let latest = -Infinity;
  let iso: string | null = null;
  for (const s of summary.settled_series ?? []) {
    const t = parseDate(s.settled_at)?.getTime();
    if (t !== undefined && t > latest) {
      latest = t;
      iso = s.settled_at;
    }
  }
  return iso;
}

export type WindowResolution = {
  window: WindowPreset;
  /** The URL named no window; `window` was chosen from the data. */
  auto: boolean;
  /** Set when the default fell back to all time because nothing settled recently. */
  staleSince: string | null;
  /** False until the default can be decided (summary still loading). */
  ready: boolean;
};

/**
 * Picks the effective window. An explicit URL choice always wins. Otherwise
 * default to the last 90 days, unless no live bet settled in that period —
 * then show all time and say why, instead of rendering an empty page.
 */
export function resolveWindow(
  explicit: WindowPreset | null,
  summary: { isLoading: boolean; isError: boolean; data?: PicksSummary },
  today: Date
): WindowResolution {
  if (explicit) return { window: explicit, auto: false, staleSince: null, ready: true };
  if (summary.isLoading) return { window: DEFAULT_WINDOW, auto: true, staleSince: null, ready: false };
  if (summary.isError || !summary.data) return { window: "all", auto: true, staleSince: null, ready: true };
  const last = lastSettledAt(summary.data);
  if (!last) return { window: "all", auto: true, staleSince: null, ready: true };
  const lastMs = parseDate(last)?.getTime() ?? 0;
  const cutoff = presetStart(DEFAULT_WINDOW, today).getTime();
  return lastMs < cutoff
    ? { window: "all", auto: true, staleSince: last, ready: true }
    : { window: DEFAULT_WINDOW, auto: true, staleSince: null, ready: true };
}

/** Local midnight `days` days before `today` (stable for the whole day → stable query keys). */
function presetStart(preset: keyof typeof WINDOW_DAYS, today: Date): Date {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - WINDOW_DAYS[preset]);
  return d;
}

function localDay(day: string, end: boolean): string {
  const d = new Date(`${day}T00:00:00`);
  if (end) d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export type DateRange = { from: string | null; to: string | null };

/** ISO bounds for the window (settled_at, falling back to recommended_at server-side). */
export function windowRange(window: WindowPreset, f: Pick<PerfFilters, "from" | "to">, today: Date): DateRange {
  if (window === "all") return { from: null, to: null };
  if (window === "custom") {
    return { from: f.from ? localDay(f.from, false) : null, to: f.to ? localDay(f.to, true) : null };
  }
  return { from: presetStart(window, today).toISOString(), to: null };
}

// ---------------------------------------------------------------------------
// API query

/** Query params shared by /picks/stats, /picks/history and calibration. */
export type PicksQuery = {
  date_from?: string;
  date_to?: string;
  model?: string[];
  market?: string[];
  competition?: string[];
  selection?: string[];
  edge_min?: number;
  edge_max?: number;
  price_min?: number;
  price_max?: number;
};

/** Every raw competition name whose root is `root` ("Chance Liga - Relegation Group" → "Chance Liga"). */
export function competitionVariants(root: string, facets?: FacetsResponse): string[] {
  const variants = (facets?.competitions ?? []).filter((c) => competitionRoot(c) === root);
  return variants.length ? variants : [root];
}

/** Distinct competition roots, sorted. */
export function competitionRoots(facets?: FacetsResponse): string[] {
  const roots = new Set<string>();
  for (const c of facets?.competitions ?? []) {
    const r = competitionRoot(c);
    if (r) roots.add(r);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

export function toPicksQuery(
  f: PerfFilters,
  range: DateRange,
  facets: FacetsResponse | undefined,
  keys: readonly FilterKey[]
): PicksQuery {
  const has = (k: FilterKey) => keys.includes(k) && f[k] !== null;
  const q: PicksQuery = {};
  if (range.from) q.date_from = range.from;
  if (range.to) q.date_to = range.to;
  if (has("model")) q.model = [f.model!];
  if (has("market")) q.market = [f.market!];
  if (has("competition")) q.competition = competitionVariants(f.competition!, facets);
  if (has("selection")) q.selection = [f.selection!];
  if (has("edgeMin")) q.edge_min = f.edgeMin! / 100;
  if (has("edgeMax")) q.edge_max = f.edgeMax! / 100;
  if (has("priceMin")) q.price_min = f.priceMin!;
  if (has("priceMax")) q.price_max = f.priceMax!;
  return q;
}

// ---------------------------------------------------------------------------
// Older /picks/history payloads (before spec §4.3) ignore filters and offset
// and carry no joined team/competition columns. Detect them and apply the same
// filters client-side so every panel still shows one population.

export function isLegacyHistory(res: HistoryResponse | undefined): boolean {
  const first = res?.rows[0];
  return !!first && !("home_team" in first);
}

function inList(value: string | null | undefined, list: string[] | undefined): boolean {
  return !list?.length || (value !== null && value !== undefined && list.includes(value));
}

export function matchesQuery(row: HistoryRow, q: PicksQuery): boolean {
  const t = parseDate(row.settled_at ?? row.recommended_at)?.getTime();
  if (q.date_from && (t === undefined || t < (parseDate(q.date_from)?.getTime() ?? 0))) return false;
  if (q.date_to && (t === undefined || t > (parseDate(q.date_to)?.getTime() ?? Infinity))) return false;
  if (!inList(row.model, q.model) || !inList(row.market, q.market) || !inList(row.selection, q.selection)) return false;
  // Legacy rows have no competition column; the server-side stats still apply it.
  if (q.competition?.length && row.competition != null && !q.competition.includes(row.competition)) return false;
  const edge = row.edge;
  if (q.edge_min !== undefined && (edge === null || edge < q.edge_min)) return false;
  if (q.edge_max !== undefined && (edge === null || edge > q.edge_max)) return false;
  const price = row.price_at_recommendation;
  if (q.price_min !== undefined && (price === null || price < q.price_min)) return false;
  if (q.price_max !== undefined && (price === null || price > q.price_max)) return false;
  return true;
}
