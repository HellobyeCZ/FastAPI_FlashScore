/**
 * Contract of GET /api/today, the Today cockpit's aggregates (Prisma-backed
 * Next route). Type-only and directive-free so the server route and the
 * client hook share it without the route importing a client module.
 *
 * Every window is explicit so the page can label it; metrics that have no
 * data are `null`, never 0. All timestamps are ISO-8601 UTC strings.
 */

/** Pick state: settled outcome, or open (kick-off ahead) / pending (kicked off, not settled). */
export type TodayPickState = "open" | "pending" | "won" | "lost" | "void";

export type TodayPick = {
  id: number;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  price: number;
  /** Model probability minus de-vigged market probability. */
  edge: number | null;
  state: TodayPickState;
  recommended_at: string;
  /** Null when no fixture/summary row exists for the event. */
  kickoff: string | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  country: string | null;
};

export type TodaySettled = TodayPick & {
  /** 1 win, 0 loss; null for voided bets. */
  result: number | null;
  pnl: number | null;
  settled_at: string;
};

export type TodayResponse = {
  generated_at: string;
  /** The viewer's local calendar day as UTC instants, plus the zone used. */
  window: { today_start: string; today_end: string; tz: string };
  /** Every pick (any state) with kick-off inside `window`. */
  slate: TodayPick[];
  /** Open picks with kick-off in [now, now + 72 h), at most 500 rows. */
  upcoming72h: TodayPick[];
  /** Uncapped counts of those open picks, in total and kicking off before `window.today_end`. */
  open72h: { count: number; today_count: number };
  /** Settled bets with settled_at in the last 30 days; `pnl` is null when n = 0. */
  pnl30d: { n: number; pnl: number | null; series: { settled_at: string; cum_pnl: number }[] };
  /** Latest settled_at of a settled (not voided) bet, any age. */
  last_settled_at: string | null;
  /**
   * Unsettled picks whose kick-off has passed; overdue = kick-off more than
   * 6 h ago. `unscheduled_count` = unsettled picks with no known kick-off.
   */
  pending: { count: number; overdue_count: number; unscheduled_count: number; oldest_kickoff: string | null };
  /** When the picks pipeline last recorded a pick. */
  last_recommended_at: string | null;
  /** The ten most recently settled or voided bets, newest first. */
  recent_settled: TodaySettled[];
};

/**
 * Error codes /api/today answers with. The route's messages are English and
 * deliberately generic (details stay in the server log); the client shows
 * its own copy for each code.
 */
export type TodayErrorCode = "today_db_busy" | "today_query_failed";
