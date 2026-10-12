"use client";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { appGet } from "@/lib/api/http";
import type { MatchesQuery, MatchesResponse } from "@/types/scraped-matches";

export const MATCHES_PAGE_SIZE = 50;

export const matchesListKey = ["matches", "list"] as const;

type ListFilters = Omit<MatchesQuery, "offset" | "limit">;

function listParams(query: ListFilters) {
  return {
    q: query.q || undefined,
    sport: query.sport ?? [],
    country: query.country ?? [],
    league: query.league ?? [],
    status: query.status ?? [],
    bets: query.bets ?? [],
    sort: query.sort
  };
}

function listKey(query: ListFilters) {
  return [...matchesListKey, listParams(query)] as const;
}

/**
 * Stored-matches index (GET /api/scraped-matches), paged by offset. Facets
 * come with the first page only; the previous result stays on screen while a
 * new filter combination loads.
 */
export function useMatchesQuery(query: ListFilters) {
  const params = listParams(query);
  return useInfiniteQuery({
    queryKey: listKey(query),
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

/**
 * Whether the list's latest failure was a "load more" rather than a refetch.
 * react-query 5.28 has no isFetchNextPageError yet; the query keeps the failed
 * fetch's meta, which records the paging direction.
 */
export function useNextPageFailed(query: ListFilters, isError: boolean): boolean {
  const qc = useQueryClient();
  return isError && qc.getQueryState(listKey(query))?.fetchMeta?.fetchMore?.direction === "forward";
}
