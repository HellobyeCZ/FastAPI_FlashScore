export interface ScrapedMatchSummary {
  eventId: string;
  eventName?: string;
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
  latestStatsFetchedAt?: string;
  latestOddsFetchedAt?: string;
  lastFetchedAt: string;
  statsSnapshotCount: number;
  oddsSnapshotCount: number;
}

export interface ScrapedMatchesResponse {
  total: number;
  matches: ScrapedMatchSummary[];
}
