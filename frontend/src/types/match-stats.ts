/**
 * FastAPI `MatchStatsResponse` (app/schemas/match_stats.py). Served from
 * storage by GET /events/{id}/stats and scraped on demand by
 * GET /match-stats/{id}. Values are display strings ("57%", "85% (355/419)").
 */
export type MatchStat = {
  code: string | null;
  label: string | null;
  home: string | null;
  away: string | null;
};

export type MatchStatsCategory = {
  name: string;
  stats: MatchStat[];
};

export type MatchStatsPeriod = {
  /** "Match", "1st Half", "2nd Half", "1st Period", … */
  name: string;
  categories: MatchStatsCategory[];
};

export type MatchStatsResponse = {
  event: {
    event_id: string;
    home_team?: string | null;
    away_team?: string | null;
    sport?: string | null;
    country?: string | null;
    competition?: string | null;
    competition_stage?: string | null;
    competition_path?: string | null;
    start_time_utc?: string | null;
    status?: string | null;
    status_detail?: string | null;
    outcome?: string | null;
    periods: MatchStatsPeriod[];
  };
  retrieved_at: string;
  source?: string | null;
};

/** GET /events/{id}/stats: the latest stored snapshot (never scrapes). */
export type StoredStatsResponse = MatchStatsResponse & { fetched_at: string };
