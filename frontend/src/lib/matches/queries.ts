"use client";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, appGet, appPost, backendGet, errorMessage } from "@/lib/api/http";
import { parseDate } from "@/lib/format";
import { matchesListKey } from "@/hooks/useMatchesQuery";
import { boardFromLive, boardFromStored, type OddsBoard } from "./odds";
import type { EventDetail, EventPicks, PredictResponse } from "./types";
import type { LiveSnapshotRows, LiveSnapshotSummary, OddsResponse, StoredOddsResponse } from "@/types/odds";
import type { MatchStatsResponse, StoredStatsResponse } from "@/types/match-stats";
import type { MatchesResponse } from "@/types/scraped-matches";

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

/**
 * Whether an id is in the stored-matches index (match_event_summaries). Used
 * to tell "unknown event" apart from "the event endpoint failed" when
 * /events/{id} answers 404.
 */
export function useStoredMatchLookup(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["matches", "lookup", eventId],
    queryFn: () => appGet<MatchesResponse>("scraped-matches", { q: eventId, limit: 1, facets: 0 }),
    enabled
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

/**
 * Current model predictions. Disabled for finished matches: /predict scores
 * with today's features, which already include the match's own result.
 */
export function usePrediction(eventId: string, enabled = true) {
  return useQuery({
    queryKey: matchKeys.predict(eventId),
    queryFn: () => backendGet<PredictResponse>(`predict/${enc(eventId)}`),
    enabled
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

/** Odds source value for the stored snapshot; any other value is a live capture's fetched_at. */
export const STORED_SOURCE = "stored";

function time(iso: string | null | undefined): number {
  return parseDate(iso)?.getTime() ?? -Infinity;
}

/**
 * Which odds a match opens with: the newer of the latest stored snapshot and
 * the newest live capture. `source` is STORED_SOURCE, a capture's fetched_at,
 * or null when nothing is stored; `settled` is false until both lists loaded.
 */
export function useDefaultOddsSource(eventId: string) {
  const stored = useStoredOdds(eventId);
  const snapshots = useLiveSnapshots(eventId);
  const storedAt = stored.data?.fetched_at ?? null;
  const liveAt = snapshots.data?.[0]?.fetched_at ?? null;
  const source = liveAt && time(liveAt) > time(storedAt) ? liveAt : storedAt ? STORED_SOURCE : null;
  return { stored, snapshots, source, settled: !stored.isLoading && !snapshots.isLoading };
}

export type BoardSource = { kind: "stored" | "live"; fetchedAt: string };

/**
 * The odds board the model view prices against — the same default board the
 * odds panel opens with, so best prices there and on the board agree.
 */
export function useReferenceBoard(eventId: string): {
  board: OddsBoard | null;
  source: BoardSource | null;
  isLoading: boolean;
} {
  const { stored, source, settled } = useDefaultOddsSource(eventId);
  const liveAt = source && source !== STORED_SOURCE ? source : null;
  const live = useLiveSnapshot(eventId, liveAt);
  return useMemo(() => {
    if (liveAt && live.data) {
      return {
        board: boardFromLive(live.data.rows),
        source: { kind: "live", fetchedAt: live.data.fetched_at },
        isLoading: false
      };
    }
    if (!liveAt && stored.data) {
      return {
        board: boardFromStored(stored.data),
        source: { kind: "stored", fetchedAt: stored.data.fetched_at },
        isLoading: false
      };
    }
    return { board: null, source: null, isLoading: !settled || (liveAt !== null && live.isLoading) };
  }, [liveAt, live.data, live.isLoading, stored.data, settled]);
}

export type FetchLatestResult = {
  fetchedAt: string;
  /** Per-feed failure messages when only one of the two requests succeeded. */
  failed: { feed: "odds" | "stats"; message: string }[];
};

/**
 * Explicit upstream refresh: POST /api/odds/{id} and /api/match-stats/{id}
 * scrape FlashScore and store new snapshots. Throws only when both fail.
 * Afterwards every query of this match (and the matches list) is refetched.
 */
export function useFetchLatest(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FetchLatestResult> => {
      const [odds, stats] = await Promise.allSettled([
        appPost<OddsResponse>(`odds/${enc(eventId)}`),
        appPost<MatchStatsResponse>(`match-stats/${enc(eventId)}`)
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
