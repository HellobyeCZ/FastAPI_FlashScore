"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

export type MatchesSort =
  | "last_fetch_desc"
  | "kickoff_desc"
  | "kickoff_asc"
  | "snaps_desc";

export type MatchesQueryParams = {
  q?: string;
  countries: string[];
  leagues: string[];
  statuses: string[];
  sort: MatchesSort;
  limit?: number;
};

export type MatchesPage = {
  matches: ScrapedMatchSummary[];
  nextCursor: string | null;
  total: number;
  facets?: {
    country: { value: string; count: number }[];
    league: { value: string; count: number }[];
    status: { value: string; count: number }[];
  };
};

function buildQs(p: MatchesQueryParams, cursor?: string, withFacets?: boolean) {
  const qs = new URLSearchParams();
  if (p.q && p.q.trim()) qs.set("q", p.q.trim());
  p.countries.forEach((c) => qs.append("country", c));
  p.leagues.forEach((l) => qs.append("league", l));
  p.statuses.forEach((s) => qs.append("status", s));
  qs.set("sort", p.sort);
  qs.set("limit", String(p.limit ?? 50));
  if (cursor) qs.set("cursor", cursor);
  if (withFacets) qs.set("withFacets", "1");
  return qs.toString();
}

export function useMatchesQuery(params: MatchesQueryParams) {
  const queryKey = [
    "matches",
    params.q ?? "",
    params.countries.slice().sort().join(","),
    params.leagues.slice().sort().join(","),
    params.statuses.slice().sort().join(","),
    params.sort,
    params.limit ?? 50,
  ] as const;

  return useInfiniteQuery<MatchesPage>({
    queryKey,
    queryFn: async ({ pageParam }) => {
      // Facets only on the first page — they're computed from the filter
      // set, not the page slice, so we don't need to re-request per page.
      const withFacets = !pageParam;
      const r = await fetch(
        `/api/scraped-matches?${buildQs(params, pageParam as string | undefined, withFacets)}`,
      );
      if (!r.ok) throw new Error(`matches ${r.status}`);
      return (await r.json()) as MatchesPage;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
