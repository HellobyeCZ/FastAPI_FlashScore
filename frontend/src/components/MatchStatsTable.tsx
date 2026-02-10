"use client";

import { Fragment } from "react";
import type { MatchStatsSummary } from "@/types/match-stats";
import { useLocale } from "@/contexts/LocaleContext";

interface MatchStatsTableProps {
  summary: MatchStatsSummary;
}

function toTitleCase(raw: string): string {
  return raw
    .split("_")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function MatchStatsTable({ summary }: MatchStatsTableProps) {
  const { t, locale } = useLocale();
  const unknown = t("stats.meta.unknown");
  const teams = summary.homeTeam && summary.awayTeam ? `${summary.homeTeam} vs ${summary.awayTeam}` : unknown;

  const kickoff = (() => {
    if (!summary.startTimeUtc) {
      return unknown;
    }
    const date = new Date(summary.startTimeUtc);
    if (Number.isNaN(date.getTime())) {
      return unknown;
    }
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC"
    }).format(date);
  })();

  const status = summary.status
    ? summary.statusDetail
      ? `${toTitleCase(summary.status)} (${summary.statusDetail})`
      : toTitleCase(summary.status)
    : unknown;
  const outcome = summary.outcome ? toTitleCase(summary.outcome) : unknown;
  const sport = summary.sport ? toTitleCase(summary.sport) : unknown;
  const country = summary.country ?? unknown;
  const competition = summary.competition ?? unknown;
  const competitionStage = summary.competitionStage ?? unknown;
  const competitionPath = summary.competitionPath ?? unknown;

  return (
    <div className="space-y-4">
      <article className="overflow-hidden rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] shadow-sm">
        <h3 className="bg-[color:var(--color-brand-primary)] px-4 py-3 text-base font-semibold text-[color:var(--color-text-inverse)]">
          {t("stats.title")}
        </h3>
        <dl className="grid gap-3 p-4 text-sm md:grid-cols-3">
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.teams")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{teams}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.sport")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{sport}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.country")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{country}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.competition")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{competition}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.stage")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{competitionStage}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.kickoff")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{kickoff}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.status")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{status}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.outcome")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{outcome}</dd>
          </div>
          <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2 md:col-span-3">
            <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">{t("stats.meta.path")}</dt>
            <dd className="mt-1 font-semibold text-[color:var(--color-text-high)]">{competitionPath}</dd>
          </div>
        </dl>
      </article>

      {!summary.periods.length && (
        <div className="rounded-3xl border border-dashed border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">
          {t("stats.empty")}
        </div>
      )}

      {summary.periods.map((period) => (
        <article
          key={period.name}
          className="overflow-hidden rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] shadow-sm"
        >
          <h3 className="bg-[color:var(--color-brand-primary)] px-4 py-3 text-base font-semibold text-[color:var(--color-text-inverse)]">
            {period.name}
          </h3>
          <div className="space-y-5 p-4">
            {period.categories.map((category) => (
              <Fragment key={`${period.name}:${category.name}`}>
                <h4 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  {category.name}
                </h4>
                <div className="overflow-hidden rounded-2xl border border-[color:var(--color-brand-outline)]">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-[color:var(--color-brand-surface)]">
                      <tr>
                        <th scope="col" className="px-4 py-2 text-sm font-semibold text-[color:var(--color-text-high)]">
                          {t("stats.home")}
                        </th>
                        <th scope="col" className="px-4 py-2 text-sm font-semibold text-[color:var(--color-text-high)]">
                          {t("stats.metric")}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2 text-right text-sm font-semibold text-[color:var(--color-text-high)]"
                        >
                          {t("stats.away")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {category.stats.map((stat, index) => (
                        <tr
                          key={`${period.name}:${category.name}:${stat.code ?? stat.label}:${index}`}
                          className={index % 2 === 0 ? "bg-[color:var(--color-brand-surface-alt)]" : "bg-[color:var(--color-brand-surface)]"}
                        >
                          <td className="px-4 py-2 text-sm font-medium text-[color:var(--color-text-high)]">{stat.home}</td>
                          <td className="px-4 py-2 text-sm text-[color:var(--color-text-muted)]">{stat.label}</td>
                          <td className="px-4 py-2 text-right text-sm font-medium text-[color:var(--color-text-high)]">{stat.away}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Fragment>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
