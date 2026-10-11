"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { routes } from "@/lib/routes";
import { useHistoryRows, usePicksStats } from "@/lib/performance/api";
import { RANGE_KEYS, SHARED_KEYS } from "@/lib/performance/filters";
import { usePerformanceFilters } from "@/lib/performance/useFilters";
import { PageHeader } from "@/components/ui";
import { BetsPanel } from "./BetsPanel";
import { ClvHeatmapPanel, EdgeDecilePanel, PriceBucketPanel } from "./ExploreCharts";
import { FilterBar } from "./FilterBar";
import { KpiGrid } from "./KpiGrid";
import { panelStatus, PerformanceTabs, StaleWindowCallout, useWindowText } from "./shared";

const EXPLORE_KEYS = [...SHARED_KEYS, ...RANGE_KEYS];

/**
 * /performance/explore — slice live paper bets by window, market, competition,
 * model, pick, edge and price. Every panel (KPIs, charts, the bets table)
 * reads the same query, so nothing on the page is unfiltered.
 */
export function ExplorePage() {
  const { t, locale } = useLocale();
  const state = usePerformanceFilters(EXPLORE_KEYS);
  const windowText = useWindowText(state);
  const q = state.query;

  const overall = usePicksStats([], q, state.ready);
  const settled = useHistoryRows(q, "settled", state.ready);

  return (
    <>
      <PageHeader
        title={t("nav.performance.explore")}
        crumbs={[{ label: t("performance.title"), href: routes.performance(locale, state.sharedParams) }]}
        description={t("performance.explore.description", { window: windowText })}
      />
      <PerformanceTabs active="explore" params={state.sharedParams} />
      {state.staleSince && <StaleWindowCallout since={state.staleSince} />}
      <FilterBar state={state} />

      <KpiGrid
        status={panelStatus(state, overall)}
        overall={overall.data?.rows[0]}
        rows={settled}
        windowText={windowText}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <EdgeDecilePanel state={state} settled={settled} />
        <PriceBucketPanel state={state} settled={settled} />
        <ClvHeatmapPanel state={state} q={q} className="lg:col-span-2" />
        <BetsPanel state={state} q={q} className="lg:col-span-2" />
      </div>
    </>
  );
}
