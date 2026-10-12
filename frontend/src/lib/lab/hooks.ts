"use client";
import { useCallback, useEffect, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

/** Wall clock that ticks every `intervalMs` while `enabled` (elapsed timers). */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

type Patch = Record<string, string | null | undefined>;

/**
 * URL search params as page state. `set` merges a patch (null/"" removes a
 * key) and replaces the current history entry through the page's route
 * builder, so filters/selection survive reloads and can be shared.
 */
export function useSearchState(build: (query: Record<string, string>) => Route) {
  const params = useSearchParams();
  const router = useRouter();
  const set = useCallback(
    (patch: Patch) => {
      const next: Record<string, string> = Object.fromEntries(params.entries());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") delete next[k];
        else next[k] = v;
      }
      router.replace(build(next), { scroll: false });
    },
    [params, router, build]
  );
  return { params, set };
}

/** Comma-separated id list from a search param, de-duplicated, capped. */
export function idList(raw: string | null, max: number): string[] {
  if (!raw) return [];
  return Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))).slice(0, max);
}
