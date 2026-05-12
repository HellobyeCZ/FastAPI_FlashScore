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
  priceBucketToRange,
  presetToDateRange,
} from "@/components/picks/filters/filter-types";
import { FilterBar } from "@/components/picks/filters/FilterBar";
import {
  ScatterChart,
  type ScatterPoint,
} from "@/components/picks/charts/ScatterChart";
import {
  BucketedBarChart,
  type Bucket,
} from "@/components/picks/charts/BucketedBarChart";
import {
  HeatmapChart,
  type HeatmapCell,
} from "@/components/picks/charts/HeatmapChart";

// Avoid unused-import lint while keeping the import slot for parity with
// ModelsTab (drilldown could link to event pages later).
void Link;

const MODEL_COLORS: Record<string, string> = {
  dixon_coles: "#1f77b4",
  hgb: "#ff7f0e",
  logistic: "#d62728",
};

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

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.scatter.title")}
        </h2>
        <ScatterChart
          points={scatterPoints}
          colorByCategory={MODEL_COLORS}
          xLabel="edge"
          yLabel="return"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
            {t("picks.buckets.hitByEdge")}
          </h2>
          <BucketedBarChart buckets={hitByEdgeBuckets} />
        </section>

        <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
            {t("picks.buckets.roiByPrice")}
          </h2>
          <BucketedBarChart buckets={roiByPriceBuckets} referenceY={0} />
        </section>
      </div>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.heatmap.competitionSelection")}
        </h2>
        <HeatmapChart
          cells={heatmapCells}
          rows={heatmapRows}
          cols={heatmapCols}
          minNToShow={5}
        />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.drilldown.title")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2">event</th>
                <th className="px-2 py-2">model</th>
                <th className="px-2 py-2">market</th>
                <th className="px-2 py-2">sel</th>
                <th className="px-2 py-2">price</th>
                <th className="px-2 py-2">edge</th>
                <th className="px-2 py-2">result</th>
                <th className="px-2 py-2">pnl</th>
                <th className="px-2 py-2">clv</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td
                    className="px-2 py-3 text-[color:var(--color-text-muted)]"
                    colSpan={9}
                  >
                    —
                  </td>
                </tr>
              ) : (
                history.slice(0, 100).map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-[color:var(--color-brand-outline)]"
                  >
                    <td className="px-2 py-2 font-mono text-xs">
                      {row.event_id}
                    </td>
                    <td className="px-2 py-2">{row.model}</td>
                    <td className="px-2 py-2">{row.market}</td>
                    <td className="px-2 py-2">{row.selection}</td>
                    <td className="px-2 py-2">
                      {fmtNum(row.price_at_recommendation, 2)}
                    </td>
                    <td className="px-2 py-2">{fmtPct(row.edge)}</td>
                    <td className="px-2 py-2">
                      {row.result === null || row.result === undefined
                        ? "—"
                        : row.result === 1
                          ? "W"
                          : "L"}
                    </td>
                    <td className="px-2 py-2">{fmtNum(row.pnl, 2)}</td>
                    <td className="px-2 py-2">{fmtNum(row.clv, 4)}</td>
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
