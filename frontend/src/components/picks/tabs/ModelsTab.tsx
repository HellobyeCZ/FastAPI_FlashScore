"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import {
  fetchStats,
  fetchHistory,
  type StatsRow,
  type HistoryRow,
  type StatsFilters,
} from "@/lib/api-picks";
import {
  filtersFromSearchParams,
  edgeBucketToRange,
  presetToDateRange,
} from "@/components/picks/filters/filter-types";
import { FilterBar } from "@/components/picks/filters/FilterBar";
import {
  CumulativeLineChart,
  type Series,
} from "@/components/picks/charts/CumulativeLineChart";
import {
  HeatmapChart,
  type HeatmapCell,
} from "@/components/picks/charts/HeatmapChart";
import {
  ViolinChart,
  type ViolinSeries,
} from "@/components/picks/charts/ViolinChart";

const MODEL_COLORS: Record<string, string> = {
  dixon_coles: "#6366f1",
  hgb: "#10b981",
  logistic: "#f59e0b",
};

function colorFor(model: string): string {
  return MODEL_COLORS[model] ?? "#94a3b8";
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function ModelsTab() {
  const { t, locale } = useLocale();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const [leaderboard, setLeaderboard] = useState<StatsRow[]>([]);
  const [pnlSeries, setPnlSeries] = useState<Series[]>([]);
  const [violinSeries, setViolinSeries] = useState<ViolinSeries[]>([]);
  const [modelMarket, setModelMarket] = useState<StatsRow[]>([]);
  const [modelComp, setModelComp] = useState<StatsRow[]>([]);
  const [knownMarkets, setKnownMarkets] = useState<string[]>([]);
  const [knownComps, setKnownComps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Build StatsFilters from URL filters state.
  const apiFilters: StatsFilters = useMemo(() => {
    const out: StatsFilters = { status: filters.status };
    const range = presetToDateRange(filters.datePreset);
    if (range.dateFrom) out.dateFrom = range.dateFrom;
    if (range.dateTo) out.dateTo = range.dateTo;
    if (filters.dateFrom) out.dateFrom = filters.dateFrom;
    if (filters.dateTo) out.dateTo = filters.dateTo;
    if (filters.model?.length) out.model = filters.model;
    if (filters.market?.length) out.market = filters.market;
    if (filters.competition?.length) out.competition = filters.competition;
    if (filters.selection?.length) out.selection = filters.selection;
    if (filters.edge) {
      const er = edgeBucketToRange(filters.edge);
      if (er.edgeMin !== undefined) out.edgeMin = er.edgeMin;
      if (er.edgeMax !== undefined) out.edgeMax = er.edgeMax;
    }
    return out;
  }, [
    filters.status,
    filters.datePreset,
    filters.dateFrom,
    filters.dateTo,
    filters.model?.join(","),
    filters.market?.join(","),
    filters.competition?.join(","),
    filters.selection?.join(","),
    filters.edge,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [byModel, byModelDay, byModelMarket, byModelComp, history] =
          await Promise.all([
            fetchStats(["model"], apiFilters),
            fetchStats(["model", "day"], apiFilters),
            fetchStats(["model", "market"], apiFilters),
            fetchStats(["model", "competition"], apiFilters),
            fetchHistory({ status: "settled", limit: 5000 }),
          ]);
        if (cancelled) return;

        setLeaderboard(byModel.rows);

        // Build cumulative P&L per model, x=days since first day.
        const byModelDayRows = [...byModelDay.rows].sort((a, b) =>
          String(a.day ?? "").localeCompare(String(b.day ?? "")),
        );
        const firstDayStr = String(byModelDayRows[0]?.day ?? "");
        const firstDayMs = firstDayStr ? new Date(firstDayStr).getTime() : 0;
        const perModel = new Map<string, { x: number; y: number }[]>();
        const runningByModel = new Map<string, number>();
        for (const row of byModelDayRows) {
          const model = String(row.model ?? "");
          if (!model) continue;
          const dayStr = String(row.day ?? "");
          if (!dayStr) continue;
          const dayMs = new Date(dayStr).getTime();
          const x = firstDayMs
            ? Math.round((dayMs - firstDayMs) / 86400e3)
            : 0;
          const prev = runningByModel.get(model) ?? 0;
          const next = prev + (row.pnl_total ?? 0);
          runningByModel.set(model, next);
          const arr = perModel.get(model) ?? [];
          arr.push({ x, y: next });
          perModel.set(model, arr);
        }
        const series: Series[] = Array.from(perModel.entries()).map(
          ([model, points]) => ({
            label: model,
            color: colorFor(model),
            points,
          }),
        );
        setPnlSeries(series);

        // Violin: settled rows with non-null clv, grouped by model.
        const byModelClv = new Map<string, number[]>();
        for (const r of history.rows as HistoryRow[]) {
          if (r.status !== "settled") continue;
          if (r.clv === null || r.clv === undefined) continue;
          const arr = byModelClv.get(r.model) ?? [];
          arr.push(r.clv);
          byModelClv.set(r.model, arr);
        }
        const vSeries: ViolinSeries[] = Array.from(byModelClv.entries()).map(
          ([model, values]) => ({
            label: model,
            color: colorFor(model),
            values,
          }),
        );
        setViolinSeries(vSeries);

        setModelMarket(byModelMarket.rows);
        setModelComp(byModelComp.rows);
        setKnownMarkets(
          Array.from(
            new Set(
              byModelMarket.rows
                .map((r) => String(r.market ?? ""))
                .filter(Boolean),
            ),
          ).sort(),
        );
        setKnownComps(
          Array.from(
            new Set(
              byModelComp.rows
                .map((r) => String(r.competition ?? ""))
                .filter(Boolean),
            ),
          ).sort(),
        );
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    apiFilters.status,
    apiFilters.dateFrom,
    apiFilters.dateTo,
    apiFilters.model?.join(","),
    apiFilters.market?.join(","),
    apiFilters.competition?.join(","),
    apiFilters.selection?.join(","),
    apiFilters.edgeMin,
    apiFilters.edgeMax,
  ]);

  const models = useMemo(
    () =>
      Array.from(
        new Set(leaderboard.map((r) => String(r.model ?? "")).filter(Boolean)),
      ),
    [leaderboard],
  );

  const marketCells: HeatmapCell[] = useMemo(
    () =>
      modelMarket.map((r) => ({
        row: String(r.model ?? ""),
        col: String(r.market ?? ""),
        value: r.roi,
        n: r.n,
      })),
    [modelMarket],
  );
  const compCells: HeatmapCell[] = useMemo(
    () =>
      modelComp.map((r) => ({
        row: String(r.model ?? ""),
        col: String(r.competition ?? ""),
        value: r.roi,
        n: r.n,
      })),
    [modelComp],
  );

  if (error) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm">
        {t("picks.error")}: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        fields={["date", "status", "market", "competition", "edge"]}
        options={{
          markets: knownMarkets,
          competitions: knownComps,
        }}
      />

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.leaderboard.title")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.filter.model")}</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.roi")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.meanClv")}</th>
              <th className="px-2 py-2">{t("picks.leaderboard.brier")}</th>
              <th className="px-2 py-2">{t("picks.leaderboard.maxDrawdown")}</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 ? (
              <tr>
                <td
                  className="px-2 py-3 text-[color:var(--color-text-muted)]"
                  colSpan={7}
                >
                  —
                </td>
              </tr>
            ) : (
              leaderboard.map((row) => (
                <tr
                  key={String(row.model)}
                  className="border-t border-[color:var(--color-brand-outline)]"
                >
                  <td className="px-2 py-2 font-semibold text-[color:var(--color-text-high)]">
                    <Link
                      href={
                        `/${locale}/picks/model/${row.model}` as unknown as Parameters<
                          typeof Link
                        >[0]["href"]
                      }
                      className="underline"
                    >
                      {String(row.model)}
                    </Link>
                  </td>
                  <td className="px-2 py-2">{row.n}</td>
                  <td className="px-2 py-2">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2">{fmtPct(row.roi)}</td>
                  <td className="px-2 py-2">{fmtNum(row.mean_clv, 4)}</td>
                  <td className="px-2 py-2">{fmtNum(row.brier, 4)}</td>
                  <td className="px-2 py-2">{fmtNum(row.max_drawdown, 2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.trend.title")}
        </h2>
        <CumulativeLineChart series={pnlSeries} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.violin.title")}
        </h2>
        <ViolinChart series={violinSeries} referenceY={0} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.heatmap.modelMarket")}
        </h2>
        <HeatmapChart
          cells={marketCells}
          rows={models}
          cols={knownMarkets}
          minNToShow={10}
        />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.heatmap.modelCompetition")}
        </h2>
        <HeatmapChart
          cells={compCells}
          rows={models}
          cols={knownComps}
          minNToShow={10}
        />
      </section>
    </div>
  );
}
