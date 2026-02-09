"use client";

import { Fragment } from "react";
import type { MatchStatsSummary } from "@/types/match-stats";
import { useLocale } from "@/contexts/LocaleContext";

interface MatchStatsTableProps {
  summary: MatchStatsSummary;
}

export function MatchStatsTable({ summary }: MatchStatsTableProps) {
  const { t } = useLocale();

  if (!summary.periods.length) {
    return (
      <div className="rounded-3xl border border-dashed border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">
        {t("stats.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
