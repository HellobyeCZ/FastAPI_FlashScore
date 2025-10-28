export interface RawOddsResponse {
  event?: {
    id?: string;
    name?: string;
  };
  markets?: Array<{
    id?: string;
    name?: string;
    selections?: Array<{
      id?: string;
      name?: string;
      odds?: number | string;
      bookmaker?: {
        id?: string;
        name?: string;
      };
      updatedAt?: string;
    }>;
  }>;
  lastUpdate?: string;
  [key: string]: unknown;
}

export interface BookmakerOdds {
  bookmakerId: string;
  bookmakerName: string;
  selectionId: string;
  selectionName: string;
  odds: number | null;
  updatedAt?: string;
}

export interface MarketOdds {
  marketId: string;
  marketName: string;
  selections: BookmakerOdds[];
}

export interface EventOddsSummary {
  eventId: string;
  eventName: string;
  markets: MarketOdds[];
  lastUpdated?: string;
}
