/**
 * FastAPI `OddsResponse` (app/schemas/odds.py). Served from storage by
 * GET /events/{id}/odds and scraped on demand by GET /odds/{id}.
 *
 * Selections are opaque upstream ids (participant ids, `OVER`, or
 * `<MARKET_KEY>:<n>` for positional outcomes); lib/matches/odds.ts turns them
 * into home/draw/away/over/… sides. Never label them by position alone.
 */
export type OddsOutcome = {
  id: string | null;
  label: string | null;
  selection_key: string | null;
  odds_decimal: number | null;
  odds_fractional?: string | null;
  probability?: number | null;
};

export type OddsMarket = {
  id: string | null;
  name: string | null;
  /** "<BETTING_TYPE>:<SCOPE>", e.g. "HOME_DRAW_AWAY:FULL_TIME". */
  key: string | null;
  outcomes: OddsOutcome[];
};

export type BookmakerOdds = {
  id: string | null;
  name: string | null;
  region?: string | null;
  markets: OddsMarket[];
};

export type OddsResponse = {
  event: {
    event_id: string;
    event_name?: string | null;
    competition_name?: string | null;
    start_time?: string | null;
    bookmakers: BookmakerOdds[];
  };
  retrieved_at: string;
  source?: string | null;
};

/** GET /events/{id}/odds: the latest stored snapshot (never scrapes). */
export type StoredOddsResponse = OddsResponse & {
  fetched_at: string;
  served_from: "stored";
};

/** One row of a live_odds_snapshots capture (GET /api/snapshots/{id}/{fetchedAt}). */
export type LiveOddsRow = {
  bookmaker: string | null;
  market: string;
  /** Participant id, OVER/UNDER, ODD/EVEN or DRAW, plus "@<handicap>" for lines. */
  selection_key: string;
  price: number;
};

export type LiveSnapshotRows = {
  event_id: string;
  fetched_at: string;
  rows: LiveOddsRow[];
};

/** One live capture in the snapshot strip (GET /api/snapshots/{id}). */
export type LiveSnapshotSummary = {
  fetched_at: string;
  rows: number;
  bookmakers: number;
  markets: number;
};
