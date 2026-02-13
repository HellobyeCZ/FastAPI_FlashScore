"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchScrapedMatches } from "@/lib/api-client";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

interface UseScrapedMatchesDataOptions {
  enabled?: boolean;
}

export function useScrapedMatchesData({ enabled = true }: UseScrapedMatchesDataOptions = {}) {
  return useQuery<ScrapedMatchSummary[], Error>({
    queryKey: ["scraped-matches"],
    queryFn: () => fetchScrapedMatches(),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false
  });
}
