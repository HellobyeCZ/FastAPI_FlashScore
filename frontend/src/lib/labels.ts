import type { MessageKey } from "@/lib/i18n";

/**
 * Human labels for backend enums. Pages must never print raw keys like
 * "HOME_DRAW_AWAY:FULL_TIME" or "1X2_FT" — route them through these helpers.
 */

export const KNOWN_MODELS = [
  "market_implied",
  "vig_included",
  "logistic",
  "hgb",
  "hgb_pca",
  "dixon_coles"
] as const;
export type KnownModel = (typeof KNOWN_MODELS)[number];

export const BASELINE_MODELS: readonly string[] = ["market_implied", "vig_included"];

/** Strip calibration suffixes produced by offline scripts: logistic_cal → logistic. */
export function baseModel(name: string): string {
  return name.replace(/_(cal|uncal)$/, "").replace(/^dc_/, "dixon_coles_");
}

export function modelLabelKey(name: string): MessageKey | null {
  const base = baseModel(name);
  return (KNOWN_MODELS as readonly string[]).includes(base) ? (`model.${base}` as MessageKey) : null;
}

/** Returns a translated model name, keeping unknown names readable. */
export function modelLabel(name: string, t: (k: MessageKey) => string): string {
  const key = modelLabelKey(name);
  const base = key ? t(key) : name.replace(/_/g, " ");
  const suffix = name.match(/_(cal|uncal)$/)?.[1];
  return suffix ? `${base} (${suffix})` : base;
}

const MODEL_COLOR_VAR: Record<string, string> = {
  logistic: "--cat-1",
  dixon_coles: "--cat-2",
  hgb: "--cat-3",
  hgb_pca: "--cat-4",
  market_implied: "--cat-7",
  vig_included: "--cat-8"
};
const FALLBACK_VARS = ["--cat-5", "--cat-6", "--cat-1", "--cat-2", "--cat-3", "--cat-4"];

/** Stable categorical color for a model/series (CSS color string). */
export function modelColor(name: string, index = 0): string {
  const v = MODEL_COLOR_VAR[baseModel(name)] ?? FALLBACK_VARS[index % FALLBACK_VARS.length];
  return `rgb(var(${v}))`;
}

/** Any series key → color, cycling through the categorical palette. */
export function seriesColor(index: number): string {
  const all = ["--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6", "--cat-7"];
  return `rgb(var(${all[index % all.length]}))`;
}

type MarketKind = "1x2" | "ou25" | "btts";

export function marketKind(market: string): MarketKind | null {
  const m = market.toUpperCase();
  if (m === "1X2_FT" || m.startsWith("HOME_DRAW_AWAY")) return "1x2";
  if (m.startsWith("OVER_UNDER")) return "ou25";
  if (m === "BTTS_FT" || m.startsWith("BOTH_TEAMS")) return "btts";
  return null;
}

export function marketLabel(market: string, t: (k: MessageKey) => string): string {
  const kind = marketKind(market);
  if (kind) return t(`market.${kind}` as MessageKey);
  return market
    .replace(/[_:]+/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

const SELECTIONS = ["home", "draw", "away", "over", "under", "yes", "no"] as const;

export function selectionLabel(selection: string, t: (k: MessageKey) => string): string {
  const s = selection.toLowerCase();
  return (SELECTIONS as readonly string[]).includes(s) ? t(`selection.${s}` as MessageKey) : selection;
}

/** Short 1X2 notation used in dense tables: home → 1, draw → X, away → 2. */
export function selectionShort(selection: string): string {
  const s = selection.toLowerCase();
  return s === "home" ? "1" : s === "draw" ? "X" : s === "away" ? "2" : selection;
}

export type Tone = "neutral" | "accent" | "pos" | "neg" | "warn" | "info";

/** Status/outcome vocabulary → translated label + tone. */
export type StateKey =
  | "open"
  | "pending"
  | "won"
  | "lost"
  | "void"
  | "live"
  | "finished"
  | "scheduled"
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
  | "ok"
  | "error";

export const STATE_TONE: Record<StateKey, Tone> = {
  open: "accent",
  pending: "warn",
  won: "pos",
  lost: "neg",
  void: "neutral",
  live: "accent",
  finished: "neutral",
  scheduled: "info",
  queued: "info",
  running: "warn",
  completed: "pos",
  completed_with_errors: "warn",
  failed: "neg",
  cancelled: "neutral",
  ok: "pos",
  error: "neg"
};

/** Map loose backend strings ("FT", "settled", "ERR", result 1/0) to a StateKey. */
export function normalizeState(raw: string | number | null | undefined): StateKey | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).toLowerCase();
  const map: Record<string, StateKey> = {
    open: "open",
    pending: "pending",
    pend: "pending",
    won: "won",
    win: "won",
    "1": "won",
    "1.0": "won",
    lost: "lost",
    loss: "lost",
    "0": "lost",
    "0.0": "lost",
    void: "void",
    "0.5": "void",
    live: "live",
    ft: "finished",
    finished: "finished",
    sched: "scheduled",
    scheduled: "scheduled",
    queued: "queued",
    running: "running",
    run: "running",
    completed: "completed",
    completed_with_errors: "completed_with_errors",
    failed: "failed",
    cancelled: "cancelled",
    ok: "ok",
    err: "error",
    error: "error"
  };
  return map[s] ?? null;
}
