"use client";
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { asRoute } from "@/lib/routes";
import { usePicksFacets, usePicksSummary } from "./api";
import {
  applyPatch,
  filtersToParams,
  parseFilters,
  resolveWindow,
  SHARED_KEYS,
  toPicksQuery,
  windowRange,
  type FilterKey,
  type PerfFilters
} from "./filters";

/**
 * URL-backed filter state for one Performance page. `keys` lists the filters
 * the page offers (the window is always on). The resolved window is anchored
 * to the data: with no `window` param it is the last 90 days, or all time when
 * nothing settled in that period (`staleSince` says since when).
 */
export function usePerformanceFilters(keys: readonly FilterKey[]) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // One "today" per page visit keeps rolling windows (and query keys) stable.
  const [today] = useState(() => new Date());

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const summary = usePicksSummary();
  const facets = usePicksFacets();
  const resolution = resolveWindow(filters.window, summary, today);
  const range = useMemo(
    () => windowRange(resolution.window, filters, today),
    [resolution.window, filters, today]
  );
  // Competition roots expand to their raw stage variants, which come from
  // facets. Without them the filter would silently match nothing, so queries
  // wait for facets and, if facets fail, panels report that instead.
  const needsFacets = keys.includes("competition") && filters.competition !== null && !facets.data;
  const waitsForFacets = needsFacets && facets.isLoading;
  const blocker = needsFacets && facets.isError ? facets : null;
  const query = useMemo(() => toPicksQuery(filters, range, facets.data, keys), [filters, range, facets.data, keys]);

  const replace = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.replace(asRoute(qs ? `${pathname}?${qs}` : pathname), { scroll: false });
    },
    [router, pathname]
  );

  /** Changes filters; any change returns the bet table to its first page. */
  const update = useCallback(
    (patch: Partial<PerfFilters>) => {
      const next = applyPatch(searchParams, patch);
      next.delete("page");
      replace(next);
    },
    [searchParams, replace]
  );

  /** Sets a non-filter param (sort, page); null removes it. */
  const setParam = useCallback(
    (values: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(values)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      replace(next);
    },
    [searchParams, replace]
  );

  /** Clears every filter this page offers, keeping the window. */
  const clearFilters = useCallback(() => {
    const patch: Partial<PerfFilters> = {};
    for (const k of keys) if (k !== "window" && k !== "from" && k !== "to") patch[k] = null;
    update(patch);
  }, [keys, update]);

  return {
    filters,
    keys,
    window: resolution.window,
    auto: resolution.auto,
    staleSince: resolution.staleSince,
    ready: resolution.ready && !waitsForFacets && !blocker,
    /** Failed query every panel depends on (facets, for a competition filter). */
    blocker,
    range,
    query,
    facets,
    summary,
    update,
    setParam,
    clearFilters,
    /** Filters to carry into links to sibling pages. */
    sharedParams: filtersToParams(filters, SHARED_KEYS),
    searchParams
  };
}

export type PerformanceFilterState = ReturnType<typeof usePerformanceFilters>;
