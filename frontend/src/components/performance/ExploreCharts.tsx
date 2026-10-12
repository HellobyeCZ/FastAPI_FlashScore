"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { BinnedBarChart, HeatmapChart, type Bin, type HeatmapCell } from "@/components/charts";
import { EmptyState, SampleSize, Table } from "@/components/ui";
import { competitionRoot } from "@/lib/competition";
import { selectionLabel } from "@/lib/labels";
import { usePicksStats, type RowsResult } from "@/lib/performance/api";
import { MIN_N, type PicksQuery } from "@/lib/performance/filters";
import { edgeQuantileBins, foldStats, priceBuckets, type Interval } from "@/lib/performance/stats";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import {
  ChartPanel,
  joinNotes,
  MissingDataEmpty,
  NoBetsEmpty,
  panelStatus,
  usePp,
  useRowsNote,
  useWindowText,
  WidenActions
} from "./shared";

const CHART_HEIGHT = 260;

/** Heatmap cells with fewer bets are left blank (their n stays in the data table). */
const HEATMAP_MIN_N = 5;

/** Unique, short bar labels: whole numbers unless two groups would collide. */
function uniqueLabels(values: number[], format: (v: number, digits: number) => string): string[] {
  for (const digits of [0, 1, 2]) {
    const labels = values.map((v) => format(v, digits));
    if (new Set(labels).size === labels.length) return labels;
  }
  return values.map((v, i) => `${format(v, 2)} #${i + 1}`);
}

/** Realised flat-stake ROI per edge decile, against the ROI the model expected. */
export function EdgeDecilePanel({ state, settled }: { state: PerformanceFilterState; settled: RowsResult }) {
  const { t, fmt } = useLocale();
  const pp = usePp();
  const status = panelStatus(state, settled);
  const note = useRowsNote(settled);
  const groups = useMemo(() => edgeQuantileBins(settled.rows), [settled.rows]);
  const labels = uniqueLabels(
    groups.map((g) => g.mid * 100),
    (v, d) => fmt.signed(v, d)
  );
  const bins: Bin[] = groups.map((g, i) => ({
    label: labels[i],
    value: g.roi,
    n: g.n,
    ciLow: g.ci?.low ?? null,
    ciHigh: g.ci?.high ?? null,
    expected: g.expected
  }));
  const ci = (i: Interval | null) =>
    i ? t("performance.leaderboard.interval", { low: fmt.pct(i.low, 0, true), high: fmt.pct(i.high, 0, true) }) : fmt.num(null);
  const title = t("performance.chart.edge.title");
  const summary = t("performance.chart.edge.summary", {
    summary: groups.map((g, i) => `${labels[i]} pp: ${fmt.pct(g.roi, 0, true)} (n = ${fmt.int(g.n)})`).join("; ")
  });

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.edge.description")}
      status={status}
      isEmpty={bins.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      footer={note}
      table={
        <Table
          caption={title}
          rows={groups}
          rowKey={(_, i) => String(i)}
          columns={[
            {
              key: "range",
              header: t("performance.col.edgeRange"),
              cell: (g) => `${pp(g.lo)} – ${pp(g.hi)}`
            },
            { key: "n", header: t("performance.col.n"), cell: (g) => fmt.int(g.n), align: "right" },
            { key: "roi", header: t("performance.col.roi"), cell: (g) => fmt.pct(g.roi, 1, true), align: "right" },
            { key: "ci", header: t("performance.col.ci"), cell: (g) => ci(g.ci), align: "right", hideBelow: "sm" },
            {
              key: "expected",
              header: t("performance.col.expectedRoi"),
              cell: (g) => fmt.pct(g.expected, 1, true),
              align: "right"
            }
          ]}
        />
      }
    >
      <BinnedBarChart
        bins={bins}
        ariaLabel={summary}
        height={CHART_HEIGHT}
        xLabel={t("performance.chart.edge.xLabel")}
        yLabel={t("performance.chart.edge.yLabel")}
        format={(v) => fmt.pct(v, 0, true)}
        minN={MIN_N}
      />
    </ChartPanel>
  );
}

/** Hit rate per price bucket, against the hit rate each bucket needs to break even. */
export function PriceBucketPanel({ state, settled }: { state: PerformanceFilterState; settled: RowsResult }) {
  const { t, fmt } = useLocale();
  const status = panelStatus(state, settled);
  const note = useRowsNote(settled);
  const buckets = useMemo(() => priceBuckets(settled.rows), [settled.rows]);
  const label = (lo: number | null, hi: number | null) =>
    lo === null ? `≤${fmt.num(hi, 1)}` : hi === null ? `${fmt.num(lo, 0)}+` : `${fmt.num(lo, 1)}–${fmt.num(hi, 1)}`;
  const bins: Bin[] = buckets.map((b) => ({
    label: label(b.lo, b.hi),
    value: b.hitRate,
    n: b.n,
    ciLow: b.ci?.low ?? null,
    ciHigh: b.ci?.high ?? null,
    expected: b.breakEven
  }));
  const title = t("performance.chart.price.title");
  const summary = t("performance.chart.price.summary", {
    summary: buckets
      .map((b) => `${label(b.lo, b.hi)}: ${fmt.pct(b.hitRate, 0)} (n = ${fmt.int(b.n)})`)
      .join("; ")
  });

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.price.description")}
      status={status}
      isEmpty={bins.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      footer={note}
      table={
        <Table
          caption={title}
          rows={buckets}
          rowKey={(b) => label(b.lo, b.hi)}
          columns={[
            { key: "price", header: t("performance.col.priceRange"), cell: (b) => label(b.lo, b.hi) },
            { key: "n", header: t("performance.col.n"), cell: (b) => fmt.int(b.n), align: "right" },
            { key: "hit", header: t("performance.col.hitRate"), cell: (b) => fmt.pct(b.hitRate), align: "right" },
            {
              key: "ci",
              header: t("performance.col.ci"),
              cell: (b) =>
                b.ci
                  ? t("performance.leaderboard.interval", { low: fmt.pct(b.ci.low, 0), high: fmt.pct(b.ci.high, 0) })
                  : fmt.num(null),
              align: "right",
              hideBelow: "sm"
            },
            {
              key: "breakEven",
              header: t("performance.col.breakEven"),
              cell: (b) => fmt.pct(b.breakEven),
              align: "right"
            }
          ]}
        />
      }
    >
      <BinnedBarChart
        bins={bins}
        ariaLabel={summary}
        height={CHART_HEIGHT}
        xLabel={t("performance.chart.price.xLabel")}
        yLabel={t("performance.chart.price.yLabel")}
        format={(v) => fmt.pct(v, 0)}
        minN={MIN_N}
      />
    </ChartPanel>
  );
}

/** Mean CLV for each competition (stage variants folded) × pick. */
export function ClvHeatmapPanel({
  state,
  q,
  className
}: {
  state: PerformanceFilterState;
  q: PicksQuery;
  className?: string;
}) {
  const { t, tp, fmt } = useLocale();
  const windowText = useWindowText(state);
  const stats = usePicksStats(["competition", "selection"], q, state.ready);
  const status = panelStatus(state, stats);
  const data = useMemo(() => {
    const rows = stats.data?.rows ?? [];
    const total = rows.reduce((a, r) => a + r.n, 0);
    const folded = foldStats(rows, (r) => {
      const comp = competitionRoot(r.competition ?? null);
      return comp && r.selection ? `${comp}\u0000${r.selection}` : null;
    }).map((f) => {
      const [competition, selection] = f.key.split("\u0000");
      return { ...f, competition, selection };
    });
    const totals = new Map<string, number>();
    for (const f of folded) totals.set(f.competition, (totals.get(f.competition) ?? 0) + f.n);
    const competitions = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const selections = [...new Set(folded.map((f) => f.selection))].sort();
    const unknown = total - folded.reduce((a, f) => a + f.n, 0);
    return { folded, competitions, selections, total, unknown };
  }, [stats.data]);
  const colLabel = (s: string) => selectionLabel(s, t);
  const cells: HeatmapCell[] = data.folded.map((f) => ({
    row: f.competition,
    col: colLabel(f.selection),
    value: f.meanClv,
    n: f.n
  }));
  const title = t("performance.chart.heatmap.title");
  // A grid of nothing but blanks reads as broken; say why and keep the data table.
  const allSmall = !cells.some((c) => c.value !== null && c.n >= HEATMAP_MIN_N);

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.heatmap.description", { min: HEATMAP_MIN_N })}
      className={className}
      status={status}
      isEmpty={!data.folded.some((f) => f.meanClv !== null)}
      empty={
        data.total === 0 ? (
          <NoBetsEmpty state={state} compact />
        ) : data.folded.length === 0 ? (
          <MissingDataEmpty
            state={state}
            title={tp("performance.chart.noCompetition", data.total, {
              count: fmt.int(data.total),
              window: windowText
            })}
            body={t("performance.chart.noCompetitionBody")}
          />
        ) : (
          // Only the bets with a known competition were folded into cells.
          <MissingDataEmpty
            state={state}
            title={tp("performance.chart.noClv", data.total - data.unknown, {
              count: fmt.int(data.total - data.unknown),
              window: windowText
            })}
            body={t("performance.chart.noClvBody")}
          />
        )
      }
      footer={joinNotes(
        data.unknown > 0 && tp("performance.chart.unknownCompetition", data.unknown, { count: fmt.int(data.unknown) })
      )}
      table={
        <Table
          caption={title}
          rows={[...data.folded].sort((a, b) => b.n - a.n)}
          rowKey={(f) => f.key}
          columns={[
            { key: "competition", header: t("performance.col.competition"), cell: (f) => f.competition },
            { key: "pick", header: t("performance.col.pick"), cell: (f) => colLabel(f.selection) },
            { key: "n", header: t("performance.col.n"), cell: (f) => <SampleSize n={f.n} className="text-body" />, align: "right" },
            {
              key: "clv",
              header: t("performance.col.meanClv"),
              cell: (f) => fmt.pct(f.meanClv, 2, true),
              align: "right"
            }
          ]}
        />
      }
    >
      {allSmall ? (
        <EmptyState
          compact
          title={t("performance.chart.heatmap.allSmall", { min: HEATMAP_MIN_N, window: windowText })}
          action={<WidenActions state={state} />}
        >
          {t("performance.chart.heatmap.allSmallBody")}
        </EmptyState>
      ) : (
        <HeatmapChart
          cells={cells}
          rows={data.competitions}
          cols={data.selections.map(colLabel)}
          minNToShow={HEATMAP_MIN_N}
          ariaLabel={title}
          rowHeader={t("performance.col.competition")}
          formatValue={(v) => fmt.pct(v, 1, true)}
        />
      )}
    </ChartPanel>
  );
}
