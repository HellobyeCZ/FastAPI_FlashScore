import type { MessageKey } from "@/lib/i18n";
import type { MatchListItem, MatchStatusKind } from "@/types/scraped-matches";
import type { EventDetail } from "./types";

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** En dash between team names, as everywhere in the app: "Sparta Prague – Plzen". */
export const TEAM_SEPARATOR = " – ";

type Named = Pick<MatchListItem, "home_team" | "away_team"> & { event_name?: string | null };

/**
 * "Home – Away". Falls back to the upstream event name (minus the " LIVE"
 * suffix FlashScore appends to pre-match captures), then to a generic label.
 * Never the raw event id.
 */
export function matchTitle(m: Named, t: T): string {
  if (m.home_team && m.away_team) return `${m.home_team}${TEAM_SEPARATOR}${m.away_team}`;
  const name = m.event_name
    ?.replace(/\s+LIVE$/i, "")
    .replace(/\s+vs\.?\s+/i, TEAM_SEPARATOR)
    .trim();
  return name || t("matches.unnamed");
}

/** "CZECH REPUBLIC" → "Czech Republic"; short codes ("USA") stay upper case. */
export function countryLabel(country: string | null | undefined): string {
  if (!country) return "";
  return country
    .split(/(\s+|-)/)
    .map((part) => (part.length <= 3 || !/[A-Z]/.test(part) ? part : part[0] + part.slice(1).toLowerCase()))
    .join("");
}

const SPORTS = ["football", "hockey", "basketball", "american football"] as const;

export function sportLabel(sport: string | null | undefined, t: T): string {
  if (!sport) return "";
  const s = sport.toLowerCase();
  if ((SPORTS as readonly string[]).includes(s)) return t(`matches.sport.${s.replace(" ", "_")}` as MessageKey);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Score as "2:1"; null when no score is stored. */
export function scoreText(score: { home: number | string | null; away: number | string | null } | null | undefined) {
  if (!score || score.home === null || score.away === null || score.home === "" || score.away === "") return null;
  return `${score.home}:${score.away}`;
}

/**
 * Same rules as the list route's SQL: a stored result or a terminal stats
 * snapshot means finished (not "a score is present" — in-play snapshots carry
 * scores too); an upstream in-play status means live; otherwise kick-off
 * decides between scheduled and unconfirmed (kicked off, no result captured).
 */
export function eventStatus(
  e: Pick<EventDetail, "outcome" | "is_terminal" | "status" | "start_time_utc">,
  now = new Date()
): MatchStatusKind {
  if (e.outcome || e.is_terminal) return "finished";
  const raw = (e.status ?? "").toLowerCase();
  if (raw.includes("live") || raw.includes("in_play") || raw.includes("progress")) return "live";
  const kickoff = e.start_time_utc ? Date.parse(e.start_time_utc) : NaN;
  if (Number.isFinite(kickoff) && kickoff > now.getTime()) return "scheduled";
  return "unconfirmed";
}

export function outcomeLabel(outcome: string | null | undefined, t: T): string | null {
  if (outcome === "home_win" || outcome === "draw" || outcome === "away_win") {
    return t(`matches.outcome.${outcome}` as MessageKey);
  }
  return null;
}
