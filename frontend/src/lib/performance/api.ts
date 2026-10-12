"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { backendGet } from "@/lib/api/http";
import { backtestRunsQuery } from "@/lib/lab/backtests";
import { isLegacyHistory, matchesQuery, type PicksQuery } from "./filters";
import type {
  BacktestRunsResponse,
  CalibrationResponse,
  FacetsResponse,
  HistoryResponse,
  HistoryRow,
  PicksSummary,
  StatsGroupBy,
  StatsResponse
} from "./types";

/**
 * React Query hooks for the Performance section. Everything is live paper
 * trading (`source=live`); backtests are Model lab territory. Keys live under
 * "performance" so other sections caching the same endpoints in a different
 * shape can never collide with these.
 */

/** /picks/history caps `limit` at 5000; "all rows" views note when they hit it. */
export const HISTORY_CAP = 5000;

export type BetStatus = "settled" | "pending";

const key = (...parts: unknown[]) => ["performance", ...parts] as const;

export function usePicksSummary() {
  return useQuery({
    queryKey: key("summary"),
    queryFn: () => backendGet<PicksSummary>("picks/summary"),
    staleTime: 60_000
  });
}

export function usePicksFacets() {
  return useQuery({
    queryKey: key("facets"),
    queryFn: () => backendGet<FacetsResponse>("picks/facets", { source: "live" }),
    staleTime: 5 * 60_000
  });
}

/** Settled-bet aggregates; `groupBy = []` returns one overall row. */
export function usePicksStats(groupBy: StatsGroupBy[], q: PicksQuery, enabled = true) {
  return useQuery({
    queryKey: key("stats", groupBy.join(","), q),
    queryFn: () =>
      backendGet<StatsResponse>("picks/stats", {
        ...q,
        group_by: groupBy.length ? groupBy : undefined,
        status: "settled",
        source: "live"
      }),
    enabled
  });
}

/** Calibration buckets for one model; the endpoint takes the window, market and competition. */
export function useCalibration(model: string, q: PicksQuery, enabled = true) {
  const params = {
    date_from: q.date_from,
    date_to: q.date_to,
    market: q.market,
    competition: q.competition
  };
  return useQuery({
    queryKey: key("calibration", model, params),
    queryFn: () => backendGet<CalibrationResponse>("picks/stats/calibration", { ...params, model }),
    enabled
  });
}

/** The Lab's run list (same cache, so Lab actions refresh model pages too). */
export function useBacktestRuns() {
  return useQuery({
    ...backtestRunsQuery,
    select: (items: BacktestRunsResponse["items"]): BacktestRunsResponse => ({ items })
  });
}

function fetchHistory(q: PicksQuery, status: BetStatus | undefined, limit: number, offset: number) {
  return backendGet<HistoryResponse>("picks/history", {
    ...q,
    status,
    limit,
    offset: offset || undefined,
    source: "live"
  });
}

export type RowsResult = {
  rows: HistoryRow[];
  /** More bets match than were returned (the 5000-row cap was hit). */
  truncated: boolean;
  /**
   * An older backend returned rows without a competition column, so an active
   * competition filter could not be applied to them (panels must say so).
   */
  competitionIgnored: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => void;
};

/** Every bet matching `q` (up to HISTORY_CAP), for per-bet charts and intervals. */
export function useHistoryRows(q: PicksQuery, status: BetStatus | undefined, enabled = true): RowsResult {
  const query = useQuery({
    queryKey: key("history-all", status ?? "any", q),
    queryFn: () => fetchHistory(q, status, HISTORY_CAP, 0),
    enabled
  });
  const data = query.data;
  const legacy = isLegacyHistory(data);
  const rows = data ? (legacy ? data.rows.filter((r) => matchesQuery(r, q)) : data.rows) : [];
  const truncated = data ? (legacy ? data.rows.length >= HISTORY_CAP : data.count > data.rows.length) : false;
  return {
    rows,
    truncated,
    competitionIgnored: legacy && !!q.competition?.length,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    refetch: () => void query.refetch()
  };
}

export type PageResult = Omit<RowsResult, "truncated"> & {
  /** Total matching bets; null when the backend can't tell. */
  total: number | null;
  /** Showing previous page data while the next one loads. */
  isPlaceholder: boolean;
};

/**
 * One page of bets, newest first. Uses server-side `offset` + total `count`
 * when the backend supports them; older backends return unfiltered, unpaged
 * rows, so then the full list is fetched once and paged in the browser.
 */
export function useBetsPage(
  q: PicksQuery,
  opts: { status?: BetStatus; page: number; pageSize: number; enabled?: boolean }
): PageResult {
  const { status, page, pageSize, enabled = true } = opts;
  const server = useQuery({
    queryKey: key("history-page", status ?? "any", q, page, pageSize),
    queryFn: () => fetchHistory(q, status, pageSize, page * pageSize),
    placeholderData: keepPreviousData,
    enabled
  });
  const legacy = isLegacyHistory(server.data);
  const full = useHistoryRows(q, status, enabled && legacy);

  if (legacy) {
    const start = page * pageSize;
    return {
      rows: full.rows.slice(start, start + pageSize),
      total: full.isLoading ? null : full.rows.length,
      competitionIgnored: full.competitionIgnored,
      isLoading: full.isLoading,
      isError: full.isError,
      error: full.error,
      isFetching: full.isFetching,
      isPlaceholder: false,
      refetch: full.refetch
    };
  }
  return {
    rows: server.data?.rows ?? [],
    total: server.data ? Math.max(server.data.count, page * pageSize + server.data.rows.length) : null,
    competitionIgnored: false,
    isLoading: server.isLoading,
    isError: server.isError,
    error: server.error,
    isFetching: server.isFetching,
    isPlaceholder: server.isPlaceholderData,
    refetch: () => void server.refetch()
  };
}
