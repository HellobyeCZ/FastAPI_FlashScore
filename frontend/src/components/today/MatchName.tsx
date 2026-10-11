import type { TodayPick } from "@/hooks/useToday";

/**
 * "Home – Away" for a pick. The event id is only a last resort for bets
 * whose event has no stored fixture or summary row (so no team names exist).
 */
export function MatchName({ pick }: { pick: Pick<TodayPick, "home_team" | "away_team" | "event_id"> }) {
  if (pick.home_team && pick.away_team) {
    return (
      <span className="text-text">
        {pick.home_team}
        <span className="text-text-faint"> – </span>
        {pick.away_team}
      </span>
    );
  }
  return <span className="text-text-dim">{pick.event_id}</span>;
}
