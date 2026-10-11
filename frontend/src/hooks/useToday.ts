"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { appGet } from "@/lib/api/http";

/**
 * GET /api/today — the Today cockpit's aggregates (Prisma-backed Next route).
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

/** IANA zone of the browser, or its UTC offset in minutes when Intl can't tell. */
function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // very old engines: fall through to the offset
  }
  return String(new Date().getTimezoneOffset());
}

export const todayKey = (tz: string) => ["today", tz] as const;

export function useToday() {
  // Lazy initial state runs again on the client during hydration, so the
  // query always carries the viewer's zone (it never fetches on the server).
  const [tz] = useState(browserTimeZone);
  return useQuery({
    queryKey: todayKey(tz),
    queryFn: () => appGet<TodayResponse>("today", { tz }),
    staleTime: 60_000
  });
}
