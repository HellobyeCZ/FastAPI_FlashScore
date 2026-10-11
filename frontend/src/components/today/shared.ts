import { ageHours } from "@/lib/format";
import type { Tone } from "@/lib/labels";

/**
 * Pipeline freshness from the last recorded pick. One rule for the KPI tone
 * and the slate's empty state, and the same thresholds as the backend's
 * `pipeline_stale` health check (warn after 36 h, error after 7 days).
 */
export type Freshness = "never" | "fresh" | "stale" | "dead";

export const STALE_AFTER_HOURS = 36;
export const DEAD_AFTER_HOURS = 7 * 24;

export function pipelineFreshness(lastRecordedAt: string | null | undefined, now: Date = new Date()): Freshness {
  if (!lastRecordedAt) return "never";
  const age = ageHours(lastRecordedAt, now);
  if (!Number.isFinite(age)) return "never";
  if (age < STALE_AFTER_HOURS) return "fresh";
  return age < DEAD_AFTER_HOURS ? "stale" : "dead";
}

export const FRESHNESS_TONE: Record<Freshness, Tone> = {
  never: "neg",
  fresh: "pos",
  stale: "warn",
  dead: "neg"
};

/** Edge thresholds offered on the slate (fractions). */
export const EDGE_PRESETS = [0, 0.01, 0.03, 0.05] as const;
export type EdgePreset = (typeof EDGE_PRESETS)[number];

/**
 * Snap any edge (URL param, saved setting) to the nearest preset at or below
 * it, so the control always has a selected option and the filter never shows
 * fewer picks than the value asked for. Invalid input yields null.
 */
export function snapEdge(raw: string | number | null | undefined): EdgePreset | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const v = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(v) || v < 0 || v >= 1) return null;
  let snapped: EdgePreset = 0;
  for (const p of EDGE_PRESETS) if (p <= v + 1e-9) snapped = p;
  return snapped;
}

/** A pick passes the threshold only when its edge is known and high enough. */
export function passesEdge(edge: number | null, min: number): boolean {
  if (min <= 0) return true;
  return edge !== null && edge >= min - 1e-9;
}
