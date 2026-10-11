"use client";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { appGet } from "@/lib/api/http";
import type { MatchesQuery, MatchesResponse } from "@/types/scraped-matches";

export const MATCHES_PAGE_SIZE = 50;

export const matchesListKey = ["matches", "list"] as const;

/**
 * Stored-matches index (GET /api/scraped-matches), paged by offset. Facets
 * come with the first page only; the previous result stays on screen while a
 * new filter combination loads.
 */
export function useMatchesQuery(query: Omit<MatchesQuery, "offset" | "limit">) {
  const params = {
    q: query.q || undefined,
    sport: query.sport ?? [],
    country: query.country ?? [],
    league: query.league ?? [],
    status: query.status ?? [],
    bets: query.bets ?? [],
    sort: query.sort
  };
  return useInfiniteQuery({
    queryKey: [...matchesListKey, params],
    queryFn: ({ pageParam }) =>
      appGet<MatchesResponse>("scraped-matches", { ...params, offset: pageParam, limit: MATCHES_PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.items.length;
      return last.items.length > 0 && next < last.total ? next : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000
  });
}
