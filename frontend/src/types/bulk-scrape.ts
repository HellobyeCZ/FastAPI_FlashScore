export interface BulkScrapeJob {
  id: number;
  competitionPath: string;
  seasons: number;
  includeStats: boolean;
  includeOdds: boolean;
  maxConcurrency: number;
  status: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
  totalEvents: number;
  pendingEvents: number;
  runningEvents: number;
  succeededEvents: number;
  failedEvents: number;
  skippedEvents: number;
}

export interface BulkScrapeJobEvent {
  eventId: string;
  seasonPath?: string;
  status: string;
  attempts: number;
  skippedReason?: string;
  lastError?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface BulkScrapeJobDetail extends BulkScrapeJob {
  events: BulkScrapeJobEvent[];
}

export interface StartBulkScrapeJobPayload {
  competitionPath: string;
  seasons?: number;
  includeStats?: boolean;
  includeOdds?: boolean;
  maxConcurrency?: number;
}
