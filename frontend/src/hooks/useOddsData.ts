"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchEventOdds } from "@/lib/api-client";
import type { EventOddsSummary } from "@/types/odds";

interface UseOddsDataOptions {
  eventId?: string;
  enabled?: boolean;
  refetchInterval?: number | false;
}

export function useOddsData({
  eventId,
  enabled = false,
  refetchInterval = false
}: UseOddsDataOptions) {
  return useQuery<EventOddsSummary, Error>({
    queryKey: ["odds", eventId],
    queryFn: () => {
      if (!eventId) {
        throw new Error("Missing event identifier");
      }

      return fetchEventOdds(eventId);
    },
    enabled: enabled && Boolean(eventId),
    refetchInterval,
    staleTime: 15_000
  });
}
