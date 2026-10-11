"use client";
import { CalibrationPlot, CumulativeLineChart } from "@/components/charts";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout, EmptyState, Panel, SampleSize, Skeleton, Table, type Column } from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import {
  curvePoints,
  useRunPnl,
  type BacktestRunDetail,
  type PnlCurve,
  type ReliabilityBucket
} from "@/lib/lab/backtests";
import { utcDate } from "@/lib/lab/format";
import { ChartBox } from "./ChartBox";

const MIN_BUCKET_N = 30;

/** Calibration of the placed bets with the sample behind every point. */
export function ReliabilityPanel({ run }: { run: BacktestRunDetail }) {
  const { t, fmt } = useLocale();
  const buckets = run.reliability_buckets.filter((b) => b.n > 0);
  const columns: Column<ReliabilityBucket>[] = [
    {
      key: "range",
      header: t("lab.reliability.col.range"),
      hideBelow: "sm",
      cell: (b) => <span className="whitespace-nowrap">{`${fmt.pct(b.lower, 0)}–${fmt.pct(b.upper, 0)}`}</span>
    },
    { key: "pred", header: t("lab.reliability.col.predicted"), align: "right", cell: (b) => fmt.pct(b.mean_pred) },
    {
      key: "hit",
      header: t("lab.reliability.col.observed"),
      align: "right",
      cell: (b) => <span className={b.n < MIN_BUCKET_N ? "text-text-dim" : undefined}>{fmt.pct(b.hit_rate)}</span>
    },
    { key: "n", header: t("common.n"), align: "right", cell: (b) => <SampleSize n={b.n} min={MIN_BUCKET_N} className="whitespace-nowrap" /> }
  ];
  return (
    <Panel title={t("lab.reliability.title")} description={t("lab.reliability.description")}>
      {buckets.length === 0 ? (
        <EmptyState compact title={t("lab.reliability.empty")} />
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <ChartBox height={320} className="lg:max-w-sm">
            {(w) => {
              const size = Math.min(w, 360);
              return <CalibrationPlot buckets={buckets} width={size} height={size} />;
            }}
          </ChartBox>
          <Table
            caption={t("lab.reliability.caption")}
            columns={columns}
            rows={buckets}
            rowKey={(b) => `${b.lower}`}
            className="lg:flex-1"
          />
        </div>
      )}
    </Panel>
  );
}

export type PnlSeries = { key: string; label: string; title: string; color: string; curve: PnlCurve };

/**
 * Cumulative P&L over bet time for one or more runs. All series share one
 * origin (the earliest bet day) so runs with different windows line up.
 */
export function PnlChart({ series, height = 260 }: { series: PnlSeries[]; height?: number }) {
  const { t, locale } = useLocale();
  const origin = series
    .map((s) => s.curve.first_day)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  if (!origin) return null;
  return (
    <div className="flex flex-col gap-2">
      <ChartBox height={height}>
        {(w) => (
          <CumulativeLineChart
            width={w}
            height={height}
            series={series.map((s) => ({ label: s.label, color: s.color, points: curvePoints(s.curve, origin) }))}
          />
        )}
      </ChartBox>
      <p className="text-meta text-text-faint">{t("lab.pnl.axis", { start: utcDate(locale, `${origin}T00:00:00Z`) })}</p>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-meta text-text-dim">
          {series.map((s) => (
            <li key={s.key} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="inline-block h-0.5 w-4 shrink-0" style={{ background: s.color }} />
              <span className="font-mono text-text">{s.label}</span>
              <span className="truncate">{s.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Running P&L across the run's bets by bet date. */
export function PnlPanel({ run }: { run: BacktestRunDetail }) {
  const { t, fmt, locale } = useLocale();
  const hasBets = (run.total_bets ?? 0) > 0;
  const pnl = useRunPnl(run.id, run.status === "completed" && hasBets);
  const curve = pnl.data;
  return (
    <Panel
      title={t("lab.pnl.title")}
      description={t("lab.pnl.description", { kelly: fmt.num(run.kelly_fraction, 2) })}
      actions={
        curve && curve.days.length > 0 ? (
          <span className="text-meta text-text-dim">
            {t("lab.pnl.span", {
              from: utcDate(locale, `${curve.first_day}T00:00:00Z`),
              to: utcDate(locale, `${curve.last_day}T00:00:00Z`),
              total: fmt.units(curve.pnl)
            })}
          </span>
        ) : undefined
      }
    >
      {!hasBets ? (
        <EmptyState compact title={t("lab.pnl.noBets")} />
      ) : pnl.isLoading ? (
        <Skeleton className="h-60 w-full" />
      ) : pnl.isError ? (
        <Callout
          tone="neg"
          title={t("lab.pnl.error")}
          action={
            <Button size="sm" onClick={() => pnl.refetch()} loading={pnl.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(pnl.error)}
        </Callout>
      ) : !curve || curve.days.length === 0 ? (
        <EmptyState compact title={t("lab.pnl.noBets")} />
      ) : (
        <PnlChart
          series={[{ key: run.id, label: t("common.pnl"), title: "", color: "rgb(var(--accent))", curve }]}
        />
      )}
    </Panel>
  );
}
