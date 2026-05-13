"use client";

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
  priceBucketToRange,
  presetToDateRange,
} from "@/components/picks/filters/filter-types";
import { FilterBar } from "@/components/picks/filters/FilterBar";
import {
  ScatterChart,
  type ScatterPoint,
} from "@/components/terminal/charts/ScatterChart";
import {
  HeatmapChart,
  type HeatmapCell,
} from "@/components/terminal/charts/HeatmapChart";
import { BucketBars, type Bucket as TerminalBucket } from "@/components/terminal/BucketBars";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Kicker } from "@/components/terminal/Kicker";
import { MODEL_COLORS } from "@/components/terminal/charts/modelColors";

type Bucket = { label: string; value: number | null; n: number };

const EDGE_BUCKETS = ["0-2", "2-5", "5-10", "10-15", "15+"] as const;
const PRICE_BUCKETS = ["<=1.5", "1.5-2", "2-3", "3-5", "5+"] as const;

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function ExploreTab() {
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [hitByEdge, setHitByEdge] = useState<StatsRow[]>([]);
  const [roiByPrice, setRoiByPrice] = useState<StatsRow[]>([]);
  const [compSel, setCompSel] = useState<StatsRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const apiFilters: StatsFilters = useMemo(() => {
    const out: StatsFilters = { status: filters.status };
    const range = presetToDateRange(filters.datePreset);
    if (range.dateFrom) out.dateFrom = range.dateFrom;
    if (range.dateTo) out.dateTo = range.dateTo;
    if (filters.dateFrom) out.dateFrom = filters.dateFrom;
    if (filters.dateTo) out.dateTo = filters.dateTo;
    if (filters.model?.length) out.model = filters.model;
    if (filters.market?.length) out.market = filters.market;
    if (filters.sport?.length) out.sport = filters.sport;
    if (filters.country?.length) out.country = filters.country;
    if (filters.competition?.length) out.competition = filters.competition;
    if (filters.selection?.length) out.selection = filters.selection;
    if (filters.edge) {
      const er = edgeBucketToRange(filters.edge);
      if (er.edgeMin !== undefined) out.edgeMin = er.edgeMin;
      if (er.edgeMax !== undefined) out.edgeMax = er.edgeMax;
    }
    if (filters.price) {
      const pr = priceBucketToRange(filters.price);
      if (pr.priceMin !== undefined) out.priceMin = pr.priceMin;
      if (pr.priceMax !== undefined) out.priceMax = pr.priceMax;
    }
    return out;
  }, [
    filters.status,
    filters.datePreset,
    filters.dateFrom,
    filters.dateTo,
    filters.model?.join(","),
    filters.market?.join(","),
    filters.sport?.join(","),
    filters.country?.join(","),
    filters.competition?.join(","),
    filters.selection?.join(","),
    filters.edge,
    filters.price,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [hist, byEdge, byPrice, byCompSel] = await Promise.all([
          // RAW unfiltered history: scatter shows the raw realized-return
          // point cloud, intentionally not driven by the FilterBar.
          fetchHistory({ status: "settled", limit: 1000 }),
          fetchStats(["edge_bucket"], apiFilters),
          fetchStats(["price_bucket"], apiFilters),
          fetchStats(["competition", "selection"], apiFilters),
        ]);
        if (cancelled) return;
        setHistory(hist.rows);
        setHitByEdge(byEdge.rows);
        setRoiByPrice(byPrice.rows);
        setCompSel(byCompSel.rows);
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
    apiFilters.sport?.join(","),
    apiFilters.country?.join(","),
    apiFilters.competition?.join(","),
    apiFilters.selection?.join(","),
    apiFilters.edgeMin,
    apiFilters.edgeMax,
    apiFilters.priceMin,
    apiFilters.priceMax,
  ]);

  const scatterPoints: ScatterPoint[] = useMemo(() => {
    const out: ScatterPoint[] = [];
    for (const r of history) {
      if (r.edge === null || r.edge === undefined) continue;
      if (r.result === null || r.result === undefined) continue;
      const y = r.result === 1 ? (r.price_at_recommendation ?? 1) - 1 : -1;
      out.push({ x: r.edge, y, category: r.model });
    }
    return out;
  }, [history]);

  const hitByEdgeBuckets: Bucket[] = useMemo(() => {
    return EDGE_BUCKETS.map((label) => {
      const row = hitByEdge.find((r) => r.edge_bucket === label);
      return {
        label,
        value: row?.hit_rate ?? null,
        n: row?.n ?? 0,
      };
    }).filter((b) => b.value !== null);
  }, [hitByEdge]);

  const roiByPriceBuckets: Bucket[] = useMemo(() => {
    return PRICE_BUCKETS.map((label) => {
      const row = roiByPrice.find((r) => r.price_bucket === label);
      return {
        label,
        value: row?.roi ?? null,
        n: row?.n ?? 0,
      };
    }).filter((b) => b.value !== null);
  }, [roiByPrice]);

  const heatmapCells: HeatmapCell[] = useMemo(
    () =>
      compSel.map((r) => ({
        row: String(r.competition ?? ""),
        col: String(r.selection ?? ""),
        value: r.mean_clv,
        n: r.n,
      })),
    [compSel],
  );

  const heatmapRows = useMemo(
    () =>
      Array.from(
        new Set(heatmapCells.map((c) => c.row).filter(Boolean)),
      ).sort(),
    [heatmapCells],
  );
  const heatmapCols = useMemo(
    () =>
      Array.from(
        new Set(heatmapCells.map((c) => c.col).filter(Boolean)),
      ).sort(),
    [heatmapCells],
  );

  const toTerminalBuckets = (bs: Bucket[], { signed }: { signed: boolean }): TerminalBucket[] =>
    bs.map((b) => {
      const v = b.value ?? 0;
      const tone: TerminalBucket["tone"] = signed
        ? v >= 0
          ? "pos"
          : "neg"
        : "neutral";
      return { label: b.label, value: Math.abs(v), tone };
    });

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader kicker="Picks · explore" />
        <div className="border border-border p-6 font-mono text-[12px] text-text">
          {t("picks.error")}: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker="Picks · explore" />
      <FilterBar
        fields={[
          "date",
          "status",
          "model",
          "market",
          "sport",
          "country",
          "competition",
          "selection",
          "edge",
          "price",
          "bookmaker",
        ]}
      />

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.scatter.title")}</Kicker>
        <ScatterChart
          points={scatterPoints}
          colorByCategory={MODEL_COLORS}
          xLabel="edge"
          yLabel="return"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border border-border p-4">
          <Kicker className="mb-3 block">{t("picks.buckets.hitByEdge")}</Kicker>
          <BucketBars buckets={toTerminalBuckets(hitByEdgeBuckets, { signed: false })} height={120} />
        </section>

        <section className="border border-border p-4">
          <Kicker className="mb-3 block">{t("picks.buckets.roiByPrice")}</Kicker>
          <BucketBars buckets={toTerminalBuckets(roiByPriceBuckets, { signed: true })} height={120} />
        </section>
      </div>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.heatmap.competitionSelection")}</Kicker>
        <HeatmapChart
          cells={heatmapCells}
          rows={heatmapRows}
          cols={heatmapCols}
          minNToShow={5}
        />
      </section>

      <section className="border border-border p-4">
        <Kicker className="mb-3 block">{t("picks.drilldown.title")}</Kicker>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-[12px]">
            <thead>
              <tr className="border-b border-border">
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>event</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>model</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>market</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>sel</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>price</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>edge</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>result</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>pnl</th>
                <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>clv</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-text-dim" colSpan={9}>
                    —
                  </td>
                </tr>
              ) : (
                history.slice(0, 100).map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="px-2 py-2 text-[11px] text-text-dim">{row.event_id}</td>
                    <td className="px-2 py-2">{row.model}</td>
                    <td className="px-2 py-2">{row.market}</td>
                    <td className="px-2 py-2">{row.selection}</td>
                    <td className="px-2 py-2 tabular-nums">{fmtNum(row.price_at_recommendation, 2)}</td>
                    <td className="px-2 py-2 tabular-nums">{fmtPct(row.edge)}</td>
                    <td className="px-2 py-2">
                      {row.result === null || row.result === undefined ? (
                        <span className="text-text-dim">—</span>
                      ) : row.result === 1 ? (
                        <span className="text-pos">W</span>
                      ) : (
                        <span className="text-neg">L</span>
                      )}
                    </td>
                    <td className="px-2 py-2 tabular-nums">{fmtNum(row.pnl, 2)}</td>
                    <td className="px-2 py-2 tabular-nums">{fmtNum(row.clv, 4)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
