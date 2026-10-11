"use client";
import { clsx } from "clsx";
import { Button, Callout, EmptyState, Panel, SegmentedControl, Skeleton } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import { statCategoryLabel, statLabel, statsPeriodLabel, statValue, type Teams } from "@/lib/matches/labels";
import { useStoredStats } from "@/lib/matches/queries";
import type { MatchStat, MatchStatsCategory } from "@/types/match-stats";
import { useDetailParams } from "./useDetailParams";

/** Leading number of a display value: "57%" → 57, "93% (550/594)" → 93, "1.20" → 1.2. */
function leadingNumber(value: string | null): number | null {
  const m = value?.match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
}

/** Match statistics from the latest stored snapshot, one period at a time. */
export function StatsPanel({
  eventId,
  teams,
  terminal
}: {
  eventId: string;
  teams: Teams;
  terminal: boolean | undefined;
}) {
  const { t, fmt } = useLocale();
  const { get, set } = useDetailParams(eventId);
  const stats = useStoredStats(eventId);
  const periods = stats.data?.event.periods ?? [];
  const sport = stats.data?.event.sport ?? null;
  const requested = get("stats");
  const period = periods.find((p) => p.name === requested) ?? periods[0];

  const description = stats.data
    ? t("matches.stats.provenance", {
        time: fmt.dateTime(stats.data.fetched_at),
        age: fmt.relative(stats.data.fetched_at)
      })
    : t("matches.stats.description");

  return (
    <Panel id="stats" title={t("matches.stats.title")} description={description}>
      {stats.isLoading ? (
        <Skeleton lines={10} />
      ) : stats.isError ? (
        <Callout
          tone="neg"
          title={t("matches.stats.error")}
          action={
            <Button size="sm" onClick={() => stats.refetch()} loading={stats.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(stats.error)}
        </Callout>
      ) : !stats.data ? (
        <EmptyState compact title={t("matches.stats.empty")}>
          {/* Until the event loads it is unknown whether the archive is frozen. */}
          {terminal === undefined ? null : terminal ? t("matches.stats.emptyArchived") : t("matches.stats.emptyFetch")}
        </EmptyState>
      ) : !period ? (
        <EmptyState compact title={t("matches.stats.noPeriods")}>
          {t("matches.stats.noPeriodsBody")}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {periods.length > 1 && (
            <div className="overflow-x-auto">
              <SegmentedControl
                label={t("matches.stats.period")}
                size="sm"
                value={period.name}
                options={periods.map((p) => ({ value: p.name, label: statsPeriodLabel(p.name, t) }))}
                onChange={(name) => set({ stats: name === periods[0].name ? null : name })}
                className="min-w-max"
              />
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border pb-2 text-meta">
            <span className="flex min-w-0 items-center gap-1.5 text-text">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 bg-cat-1" />
              <span className="truncate">{teams.home ?? t("selection.home")}</span>
            </span>
            <span />
            <span className="flex min-w-0 items-center justify-end gap-1.5 text-text">
              <span className="truncate">{teams.away ?? t("selection.away")}</span>
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 bg-cat-2" />
            </span>
          </div>
          {period.categories.map((cat, i) => (
            <CategoryTable key={`${cat.name}-${i}`} category={cat} teams={teams} sport={sport} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function CategoryTable({
  category,
  teams,
  sport
}: {
  category: MatchStatsCategory;
  teams: Teams;
  sport: string | null;
}) {
  const { t } = useLocale();
  return (
    <table className="w-full table-fixed border-collapse text-body">
      <caption className="mb-1 text-left font-sans text-label uppercase tracking-label text-text-dim">
        {statCategoryLabel(category.name, t)}
      </caption>
      <colgroup>
        <col className="w-1/4" />
        <col />
        <col className="w-1/4" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th scope="col">{teams.home ?? t("selection.home")}</th>
          <th scope="col">{t("matches.stats.statistic")}</th>
          <th scope="col">{teams.away ?? t("selection.away")}</th>
        </tr>
      </thead>
      <tbody>
        {category.stats.map((s, i) => (
          <StatRow key={`${s.code ?? s.label}-${i}`} stat={s} sport={sport} />
        ))}
      </tbody>
    </table>
  );
}

/** One statistic. Names and plain numbers are localised; anything else is shown as published. */
function StatRow({ stat, sport }: { stat: MatchStat; sport: string | null }) {
  const { t, fmt } = useLocale();
  const label = stat.label ? statLabel(stat.label, sport, t) : null;
  const home = leadingNumber(stat.home);
  const away = leadingNumber(stat.away);
  const total = home !== null && away !== null && home >= 0 && away >= 0 ? home + away : 0;
  const homeShare = total > 0 ? home! / total : null;
  // The larger value is bold, so the leader is readable without colour.
  const lead = home !== null && away !== null && home !== away ? (home > away ? "home" : "away") : null;
  return (
    <tr className="border-b border-border/60 align-top">
      <td
        className={clsx(
          "py-1.5 pr-2 font-mono tabular-nums",
          lead === "home" ? "font-medium text-text" : "text-text-dim"
        )}
      >
        {stat.home === null ? "—" : statValue(stat.home, fmt)}
      </td>
      <th scope="row" className="py-1.5 text-center font-sans font-normal text-text-dim">
        <span className="block truncate" title={label ?? undefined}>
          {label ?? "—"}
        </span>
        {homeShare !== null && (
          <span aria-hidden className="mt-1 flex h-1 w-full overflow-hidden bg-surface-3">
            <span className="h-full bg-cat-1/80" style={{ width: `${homeShare * 100}%` }} />
            <span className="h-full flex-1 bg-cat-2/80" />
          </span>
        )}
      </th>
      <td
        className={clsx(
          "py-1.5 pl-2 text-right font-mono tabular-nums",
          lead === "away" ? "font-medium text-text" : "text-text-dim"
        )}
      >
        {stat.away === null ? "—" : statValue(stat.away, fmt)}
      </td>
    </tr>
  );
}
