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
} from "@/components/terminal/charts/CumulativeLine";
import {
  HeatmapChart,
  type HeatmapCell,
} from "@/components/terminal/charts/HeatmapChart";
import {
  ViolinChart,
  type ViolinSeries,
} from "@/components/terminal/charts/ViolinChart";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Kicker } from "@/components/terminal/Kicker";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
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

  const leaderboardCols: Column<StatsRow>[] = [
    {
      key: "model",
      header: t("picks.filter.model"),
      render: (row) => (
        <Link
          href={
            `/${locale}/picks/model/${row.model}` as unknown as Parameters<typeof Link>[0]["href"]
          }
          className="text-accent hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(row.model)}
        </Link>
      ),
      sort: (a, b) => String(a.model ?? "").localeCompare(String(b.model ?? "")),
    },
    {
      key: "n",
      header: "n",
      align: "right",
      render: (row) => row.n,
      sort: (a, b) => (a.n ?? 0) - (b.n ?? 0),
    },
    {
      key: "hit_rate",
      header: t("picks.deepDive.kpi.hitRate"),
      align: "right",
      render: (row) => fmtPct(row.hit_rate),
      sort: (a, b) => (a.hit_rate ?? 0) - (b.hit_rate ?? 0),
    },
    {
      key: "roi",
      header: t("picks.deepDive.kpi.roi"),
      align: "right",
      render: (row) => fmtPct(row.roi),
      sort: (a, b) => (a.roi ?? 0) - (b.roi ?? 0),
    },
    {
      key: "mean_clv",
      header: t("picks.deepDive.kpi.meanClv"),
      align: "right",
      render: (row) => fmtNum(row.mean_clv, 4),
      sort: (a, b) => (a.mean_clv ?? 0) - (b.mean_clv ?? 0),
    },
    {
      key: "brier",
      header: t("picks.leaderboard.brier"),
      align: "right",
      render: (row) => fmtNum(row.brier, 4),
      sort: (a, b) => (a.brier ?? 0) - (b.brier ?? 0),
    },
    {
      key: "max_drawdown",
      header: t("picks.leaderboard.maxDrawdown"),
      align: "right",
      render: (row) => fmtNum(row.max_drawdown, 2),
      sort: (a, b) => (a.max_drawdown ?? 0) - (b.max_drawdown ?? 0),
    },
  ];

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader kicker="Picks · models" />
        <div className="border border-border p-6 font-mono text-[12px] text-text">
          {t("picks.error")}: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker="Picks · models" />
      <FilterBar
        fields={["date", "status", "market", "competition", "edge"]}
        options={{
          markets: knownMarkets,
          competitions: knownComps,
        }}
      />

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.leaderboard.title")}</Kicker>
        <DataTable
          columns={leaderboardCols}
          rows={leaderboard}
          empty="—"
          onRowClick={(row) => router.push(`/${locale}/picks/model/${row.model}`)}
        />
      </section>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.trend.title")}</Kicker>
        <CumulativeLineChart series={pnlSeries} />
      </section>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.violin.title")}</Kicker>
        <ViolinChart series={violinSeries} referenceY={0} />
      </section>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.heatmap.modelMarket")}</Kicker>
        <HeatmapChart
          cells={marketCells}
          rows={models}
          cols={knownMarkets}
          minNToShow={10}
        />
      </section>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.heatmap.modelCompetition")}</Kicker>
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
