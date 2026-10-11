"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { CumulativeLineChart, HBarChart, ViolinChart, type LineSeries, type ViolinSeries } from "@/components/charts";
import { Table } from "@/components/ui";
import { modelColor, modelLabel } from "@/lib/labels";
import { usePicksStats, type RowsResult } from "@/lib/performance/api";
import type { PicksQuery } from "@/lib/performance/filters";
import { competitionKey, cumulativeByModel, dayOffset, foldStats } from "@/lib/performance/stats";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import { ChartPanel, Measured, NoBetsEmpty, panelStatus, useRowsNote } from "./shared";

const CHART_HEIGHT = 240;

/** A calendar day from the API ("2026-05-12") as a timestamp formatters accept. */
const dayIso = (day: string) => `${day}T12:00:00Z`;

/** Running P&L per model over time (settled bets, by settlement day). */
export function PnlOverTimePanel({
  state,
  q,
  className
}: {
  state: PerformanceFilterState;
  q: PicksQuery;
  className?: string;
}) {
  const { t, fmt } = useLocale();
  const stats = usePicksStats(["model", "day"], q, state.ready);
  const status = panelStatus(state.ready, stats);
  const data = useMemo(() => cumulativeByModel(stats.data?.rows ?? []), [stats.data]);

  const series: LineSeries[] = data.series.map((s, i) => {
    const points = s.points.map((p) => ({ x: dayOffset(data.firstDay!, p.day), y: p.cumulative }));
    return {
      label: modelLabel(s.model, t),
      color: modelColor(s.model, i),
      points: points[0].x > 0 ? [{ x: 0, y: 0 }, ...points] : points
    };
  });
  const tableRows = data.series.flatMap((s) => s.points.map((p) => ({ model: s.model, ...p })));
  const firstDay = data.firstDay ? fmt.date(dayIso(data.firstDay)) : "";
  const summary = data.series
    .map((s) => `${modelLabel(s.model, t)} ${fmt.units(s.points[s.points.length - 1].cumulative)}`)
    .join(", ");

  return (
    <ChartPanel
      title={t("performance.chart.pnl.title")}
      description={t("performance.chart.pnl.description")}
      className={className}
      status={status}
      isEmpty={data.series.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      footer={
        data.firstDay && data.lastDay
          ? t("performance.chart.pnl.axis", { first: firstDay, last: fmt.date(dayIso(data.lastDay)) })
          : undefined
      }
      table={
        <Table
          caption={t("performance.chart.pnl.title")}
          rows={tableRows}
          rowKey={(r) => `${r.model}-${r.day}`}
          maxHeight="18rem"
          columns={[
            { key: "day", header: t("performance.col.day"), cell: (r) => fmt.date(dayIso(r.day)) },
            { key: "model", header: t("performance.col.model"), cell: (r) => modelLabel(r.model, t) },
            { key: "n", header: t("performance.col.n"), cell: (r) => fmt.int(r.n), align: "right" },
            { key: "daily", header: t("performance.col.dailyPnl"), cell: (r) => fmt.units(r.daily), align: "right" },
            { key: "cum", header: t("performance.col.cumPnl"), cell: (r) => fmt.units(r.cumulative), align: "right" }
          ]}
        />
      }
    >
      <p className="sr-only">{t("performance.chart.pnl.summary", { summary })}</p>
      <Measured height={CHART_HEIGHT}>
        {(width) => (
          <CumulativeLineChart
            series={series}
            width={width}
            height={CHART_HEIGHT}
            xLabel={t("performance.chart.pnl.xLabel", { date: firstDay })}
            yLabel={t("performance.chart.pnl.yLabel")}
          />
        )}
      </Measured>
    </ChartPanel>
  );
}

/** ROI (or P&L) per competition, stage variants folded into one row. */
export function CompetitionPanel({
  state,
  q,
  metric,
  className
}: {
  state: PerformanceFilterState;
  q: PicksQuery;
  metric: "roi" | "pnl";
  className?: string;
}) {
  const { t, tp, fmt } = useLocale();
  const stats = usePicksStats(["competition"], q, state.ready);
  const status = panelStatus(state.ready, stats);
  const folded = useMemo(() => foldStats(stats.data?.rows ?? [], competitionKey), [stats.data]);
  const bars = folded
    .map((f) => {
      const value = metric === "roi" ? f.roi : f.n > 0 ? f.pnl : null;
      if (value === null) return null;
      return {
        label: f.key,
        value,
        n: f.n,
        valueLabel: metric === "roi" ? fmt.pct(value, 1, true) : fmt.units(value)
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const unstaked = folded.length - bars.length;
  const title = metric === "roi" ? t("performance.chart.competition.roiTitle") : t("performance.chart.competition.pnlTitle");

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.competition.description")}
      className={className}
      status={status}
      isEmpty={bars.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      footer={unstaked > 0 ? tp("performance.chart.competition.unstaked", unstaked) : undefined}
      table={
        <Table
          caption={title}
          rows={[...folded].sort((a, b) => b.n - a.n)}
          rowKey={(r) => r.key}
          columns={[
            { key: "competition", header: t("performance.col.competition"), cell: (r) => r.key },
            { key: "n", header: t("performance.col.n"), cell: (r) => fmt.int(r.n), align: "right" },
            { key: "pnl", header: t("performance.col.pnl"), cell: (r) => fmt.units(r.pnl), align: "right" },
            { key: "roi", header: t("performance.col.roi"), cell: (r) => fmt.pct(r.roi, 1, true), align: "right" }
          ]}
        />
      }
    >
      <HBarChart bars={bars} ariaLabel={title} />
    </ChartPanel>
  );
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Distribution of closing-line value per model (settled bets with a closing price). */
export function ClvDistributionPanel({
  state,
  settled,
  className
}: {
  state: PerformanceFilterState;
  settled: RowsResult;
  className?: string;
}) {
  const { t, fmt } = useLocale();
  const note = useRowsNote(settled);
  const status = panelStatus(state.ready, settled);
  const perModel = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of settled.rows) {
      if (r.clv === null) continue;
      const list = map.get(r.model) ?? [];
      list.push(r.clv);
      map.set(r.model, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [settled.rows]);
  const series: ViolinSeries[] = perModel.map(([model, values], i) => ({
    label: modelLabel(model, t),
    color: modelColor(model, i),
    values
  }));
  const title = t("performance.chart.clv.title");

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.clv.description")}
      className={className}
      status={status}
      isEmpty={series.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      footer={note}
      table={
        <Table
          caption={title}
          rows={perModel}
          rowKey={([model]) => model}
          columns={[
            { key: "model", header: t("performance.col.model"), cell: ([m]) => modelLabel(m, t) },
            { key: "n", header: t("performance.col.n"), cell: ([, v]) => fmt.int(v.length), align: "right" },
            {
              key: "median",
              header: t("performance.col.medianClv"),
              cell: ([, v]) => fmt.pct(median(v), 2, true),
              align: "right"
            },
            {
              key: "beat",
              header: t("performance.col.beatClose"),
              headerTitle: t("performance.col.beatCloseTitle"),
              cell: ([, v]) => fmt.pct(v.filter((x) => x > 0).length / v.length, 0),
              align: "right"
            }
          ]}
        />
      }
    >
      <p className="sr-only">
        {t("performance.chart.clv.summary", {
          summary: perModel.map(([m, v]) => `${modelLabel(m, t)} ${fmt.pct(median(v), 2, true)}`).join(", ")
        })}
      </p>
      <Measured height={CHART_HEIGHT}>
        {(width) => (
          <ViolinChart series={series} width={width} height={CHART_HEIGHT} referenceY={0} yLabel={t("performance.chart.clv.yLabel")} />
        )}
      </Measured>
    </ChartPanel>
  );
}
