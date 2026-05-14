"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Chip } from "@/components/terminal/Chip";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { Stat } from "@/components/terminal/Stat";
import { colorForModel } from "@/components/terminal/charts/modelColors";
import { DataSourcePicker } from "@/components/picks/DataSourcePicker";
import { RunBacktestButton } from "@/components/picks/RunBacktestButton";
import { BacktestAdvancedDialog } from "@/components/picks/BacktestAdvancedDialog";
import { BacktestRunsPanel } from "@/components/picks/BacktestRunsPanel";

type CompareView = "pnl" | "clv" | "market" | "competition";

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function bestBy(rows: StatsRow[], key: keyof StatsRow): StatsRow | undefined {
  let best: StatsRow | undefined;
  let bestVal = -Infinity;
  for (const r of rows) {
    const v = r[key];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    if (v > bestVal) {
      bestVal = v;
      best = r;
    }
  }
  return best;
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
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<CompareView>("pnl");
  const [dialogOpen, setDialogOpen] = useState(false);

  const source = (searchParams.get("source") as "live" | "backtest" | "both") ?? "live";
  const runId = searchParams.get("run_id") ?? undefined;

  const handleSelectRun = useCallback(
    (id: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("source", source === "live" ? "backtest" : source);
      sp.set("run_id", id);
      router.replace(`?${sp.toString()}`);
    },
    [router, searchParams, source],
  );

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
    setLoading(true);
    async function load() {
      try {
        const [byModel, byModelDay, byModelMarket, byModelComp, history] =
          await Promise.all([
            fetchStats(["model"], apiFilters, source, runId),
            fetchStats(["model", "day"], apiFilters, source, runId),
            fetchStats(["model", "market"], apiFilters, source, runId),
            fetchStats(["model", "competition"], apiFilters, source, runId),
            fetchHistory({ status: "settled", limit: 5000, source, run_id: runId }),
          ]);
        if (cancelled) return;

        setLeaderboard(byModel.rows);

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
          const x = firstDayMs ? Math.round((dayMs - firstDayMs) / 86400e3) : 0;
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
            color: colorForModel(model),
            // Anchor each series to (0, 0) so cumulative P&L reads from the
            // origin even when the first observation is mid-window.
            points:
              points.length > 0 && points[0].x > 0
                ? [{ x: 0, y: 0 }, ...points]
                : points,
          }),
        );
        setPnlSeries(series);

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
            color: colorForModel(model),
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
      } finally {
        if (!cancelled) setLoading(false);
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
    source,
    runId,
  ]);

  const models = useMemo(
    () =>
      Array.from(
        new Set(leaderboard.map((r) => String(r.model ?? "")).filter(Boolean)),
      ),
    [leaderboard],
  );

  const totalN = useMemo(
    () => leaderboard.reduce((acc, r) => acc + (r.n ?? 0), 0),
    [leaderboard],
  );
  const bestRoi = useMemo(() => bestBy(leaderboard, "roi"), [leaderboard]);
  const bestHit = useMemo(() => bestBy(leaderboard, "hit_rate"), [leaderboard]);
  const bestClv = useMemo(() => bestBy(leaderboard, "mean_clv"), [leaderboard]);

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
      render: (row) => {
        const m = String(row.model ?? "");
        return (
          <Link
            href={`/${locale}/picks/model/${m}` as unknown as Parameters<typeof Link>[0]["href"]}
            className="inline-flex items-center gap-2 hover:text-accent"
            onClick={(e) => e.stopPropagation()}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2"
              style={{ background: colorForModel(m) }}
            />
            <span>{m}</span>
          </Link>
        );
      },
      sort: (a, b) =>
        String(a.model ?? "").localeCompare(String(b.model ?? "")),
    },
    {
      key: "n",
      header: "n",
      align: "right",
      render: (row) => row.n.toLocaleString(locale),
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
      render: (row) => {
        const v = row.roi;
        if (v === null || v === undefined) return "—";
        const tone =
          v > 0.001 ? "text-pos" : v < -0.001 ? "text-neg" : "text-text-dim";
        return <span className={tone}>{fmtPct(v)}</span>;
      },
      sort: (a, b) => (a.roi ?? 0) - (b.roi ?? 0),
    },
    {
      key: "pnl_total",
      header: "P&L",
      align: "right",
      render: (row) => {
        const v = row.pnl_total;
        const tone =
          v > 0.001 ? "text-pos" : v < -0.001 ? "text-neg" : "text-text-dim";
        return (
          <span className={tone}>
            {v >= 0 ? "+" : ""}
            {fmtNum(v, 2)}u
          </span>
        );
      },
      sort: (a, b) => (a.pnl_total ?? 0) - (b.pnl_total ?? 0),
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
        <div className="border border-neg/40 bg-bg p-4 font-mono text-[12px] text-neg">
          ▸ {t("picks.error")}: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader kicker="Picks · models" />

      {/* Backtest controls */}
      <div className="flex justify-between items-center mb-3">
        <DataSourcePicker />
        <RunBacktestButton
          onCreated={handleSelectRun}
          onAdvanced={() => setDialogOpen(true)}
        />
      </div>
      <BacktestRunsPanel onSelect={handleSelectRun} />
      <BacktestAdvancedDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleSelectRun}
      />

      {/* KPI strip */}
      <section className="grid grid-cols-2 divide-x divide-y divide-border border border-border md:grid-cols-4 md:divide-y-0">
        <Stat
          label="Best ROI"
          value={bestRoi ? fmtPct(bestRoi.roi) : "—"}
          delta={bestRoi ? String(bestRoi.model) : undefined}
          deltaTone={bestRoi && (bestRoi.roi ?? 0) > 0 ? "pos" : "neutral"}
        />
        <Stat
          label="Best hit rate"
          value={bestHit ? fmtPct(bestHit.hit_rate) : "—"}
          delta={bestHit ? String(bestHit.model) : undefined}
          deltaTone="neutral"
        />
        <Stat
          label="Best CLV"
          value={bestClv ? fmtNum(bestClv.mean_clv, 4) : "—"}
          delta={bestClv ? String(bestClv.model) : undefined}
          deltaTone={bestClv && (bestClv.mean_clv ?? 0) > 0 ? "pos" : "neutral"}
        />
        <Stat
          label="Total settled"
          value={loading ? "—" : totalN.toLocaleString(locale)}
          delta={`${leaderboard.length} ${leaderboard.length === 1 ? "model" : "models"}`}
          deltaTone="neutral"
        />
      </section>

      {/* Filters */}
      <FilterBar
        fields={["date", "status", "market", "competition", "edge"]}
        options={{
          markets: knownMarkets,
          competitions: knownComps,
        }}
      />

      {/* Leaderboard */}
      <section className="border border-border">
        <div className="flex items-baseline justify-between border-b border-border px-4 py-2">
          <Kicker>{t("picks.leaderboard.title")}</Kicker>
          <span className="font-mono text-[10px] text-text-faint">
            ▸ click a row to drill into a model
          </span>
        </div>
        <div className="overflow-x-auto px-4 pb-2">
          <DataTable
            columns={leaderboardCols}
            rows={leaderboard}
            empty={loading ? "▸ loading…" : "▸ no models in range"}
            onRowClick={(row) =>
              router.push(`/${locale}/picks/model/${row.model}` as unknown as Parameters<typeof router.push>[0])
            }
          />
        </div>
      </section>

      {/* Compare panel: chips switch the chart below */}
      <section className="border border-border">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <Kicker>Compare</Kicker>
          <div className="ml-2 flex flex-wrap items-center gap-1">
            <Chip selected={view === "pnl"} onClick={() => setView("pnl")}>
              P&L · time
            </Chip>
            <Chip selected={view === "clv"} onClick={() => setView("clv")}>
              CLV · distribution
            </Chip>
            <Chip selected={view === "market"} onClick={() => setView("market")}>
              ROI × Market
            </Chip>
            <Chip
              selected={view === "competition"}
              onClick={() => setView("competition")}
            >
              ROI × Competition
            </Chip>
          </div>
        </div>
        <div className="overflow-x-auto p-4">
          {view === "pnl" && (
            <CumulativeLineChart series={pnlSeries} width={960} height={280} />
          )}
          {view === "clv" && (
            <ViolinChart
              series={violinSeries}
              referenceY={0}
              width={960}
              height={280}
            />
          )}
          {view === "market" && (
            <HeatmapChart
              cells={marketCells}
              rows={models}
              cols={knownMarkets}
              minNToShow={5}
              width={960}
            />
          )}
          {view === "competition" && (
            <HeatmapChart
              cells={compCells}
              rows={models}
              cols={knownComps}
              minNToShow={5}
              width={960}
            />
          )}
        </div>
      </section>
    </div>
  );
}
