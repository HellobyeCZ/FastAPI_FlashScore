"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, appGet, backendGet, errorMessage } from "@/lib/api/http";
import { matchesListKey } from "@/hooks/useMatchesQuery";
import type { EventDetail, EventPicks, PredictResponse } from "./types";
import type { LiveSnapshotRows, LiveSnapshotSummary, OddsResponse, StoredOddsResponse } from "@/types/odds";
import type { MatchStatsResponse, StoredStatsResponse } from "@/types/match-stats";

/**
 * Match-detail data. Every query reads stored data only (FastAPI /events/*,
 * /predict, and the Prisma live-snapshot routes); nothing here reaches
 * FlashScore except `useFetchLatest`, which the page runs only after an
 * explicit confirmation.
 */

/** All keys of one match share the ["match", id] prefix so one invalidation refreshes the page. */
export const matchKeys = {
  all: (id: string) => ["match", id] as const,
  event: (id: string) => ["match", id, "event"] as const,
  odds: (id: string) => ["match", id, "odds"] as const,
  stats: (id: string) => ["match", id, "stats"] as const,
  picks: (id: string) => ["match", id, "picks"] as const,
  predict: (id: string) => ["match", id, "predict"] as const,
  snapshots: (id: string) => ["match", id, "snapshots"] as const,
  snapshot: (id: string, fetchedAt: string) => ["match", id, "snapshots", fetchedAt] as const
};

const enc = encodeURIComponent;

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Resolve a 404 ("nothing stored yet") to null instead of an error. */
async function nullOn404<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** GET /events/{id}. A 404 surfaces as an ApiError the page renders as "not found". */
export function useEvent(eventId: string) {
  return useQuery({
    queryKey: matchKeys.event(eventId),
    queryFn: () => backendGet<EventDetail>(`events/${enc(eventId)}`)
  });
}

/** Latest stored odds snapshot, or null when none is stored. */
export function useStoredOdds(eventId: string) {
  return useQuery({
    queryKey: matchKeys.odds(eventId),
    queryFn: () => nullOn404(backendGet<StoredOddsResponse>(`events/${enc(eventId)}/odds`))
  });
}

/** Latest stored stats snapshot, or null when none is stored. */
export function useStoredStats(eventId: string) {
  return useQuery({
    queryKey: matchKeys.stats(eventId),
    queryFn: () => nullOn404(backendGet<StoredStatsResponse>(`events/${enc(eventId)}/stats`))
  });
}

export function useEventPicks(eventId: string) {
  return useQuery({
    queryKey: matchKeys.picks(eventId),
    queryFn: () => backendGet<EventPicks>(`events/${enc(eventId)}/picks`)
  });
}

export function usePrediction(eventId: string) {
  return useQuery({
    queryKey: matchKeys.predict(eventId),
    queryFn: () => backendGet<PredictResponse>(`predict/${enc(eventId)}`)
  });
}

/** Live captures (live_odds_snapshots), newest first. */
export function useLiveSnapshots(eventId: string) {
  return useQuery({
    queryKey: matchKeys.snapshots(eventId),
    queryFn: () => appGet<LiveSnapshotSummary[]>(`snapshots/${enc(eventId)}`)
  });
}

/** Rows of one live capture; disabled until a capture is chosen. */
export function useLiveSnapshot(eventId: string, fetchedAt: string | null) {
  return useQuery({
    queryKey: matchKeys.snapshot(eventId, fetchedAt ?? ""),
    queryFn: () => appGet<LiveSnapshotRows>(`snapshots/${enc(eventId)}/${enc(fetchedAt ?? "")}`),
    enabled: Boolean(fetchedAt),
    // A capture never changes once written.
    staleTime: Infinity
  });
}

export type FetchLatestResult = {
  fetchedAt: string;
  /** Per-feed failure messages when only one of the two requests succeeded. */
  failed: { feed: "odds" | "stats"; message: string }[];
};

/**
 * Explicit upstream refresh: GET /api/odds/{id} and /api/match-stats/{id}
 * scrape FlashScore and store new snapshots. Throws only when both fail.
 * Afterwards every query of this match (and the matches list) is refetched.
 */
export function useFetchLatest(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FetchLatestResult> => {
      const [odds, stats] = await Promise.allSettled([
        appGet<OddsResponse>(`odds/${enc(eventId)}`),
        appGet<MatchStatsResponse>(`match-stats/${enc(eventId)}`)
      ]);
      const failed: FetchLatestResult["failed"] = [];
      if (odds.status === "rejected") failed.push({ feed: "odds", message: errorMessage(odds.reason) });
      if (stats.status === "rejected") failed.push({ feed: "stats", message: errorMessage(stats.reason) });
      if (odds.status === "rejected" && stats.status === "rejected") throw odds.reason;
      return { fetchedAt: new Date().toISOString(), failed };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: matchKeys.all(eventId) });
      qc.invalidateQueries({ queryKey: matchesListKey });
    }
  });
}
