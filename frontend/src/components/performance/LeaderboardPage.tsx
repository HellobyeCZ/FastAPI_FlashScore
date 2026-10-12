"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { PageHeader, Panel, type SortState } from "@/components/ui";
import { useHistoryRows, usePicksStats } from "@/lib/performance/api";
import { filtersToParams, lastSettledAt, MIN_N, SHARED_KEYS, type FilterKey } from "@/lib/performance/filters";
import { usePerformanceFilters } from "@/lib/performance/useFilters";
import { FilterBar } from "./FilterBar";
import { KpiGrid } from "./KpiGrid";
import { ClvDistributionPanel, CompetitionPanel, PnlOverTimePanel } from "./LeaderboardCharts";
import { DEFAULT_SORT, LEADERBOARD_SORT_KEYS, LeaderboardTable } from "./LeaderboardTable";
import { NoBetsEmpty, PanelError, panelStatus, PerformanceTabs, StaleWindowCallout, useWindowText } from "./shared";

/** Filters carried into a model page: the window and scope, never the model filter itself. */
const MODEL_LINK_KEYS: readonly FilterKey[] = ["window", "from", "to", "market", "competition"];

function parseSort(sp: { get(name: string): string | null }): NonNullable<SortState> {
  const key = sp.get("sort");
  const dir = sp.get("dir");
  if (!key || !LEADERBOARD_SORT_KEYS.includes(key)) return DEFAULT_SORT;
  return { key, dir: dir === "asc" ? "asc" : "desc" };
}

/**
 * /performance — live paper-trading leaderboard. Every panel reads the same
 * URL-backed filters; the default window is anchored to the data.
 */
export function LeaderboardPage() {
  const { t, fmt } = useLocale();
  const state = usePerformanceFilters(SHARED_KEYS);
  const windowText = useWindowText(state);
  const q = state.query;

  const overall = usePicksStats([], q, state.ready);
  const byModel = usePicksStats(["model"], q, state.ready);
  const settled = useHistoryRows(q, "settled", state.ready);
  const boardStatus = panelStatus(state, byModel);
  const sort = parseSort(state.searchParams);
  const lastSettled = lastSettledAt(state.summary.data);

  const onSortChange = (next: SortState) =>
    state.setParam(
      next && (next.key !== DEFAULT_SORT.key || next.dir !== DEFAULT_SORT.dir)
        ? { sort: next.key, dir: next.dir }
        : { sort: null, dir: null }
    );

  return (
    <>
      <PageHeader
        title={t("performance.title")}
        description={t("performance.leaderboardPage.description", { window: windowText })}
        meta={lastSettled ? t("performance.leaderboardPage.lastSettled", { age: fmt.relative(lastSettled) }) : undefined}
      />
      <PerformanceTabs active="leaderboard" params={state.sharedParams} />
      {state.staleSince && <StaleWindowCallout since={state.staleSince} />}
      <FilterBar state={state} />

      <KpiGrid
        status={panelStatus(state, overall)}
        overall={overall.data?.rows[0]}
        rows={settled}
        windowText={windowText}
      />

      <Panel
        title={t("performance.leaderboard.title")}
        description={t("performance.leaderboard.description", { min: MIN_N })}
        padding="none"
        className="mb-5"
      >
        {boardStatus.error ? (
          <div className="p-4">
            <PanelError status={boardStatus} />
          </div>
        ) : (
          <LeaderboardTable
            loading={boardStatus.loading}
            rows={byModel.data?.rows ?? []}
            settled={settled.isLoading || settled.truncated || settled.competitionIgnored ? null : settled.rows}
            sort={sort}
            onSortChange={onSortChange}
            linkParams={filtersToParams(state.filters, MODEL_LINK_KEYS)}
            empty={<NoBetsEmpty state={state} compact />}
          />
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <PnlOverTimePanel state={state} q={q} className="lg:col-span-2" />
        <CompetitionPanel state={state} q={q} metric="roi" />
        <ClvDistributionPanel state={state} settled={settled} />
      </div>
    </>
  );
}
