export interface RawMatchStatsResponse {
  event?: {
    event_id?: string;
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
  periods: MatchStatsPeriod[];
  lastUpdated?: string;
  source?: string;
}
