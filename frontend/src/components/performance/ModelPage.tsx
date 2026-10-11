"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { useRegistry } from "@/hooks/useMlflow";
import { baseModel, KNOWN_MODELS, modelLabel } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useBacktestRuns, useHistoryRows, usePicksStats } from "@/lib/performance/api";
import { filtersToParams, type FilterKey } from "@/lib/performance/filters";
import { usePerformanceFilters } from "@/lib/performance/useFilters";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { BetsPanel } from "./BetsPanel";
import { FilterBar } from "./FilterBar";
import { KpiGrid } from "./KpiGrid";
import { CompetitionPanel } from "./LeaderboardCharts";
import { BacktestsPanel, CalibrationPanel, RegistryPanel } from "./ModelPanels";
import { panelStatus, StaleWindowCallout, useWindowText } from "./shared";

/** The model is fixed by the route; the page filters by window and scope only. */
const MODEL_KEYS: readonly FilterKey[] = ["window", "from", "to", "market", "competition"];

/**
 * /models/[name] — one model's live paper-trading record (KPIs, calibration,
 * P&L by competition, bets) next to its MLflow registry versions and backtests.
 */
export function ModelPage({ name }: { name: string }) {
  const { t, locale } = useLocale();
  const state = usePerformanceFilters(MODEL_KEYS);
  const windowText = useWindowText(state);
  const q = useMemo(() => ({ ...state.query, model: [name] }), [state.query, name]);
  const backParams = filtersToParams(state.filters, MODEL_KEYS);

  const overall = usePicksStats([], q, state.ready);
  const settled = useHistoryRows(q, "settled", state.ready);
  const runs = useBacktestRuns();
  const registry = useRegistry();

  const label = modelLabel(name, t);
  const known =
    (KNOWN_MODELS as readonly string[]).includes(baseModel(name)) ||
    !!state.facets.data?.models.includes(name) ||
    !!runs.data?.items.some((r) => r.model === name) ||
    !!registry.data?.models.some((m) => m.model_name === name);
  // Only call a name unknown once the live facets answered and the other
  // sources have settled; a failing backend is not evidence of absence.
  const unknown = !known && state.facets.isSuccess && !runs.isLoading && !registry.isLoading;
  const crumbs = [{ label: t("performance.title"), href: routes.performance(locale, backParams) }];

  if (unknown) {
    return (
      <>
        <PageHeader title={name} crumbs={crumbs} />
        <EmptyState
          title={t("performance.model.unknown.title", { name })}
          action={
            <ButtonLink href={routes.performance(locale, backParams)} variant="primary">
              {t("performance.model.unknown.action")}
            </ButtonLink>
          }
        >
          {t("performance.model.unknown.body")}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={label}
        crumbs={[...crumbs, { label }]}
        description={t("performance.model.description", { window: windowText })}
        actions={
          <ButtonLink href={routes.explore(locale, { ...backParams, model: name })} size="sm">
            {t("performance.model.exploreBets")}
          </ButtonLink>
        }
      />
      {state.staleSince && <StaleWindowCallout since={state.staleSince} />}
      <FilterBar state={state} />

      <KpiGrid
        status={panelStatus(state.ready, overall)}
        overall={overall.data?.rows[0]}
        rows={settled}
        windowText={windowText}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <CalibrationPanel state={state} model={name} q={q} />
        <CompetitionPanel state={state} q={q} metric="pnl" />
        <BetsPanel state={state} q={q} hideModel className="lg:col-span-2" />
        <RegistryPanel model={name} className="lg:col-span-2" />
        <BacktestsPanel model={name} className="lg:col-span-2" />
      </div>
    </>
  );
}
