"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchEventMatchStats } from "@/lib/api-client";
import type { MatchStatsSummary } from "@/types/match-stats";

interface UseMatchStatsDataOptions {
  eventId?: string;
  enabled?: boolean;
}

export function useMatchStatsData({ eventId, enabled = false }: UseMatchStatsDataOptions) {
  return useQuery<MatchStatsSummary, Error>({
    queryKey: ["match-stats", eventId],
    queryFn: () => {
      if (!eventId) {
        throw new Error("Missing event identifier");
      }

      return fetchEventMatchStats(eventId);
    },
    enabled: enabled && Boolean(eventId),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false
  });
}
