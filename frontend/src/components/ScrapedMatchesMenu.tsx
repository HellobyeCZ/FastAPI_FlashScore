"use client";

import { memo, useCallback, useMemo, useState } from "react";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";
import { useLocale } from "@/contexts/LocaleContext";

interface ScrapedMatchesMenuProps {
  matches: ScrapedMatchSummary[];
  onOpenMatch: (eventId: string) => void;
}

interface SeasonNode {
  season: string;
  matches: ScrapedMatchSummary[];
}

interface LeagueNode {
  league: string;
  seasons: SeasonNode[];
  totalMatches: number;
}

interface CountryNode {
  country: string;
  leagues: LeagueNode[];
  totalMatches: number;
}

interface SportNode {
  sport: string;
  countries: CountryNode[];
  totalMatches: number;
}

const SEASONAL_SPORTS = new Set([
  "FOOTBALL",
  "HOCKEY",
  "BASKETBALL",
  "HANDBALL",
  "VOLLEYBALL",
  "BASEBALL",
  "RUGBY",
  "AMERICAN FOOTBALL"
]);

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function toBaseCompetitionName(competition: string | undefined, competitionStage: string | undefined): string | undefined {
  const normalizedCompetition = competition?.trim();
  if (!normalizedCompetition) {
    return undefined;
  }

  const stage = competitionStage?.trim();
  if (stage) {
    const explicitSuffix = ` - ${stage}`;
    if (normalizedCompetition.toLowerCase().endsWith(explicitSuffix.toLowerCase())) {
      const base = normalizedCompetition.slice(0, -explicitSuffix.length).trim();
      if (base) {
        return base;
      }
    }
  }

  const splitByStage = normalizedCompetition.split(" - ")[0]?.trim();
  return splitByStage || normalizedCompetition;
}

function formatUtc(value: string | undefined, locale: string, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(date);
}

function toTitleCase(raw: string): string {
  return raw
    .split("_")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function parseCompetitionPath(path: string | undefined): {
  sportFromPath?: string;
  countryFromPath?: string;
  leagueFromPath?: string;
} {
  if (!path) {
    return {};
  }

  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  const sportFromPath = segments[0];
  const countryFromPath = segments[1];
  const leagueRaw = segments.slice(2).join(" / ");
  const leagueFromPath = leagueRaw ? leagueRaw.split(" - ")[0]?.trim() : undefined;

  return { sportFromPath, countryFromPath, leagueFromPath };
}

function normalizeSeasonToken(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  const [left, right] = compact.split("/");
  if (!left || !right) {
    return compact;
  }
  if (right.length === 2 && left.length === 4) {
    return `${left}/${left.slice(0, 2)}${right}`;
  }
  return `${left}/${right}`;
}

function deriveSeason(match: ScrapedMatchSummary, sport: string, unknownSeason: string): string {
  const joined = [match.competitionPath, match.competition, match.competitionStage, match.eventName]
    .filter(Boolean)
    .join(" ");

  const explicitRange = joined.match(/(?:19|20)\d{2}\s*\/\s*(?:19|20)?\d{2}/);
  if (explicitRange) {
    return normalizeSeasonToken(explicitRange[0]);
  }

  const explicitYear = joined.match(/\b(19|20)\d{2}\b/);
  if (explicitYear) {
    return explicitYear[0];
  }

  if (!match.startTimeUtc) {
    return unknownSeason;
  }

  const start = new Date(match.startTimeUtc);
  if (Number.isNaN(start.getTime())) {
    return unknownSeason;
  }

  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  if (SEASONAL_SPORTS.has(sport)) {
    const seasonStartYear = month >= 7 ? year : year - 1;
    return `${seasonStartYear}/${seasonStartYear + 1}`;
  }

  return String(year);
}

function parseSeasonStartYear(value: string): number {
  const match = value.match(/\b(19|20)\d{2}\b/);
  return match ? Number.parseInt(match[0], 10) : -1;
}

function sortSeasonsDesc(a: string, b: string): number {
  const yearA = parseSeasonStartYear(a);
  const yearB = parseSeasonStartYear(b);
  if (yearA !== yearB) {
    return yearB - yearA;
  }
  return b.localeCompare(a);
}

function buildTree(matches: ScrapedMatchSummary[], unknownSeason: string): SportNode[] {
  const root = new Map<string, Map<string, Map<string, Map<string, ScrapedMatchSummary[]>>>>();

  for (const match of matches) {
    const fromPath = parseCompetitionPath(match.competitionPath);
    const sport = normalizeLabel((match.sport ?? fromPath.sportFromPath)?.toUpperCase(), "UNKNOWN SPORT");
    const country = normalizeLabel((match.country ?? fromPath.countryFromPath)?.toUpperCase(), "UNKNOWN COUNTRY");
    const league = normalizeLabel(
      toBaseCompetitionName(match.competition, match.competitionStage) ?? fromPath.leagueFromPath,
      "Unknown league"
    );
    const season = deriveSeason(match, sport, unknownSeason);

    if (!root.has(sport)) {
      root.set(sport, new Map());
    }
    const countries = root.get(sport) as Map<string, Map<string, Map<string, ScrapedMatchSummary[]>>>;

    if (!countries.has(country)) {
      countries.set(country, new Map());
    }
    const leagues = countries.get(country) as Map<string, Map<string, ScrapedMatchSummary[]>>;

    if (!leagues.has(league)) {
      leagues.set(league, new Map());
    }
    const seasons = leagues.get(league) as Map<string, ScrapedMatchSummary[]>;

    if (!seasons.has(season)) {
      seasons.set(season, []);
    }

    (seasons.get(season) as ScrapedMatchSummary[]).push(match);
  }

  const sports: SportNode[] = [];

  for (const [sport, countries] of root.entries()) {
    const countryNodes: CountryNode[] = [];
    let sportCount = 0;

    for (const [country, leagues] of countries.entries()) {
      const leagueNodes: LeagueNode[] = [];
      let countryCount = 0;

      for (const [league, seasons] of leagues.entries()) {
        const seasonNodes: SeasonNode[] = [];
        let leagueCount = 0;

        const sortedSeasonKeys = Array.from(seasons.keys()).sort(sortSeasonsDesc);
        for (const season of sortedSeasonKeys) {
          // Sort by kickoff time, newest first. Matches with no kickoff
          // fall to the bottom (treated as -Infinity).
          const tsOf = (m: ScrapedMatchSummary): number => {
            if (!m.startTimeUtc) return Number.NEGATIVE_INFINITY;
            const t = new Date(m.startTimeUtc).getTime();
            return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
          };
          const seasonMatches = [...(seasons.get(season) as ScrapedMatchSummary[])].sort(
            (left, right) => tsOf(right) - tsOf(left)
          );
          leagueCount += seasonMatches.length;
          seasonNodes.push({
            season,
            matches: seasonMatches
          });
        }

        countryCount += leagueCount;
        leagueNodes.push({
          league,
          seasons: seasonNodes,
          totalMatches: leagueCount
        });
      }

      leagueNodes.sort((left, right) => left.league.localeCompare(right.league));
      sportCount += countryCount;
      countryNodes.push({
        country,
        leagues: leagueNodes,
        totalMatches: countryCount
      });
    }

    countryNodes.sort((left, right) => left.country.localeCompare(right.country));
    sports.push({
      sport,
      countries: countryNodes,
      totalMatches: sportCount
    });
  }

  sports.sort((left, right) => left.sport.localeCompare(right.sport));
  return sports;
}

// Lazy-mount disclosure: children only render once the user opens the row,
// and stay mounted thereafter. With ~52K matches the deeply nested tree was
// generating a giant DOM upfront — even collapsed `<details>` materialised
// every descendant. Tracking open state in React (instead of relying on the
// browser's native `<details>` open) lets us skip rendering subtrees entirely
// until they're actually needed.
function Disclosure({
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  summary: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hasOpened, setHasOpened] = useState(defaultOpen);
  const onToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (next) setHasOpened(true);
  }, []);
  return (
    <details open={open} onToggle={onToggle} className={className}>
      <summary className="cursor-pointer list-none">{summary}</summary>
      {hasOpened ? children() : null}
    </details>
  );
}

const MatchRow = memo(function MatchRow({
  match,
  onOpenMatch,
  locale,
  unknown,
}: {
  match: ScrapedMatchSummary;
  onOpenMatch: (eventId: string) => void;
  locale: string;
  unknown: string;
}) {
  const { t } = useLocale();
  const teams =
    match.homeTeam && match.awayTeam
      ? `${match.homeTeam} vs ${match.awayTeam}`
      : match.eventName ?? unknown;
  const kickoff = formatUtc(match.startTimeUtc, locale, unknown);
  const status = match.status ? toTitleCase(match.status) : unknown;
  return (
    <li className="rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[color:var(--color-text-high)]">{teams}</p>
          <p className="text-xs text-[color:var(--color-text-muted)]">
            {kickoff} | {status} | {match.eventId}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenMatch(match.eventId)}
          className="rounded-xl bg-[color:var(--color-brand-primary)] px-3 py-2 text-sm font-semibold text-[color:var(--color-text-inverse)] transition hover:bg-[color:var(--color-brand-accent)]"
        >
          {t("saved.table.open")}
        </button>
      </div>
    </li>
  );
});

export function ScrapedMatchesMenu({ matches, onOpenMatch }: ScrapedMatchesMenuProps) {
  const { t, locale } = useLocale();
  const unknown = t("stats.meta.unknown");
  const unknownSeason = t("saved.menu.seasonUnknown");

  const tree = useMemo(() => buildTree(matches, unknownSeason), [matches, unknownSeason]);

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-[color:var(--color-text-high)]">{t("saved.menu.title")}</h3>
      <div className="space-y-3 rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-4 shadow-sm">
        {tree.map((sportNode) => (
          <Disclosure
            key={sportNode.sport}
            className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]"
            summary={
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-semibold text-[color:var(--color-text-high)]">{sportNode.sport}</span>
                <span className="text-xs text-[color:var(--color-text-muted)]">
                  {t("saved.menu.matchesCount", { count: sportNode.totalMatches })}
                </span>
              </div>
            }
          >
            {() => (
              <div className="space-y-2 px-3 pb-3">
                {sportNode.countries.map((countryNode) => (
                  <Disclosure
                    key={`${sportNode.sport}:${countryNode.country}`}
                    className="rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)]"
                    summary={
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="text-sm font-medium text-[color:var(--color-text-high)]">{countryNode.country}</span>
                        <span className="text-xs text-[color:var(--color-text-muted)]">
                          {t("saved.menu.matchesCount", { count: countryNode.totalMatches })}
                        </span>
                      </div>
                    }
                  >
                    {() => (
                      <div className="space-y-2 px-2 pb-2">
                        {countryNode.leagues.map((leagueNode) => (
                          <Disclosure
                            key={`${sportNode.sport}:${countryNode.country}:${leagueNode.league}`}
                            className="rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]"
                            summary={
                              <div className="flex items-center justify-between gap-3 px-3 py-2">
                                <span className="text-sm font-medium text-[color:var(--color-text-high)]">{leagueNode.league}</span>
                                <span className="text-xs text-[color:var(--color-text-muted)]">
                                  {t("saved.menu.seasonsCount", { count: leagueNode.seasons.length })}
                                </span>
                              </div>
                            }
                          >
                            {() => (
                              <div className="space-y-2 px-2 pb-2">
                                {leagueNode.seasons.map((seasonNode) => (
                                  <Disclosure
                                    key={`${sportNode.sport}:${countryNode.country}:${leagueNode.league}:${seasonNode.season}`}
                                    className="rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)]"
                                    summary={
                                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                                        <span className="text-sm font-medium text-[color:var(--color-text-high)]">{seasonNode.season}</span>
                                        <span className="text-xs text-[color:var(--color-text-muted)]">
                                          {t("saved.menu.matchesCount", { count: seasonNode.matches.length })}
                                        </span>
                                      </div>
                                    }
                                  >
                                    {() => (
                                      <ul className="space-y-2 px-2 pb-2">
                                        {seasonNode.matches.map((match) => (
                                          <MatchRow
                                            key={match.eventId}
                                            match={match}
                                            onOpenMatch={onOpenMatch}
                                            locale={locale}
                                            unknown={unknown}
                                          />
                                        ))}
                                      </ul>
                                    )}
                                  </Disclosure>
                                ))}
                              </div>
                            )}
                          </Disclosure>
                        ))}
                      </div>
                    )}
                  </Disclosure>
                ))}
              </div>
            )}
          </Disclosure>
        ))}
      </div>
    </div>
  );
}
