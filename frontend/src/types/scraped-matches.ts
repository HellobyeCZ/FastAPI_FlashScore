/**
 * GET /api/scraped-matches — the stored-matches index (Prisma, read-only).
 * Contract between app/api/scraped-matches/route.ts and the Matches page.
 */

/**
 * Display status derived from stored facts, not from the upstream `status`
 * column (which says "finished" even for fixtures captured before kick-off):
 * - finished:    a result (outcome) or a terminal stats snapshot is stored
 * - live:        upstream reports the match in play
 * - scheduled:   kick-off is in the future
 * - unconfirmed: kick-off has passed but no result was captured
 */
export type MatchStatusKind = "finished" | "live" | "scheduled" | "unconfirmed";

export const MATCH_STATUS_KINDS: readonly MatchStatusKind[] = ["finished", "live", "scheduled", "unconfirmed"];

/** Bet filters: matches with live paper bets and/or backtest bets. */
export type MatchBetsKind = "live" | "backtest";

export const MATCH_BETS_KINDS: readonly MatchBetsKind[] = ["live", "backtest"];

export type MatchesSort = "kickoff_desc" | "kickoff_asc" | "fetched_desc";

export const MATCHES_SORTS: readonly MatchesSort[] = ["kickoff_desc", "kickoff_asc", "fetched_desc"];

/** Query parameters accepted by the route (lists are comma-separated). */
export type MatchesQuery = {
  q?: string;
  sport?: readonly string[];
  country?: readonly string[];
  /** League roots, as folded by competitionRoot(). */
  league?: readonly string[];
  status?: readonly MatchStatusKind[];
  bets?: readonly MatchBetsKind[];
  sort?: MatchesSort;
  offset?: number;
  limit?: number;
  /** false skips facet counts (cheap id lookups). */
  facets?: boolean;
};

export type MatchListItem = {
  event_id: string;
  home_team: string | null;
  away_team: string | null;
  /** Upstream event name, used only when team names are missing. */
  event_name: string | null;
  sport: string | null;
  country: string | null;
  /** Full competition incl. stage suffix ("Chance Liga - Championship Group"). */
  competition: string | null;
  start_time_utc: string | null;
  status: MatchStatusKind;
  /** home_win | draw | away_win, when a result is stored. */
  outcome: string | null;
  /** Final score from the derived labels (Phase 1 scope only); null elsewhere. */
  score: { home: number; away: number } | null;
  odds_snapshots: number;
  stats_snapshots: number;
  /** max(latest odds fetch, latest stats fetch); null when never fetched. */
  last_fetched_at: string | null;
  live_bets: number;
  backtest_bets: number;
};

export type FacetCount = { value: string; count: number };

export type MatchFacets = {
  sport: FacetCount[];
  country: FacetCount[];
  /** Folded with competitionRoot() ("NHL - Play Offs" counts as "NHL"). */
  league: FacetCount[];
  status: FacetCount[];
  bets: FacetCount[];
};

export type MatchesResponse = {
  items: MatchListItem[];
  /** Rows matching every active filter (search, facets, status, bets). */
  total: number;
  offset: number;
  limit: number;
  /**
   * Counts per option with every *other* active filter applied, so choosing
   * one country still shows how many matches the other countries have.
   * Only computed for the first page (offset 0), unless `facets=0`.
   */
  facets?: MatchFacets;
  /** Present when the search text is exactly a stored event id (ignores filters). */
  exact: MatchListItem | null;
};
