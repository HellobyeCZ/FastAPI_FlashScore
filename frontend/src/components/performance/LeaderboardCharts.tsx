"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { CumulativeLineChart, HBarChart, ViolinChart, type LineSeries, type ViolinSeries } from "@/components/charts";
import { Table } from "@/components/ui";
import { modelColor, modelLabel } from "@/lib/labels";
import { usePicksStats, type RowsResult } from "@/lib/performance/api";
import type { PicksQuery } from "@/lib/performance/filters";
import { addDays, competitionKey, cumulativeByModel, dropFloatNoise, foldStats, pnlLine } from "@/lib/performance/stats";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import { ChartPanel, joinNotes, Measured, MissingDataEmpty, NoBetsEmpty, panelStatus, useRowsNote } from "./shared";

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
  const status = panelStatus(state, stats);
  const data = useMemo(() => cumulativeByModel(stats.data?.rows ?? []), [stats.data]);

  // Day 0 is the day before the first settlement of any model; each line
  // starts at 0u the day before its own first settlement.
  const origin = data.firstDay ? addDays(data.firstDay, -1) : null;
  const series: LineSeries[] = origin
    ? data.series.map((s, i) => ({
        label: modelLabel(s.model, t),
        color: modelColor(s.model, i),
        points: pnlLine(s.points, origin)
      }))
    : [];
  const tableRows = data.series.flatMap((s) => s.points.map((p) => ({ model: s.model, ...p })));
  const originText = origin ? fmt.date(dayIso(origin)) : "";
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
        origin && data.lastDay
          ? t("performance.chart.pnl.axis", { origin: originText, last: fmt.date(dayIso(data.lastDay)) })
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
            xLabel={t("performance.chart.pnl.xLabel", { date: originText })}
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
  const status = panelStatus(state, stats);
  const { folded, total, unknown } = useMemo(() => {
    const rows = stats.data?.rows ?? [];
    const folded = foldStats(rows, competitionKey);
    const total = rows.reduce((a, r) => a + r.n, 0);
    return { folded, total, unknown: total - folded.reduce((a, f) => a + f.n, 0) };
  }, [stats.data]);
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
      empty={
        total === 0 ? (
          <NoBetsEmpty state={state} compact />
        ) : folded.length === 0 ? (
          <MissingDataEmpty
            state={state}
            title={tp("performance.chart.noCompetition", total, { count: fmt.int(total) })}
            body={t("performance.chart.noCompetitionBody")}
          />
        ) : (
          <MissingDataEmpty
            state={state}
            title={tp("performance.chart.noStake", total, { count: fmt.int(total) })}
            body={t("performance.chart.noStakeBody")}
          />
        )
      }
      footer={joinNotes(
        unstaked > 0 && tp("performance.chart.competition.unstaked", unstaked, { count: fmt.int(unstaked) }),
        unknown > 0 && tp("performance.chart.unknownCompetition", unknown, { count: fmt.int(unknown) })
      )}
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
  const { t, tp, fmt } = useLocale();
  const note = useRowsNote(settled);
  const status = panelStatus(state, settled);
  const perModel = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of settled.rows) {
      if (r.clv === null) continue;
      const list = map.get(r.model) ?? [];
      // An unchanged price is 0, not a sliver above the close.
      list.push(dropFloatNoise(r.clv));
      map.set(r.model, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [settled.rows]);
  const total = settled.rows.length;
  const withoutClv = total - perModel.reduce((a, [, v]) => a + v.length, 0);
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
      empty={
        total === 0 ? (
          <NoBetsEmpty state={state} compact />
        ) : (
          <MissingDataEmpty
            state={state}
            title={tp("performance.chart.noClv", total, { count: fmt.int(total) })}
            body={t("performance.chart.noClvBody")}
          />
        )
      }
      footer={joinNotes(
        withoutClv > 0 && tp("performance.chart.withoutClv", withoutClv, { count: fmt.int(withoutClv) }),
        note
      )}
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
