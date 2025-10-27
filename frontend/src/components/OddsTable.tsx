"use client";

import { Fragment } from "react";
import { clsx } from "clsx";
import type { EventOddsSummary } from "@/types/odds";
import { useLocale } from "@/contexts/LocaleContext";

interface OddsTableProps {
  summary: EventOddsSummary;
}

export function OddsTable({ summary }: OddsTableProps) {
  const { t } = useLocale();

  if (!summary.markets.length) {
    return (
      <div className="rounded-3xl border border-dashed border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">
        {t("table.empty")}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] shadow-sm">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{summary.eventName}</caption>
        <thead className="bg-[color:var(--color-brand-primary)] text-[color:var(--color-text-inverse)]">
          <tr>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("table.market")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("table.selection")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold">
              {t("table.bookmaker")}
            </th>
            <th scope="col" className="px-4 py-3 text-sm font-semibold text-right">
              {t("table.odds")}
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.markets.map((market) => (
            <Fragment key={market.marketId}>
              {market.selections.map((selection, index) => (
                <tr
                  key={selection.selectionId}
                  className={clsx(
                    "border-t border-[color:var(--color-brand-outline)]", 
                    index % 2 === 0 ? "bg-[color:var(--color-brand-surface-alt)]" : "bg-[color:var(--color-brand-surface)]",
                    "transition hover:bg-[color:var(--color-brand-surface)]"
                  )}
                >
                  {index === 0 && (
                    <th
                      scope="row"
                      rowSpan={market.selections.length}
                      className="px-4 py-4 text-sm font-semibold text-[color:var(--color-text-high)]"
                    >
                      {market.marketName}
                    </th>
                  )}
                  <td className="px-4 py-4 text-sm text-[color:var(--color-text-high)]">{selection.selectionName}</td>
                  <td className="px-4 py-4 text-sm text-[color:var(--color-text-muted)]">{selection.bookmakerName}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold text-[color:var(--color-text-high)]">
                    {selection.odds !== null ? selection.odds.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
