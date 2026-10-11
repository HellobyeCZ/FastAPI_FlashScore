/**
 * Match-detail contracts with FastAPI (spec §4.2, app/routes/events.py) and
 * the existing /predict endpoint. Every call here reads stored data only;
 * nothing on page load reaches FlashScore.
 */

/** GET /events/{event_id} (404 when the event is unknown). */
export type EventDetail = {
  event_id: string;
  home_team: string | null;
  away_team: string | null;
  sport: string | null;
  country: string | null;
  competition: string | null;
  competition_path: string | null;
  start_time_utc: string | null;
  /** Raw upstream status — untrusted ("finished" for pre-match captures). */
  status: string | null;
  status_detail: string | null;
  outcome: string | null;
  score: { home: number | string | null; away: number | string | null } | null;
  /** True once a terminal stats snapshot exists; the archive is then frozen. */
  is_terminal: boolean;
  latest_odds_fetched_at: string | null;
  latest_stats_fetched_at: string | null;
  odds_snapshot_count: number;
  stats_snapshot_count: number;
};

/** Live paper bet (paper_bets row). */
export type PaperBetRow = {
  id: number | string;
  event_id: string;
  model: string;
  /** Live vocabulary: "1X2_FT", "OVER_UNDER_2.5_FT", "BTTS_FT". */
  market: string;
  selection: string;
  recommended_at: string | null;
  price_at_recommendation: number | null;
  closing_price: number | null;
  model_prob: number | null;
  devigged_prob: number | null;
  edge: number | null;
  kelly_full: number | null;
  result: number | null;
  pnl: number | null;
  clv: number | null;
  /** pending | settled | voided */
  status: string;
  settled_at?: string | null;
  model_version?: string | null;
};

/** Backtest bet (backtest_bets row) with its run's label and model. */
export type BacktestBetRow = {
  run_id: string;
  run_label: string | null;
  model: string;
  event_id: string;
  bet_ts: string | null;
  kickoff_ts: string | null;
  /** Archive vocabulary: "HOME_DRAW_AWAY:FULL_TIME". */
  market: string;
  selection: string;
  price_taken: number | null;
  closing_price: number | null;
  model_prob: number | null;
  implied_prob: number | null;
  devigged_prob: number | null;
  edge: number | null;
  stake_kelly_fraction: number | null;
  result: number | null;
  pnl: number | null;
  /** Undefined for backtests (bets are priced at the close) → null. */
  clv: number | null;
};

/** GET /events/{event_id}/picks */
export type EventPicks = {
  live: PaperBetRow[];
  backtest: BacktestBetRow[];
};

/** One row of GET /predict/{event_id}. */
export type Prediction = {
  model: string;
  market: string;
  selection: string;
  model_prob: number | null;
  /** Price from the latest live snapshot the model was evaluated against. */
  market_price: number | null;
  market_implied: number | null;
  market_devigged: number | null;
  /** model_prob − market_devigged, in probability points. */
  edge: number | null;
  kelly_full: number | null;
  /** Free-form diagnostics from the serving layer (feature coverage, fallbacks). */
  notes?: Record<string, unknown> | null;
};

export type PredictResponse = {
  event_id: string;
  predictions: Prediction[];
  /** Which trained models the serving layer has loaded (model → loaded). */
  available_models: Record<string, boolean>;
};
