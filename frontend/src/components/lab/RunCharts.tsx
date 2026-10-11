"use client";
import { CalibrationPlot, CumulativeLineChart } from "@/components/charts";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout, EmptyState, Panel, SampleSize, Skeleton, Table, type Column } from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import { useRunPnl, type BacktestRunDetail, type ReliabilityBucket } from "@/lib/lab/backtests";
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
      cell: (b) => `${fmt.pct(b.lower, 0)}–${fmt.pct(b.upper, 0)}`
    },
    { key: "pred", header: t("lab.reliability.col.predicted"), align: "right", cell: (b) => fmt.pct(b.mean_pred) },
    {
      key: "hit",
      header: t("lab.reliability.col.observed"),
      align: "right",
      cell: (b) => <span className={b.n < MIN_BUCKET_N ? "text-text-dim" : undefined}>{fmt.pct(b.hit_rate)}</span>
    },
    { key: "n", header: t("common.n"), align: "right", cell: (b) => <SampleSize n={b.n} min={MIN_BUCKET_N} /> }
  ];
  return (
    <Panel title={t("lab.reliability.title")} description={t("lab.reliability.description")}>
      {buckets.length === 0 ? (
        <EmptyState compact title={t("lab.reliability.empty")} />
      ) : (
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <ChartBox height={320} className="xl:max-w-sm">
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
            className="xl:flex-1"
          />
        </div>
      )}
    </Panel>
  );
}

/** Running P&L across the run's bets in chronological order. */
export function PnlPanel({ run }: { run: BacktestRunDetail }) {
  const { t, fmt, locale } = useLocale();
  const hasBets = (run.total_bets ?? 0) > 0;
  const pnl = useRunPnl(run.id, run.status === "completed" && hasBets);
  const curve = pnl.data;
  const final = curve?.points[curve.points.length - 1]?.y;
  return (
    <Panel
      title={t("lab.pnl.title")}
      description={t("lab.pnl.description", { kelly: fmt.num(run.kelly_fraction, 2) })}
      actions={
        curve && curve.points.length > 0 ? (
          <span className="text-meta text-text-dim">
            {t("lab.pnl.span", {
              from: utcDate(locale, curve.first_day),
              to: utcDate(locale, curve.last_day),
              total: fmt.units(final)
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
      ) : !curve || curve.points.length === 0 ? (
        <EmptyState compact title={t("lab.pnl.noBets")} />
      ) : (
        <>
          <ChartBox height={260}>
            {(w) => (
              <CumulativeLineChart
                width={w}
                height={260}
                series={[{ label: t("common.pnl"), color: "rgb(var(--accent))", points: curve.points }]}
              />
            )}
          </ChartBox>
          <p className="mt-2 text-meta text-text-faint">{t("lab.pnl.axis")}</p>
        </>
      )}
    </Panel>
  );
}
