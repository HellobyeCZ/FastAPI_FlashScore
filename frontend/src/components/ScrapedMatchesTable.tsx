"use client";

import type { ScrapedMatchSummary } from "@/types/scraped-matches";
import { useLocale } from "@/contexts/LocaleContext";

interface ScrapedMatchesTableProps {
  matches: ScrapedMatchSummary[];
  onOpenMatch: (eventId: string) => void;
}

function toTitleCase(raw: string): string {
  return raw
    .split("_")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
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

export function ScrapedMatchesTable({ matches, onOpenMatch }: ScrapedMatchesTableProps) {
  const { t, locale } = useLocale();
  const unknown = t("stats.meta.unknown");

  return (
    <div className="overflow-hidden rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] shadow-sm">
      <table className="w-full border-collapse text-left">
        <thead className="bg-[color:var(--color-brand-primary)] text-[color:var(--color-text-inverse)]">
          <tr>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.eventId")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.teams")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.competition")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.status")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.start")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.lastFetched")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("saved.table.snapshots")}
            </th>
            <th scope="col" className="px-4 py-3 text-right text-sm font-semibold">
              {t("saved.table.open")}
            </th>
          </tr>
        </thead>
        <tbody>
          {matches.map((match, index) => {
            const teams = match.homeTeam && match.awayTeam ? `${match.homeTeam} vs ${match.awayTeam}` : match.eventName ?? unknown;
            const fallbackCompetition = [match.sport, match.country, match.competition, match.competitionStage]
              .filter(Boolean)
              .join(" / ");
            const competition = match.competitionPath ?? (fallbackCompetition || unknown);
            const statusValue =
              match.status && match.statusDetail
                ? `${toTitleCase(match.status)} (${match.statusDetail})`
                : match.status
                  ? toTitleCase(match.status)
                  : unknown;
            const startUtc = formatUtc(match.startTimeUtc, locale, unknown);
            const lastFetched = formatUtc(match.lastFetchedAt, locale, unknown);
            const snapshotText = t("saved.snapshots", {
              stats: match.statsSnapshotCount,
              odds: match.oddsSnapshotCount
            });

            return (
              <tr
                key={match.eventId}
                className={
                  index % 2 === 0
                    ? "border-t border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)]"
                    : "border-t border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]"
                }
              >
                <td className="px-4 py-3 text-sm font-semibold text-[color:var(--color-text-high)]">{match.eventId}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-high)]">{teams}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-muted)]">{competition || unknown}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-muted)]">{statusValue}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-muted)]">{startUtc}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-muted)]">{lastFetched}</td>
                <td className="px-4 py-3 text-sm text-[color:var(--color-text-muted)]">{snapshotText}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onOpenMatch(match.eventId)}
                    className="rounded-xl bg-[color:var(--color-brand-primary)] px-3 py-2 text-sm font-semibold text-[color:var(--color-text-inverse)] transition hover:bg-[color:var(--color-brand-accent)]"
                  >
                    {t("saved.table.open")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
