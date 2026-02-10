export interface RawMatchStatsResponse {
  event?: {
    event_id?: string;
    home_team?: string;
    away_team?: string;
    sport?: string;
    country?: string;
    competition?: string;
    competition_stage?: string;
    competition_path?: string;
    start_time_utc?: string;
    status?: string;
    status_detail?: string;
    outcome?: string;
    periods?: Array<{
      name?: string;
      categories?: Array<{
        name?: string;
        stats?: Array<{
          code?: string;
          label?: string;
          home?: string;
          away?: string;
        }>;
      }>;
    }>;
  };
  retrieved_at?: string;
  source?: string;
}

export interface MatchStatItem {
  code?: string;
  label: string;
  home: string;
  away: string;
}

export interface MatchStatsCategory {
  name: string;
  stats: MatchStatItem[];
}

export interface MatchStatsPeriod {
  name: string;
  categories: MatchStatsCategory[];
}

export interface MatchStatsSummary {
  eventId: string;
  homeTeam?: string;
  awayTeam?: string;
  sport?: string;
  country?: string;
  competition?: string;
  competitionStage?: string;
  competitionPath?: string;
  startTimeUtc?: string;
  status?: string;
  statusDetail?: string;
  outcome?: string;
  periods: MatchStatsPeriod[];
  lastUpdated?: string;
  source?: string;
}
