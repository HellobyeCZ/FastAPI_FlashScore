"use client";
import { useCallback, useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  ModelName,
  PageHeader,
  Panel,
  SampleSize,
  Signed,
  Skeleton,
  Table,
  TextLink,
  type Column
} from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/http";
import { seriesColor } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useBacktestRunsById, useRunsPnl, type BacktestRunDetail } from "@/lib/lab/backtests";
import {
  MAX_COMPARE,
  betMetric,
  differences,
  marketSpecLabel,
  runTitle,
  shortId,
  utcDate,
  type Difference
} from "@/lib/lab/format";
import { idList, useSearchState } from "@/lib/lab/hooks";
import { LabTabs } from "./LabTabs";
import { PnlChart, type PnlSeries } from "./RunCharts";

type Row = { key: string; label: string; title?: string; cell: (run: BacktestRunDetail) => React.ReactNode };

/** Fewer bets than this and a run's KPIs are flagged as noise. */
const MIN_N = 30;

const hasBets = (run: BacktestRunDetail) => run.status === "completed" && (run.total_bets ?? 0) > 0;

/** Side-by-side KPIs and P&L of up to six runs (?ids=a,b,c). */
export function ComparePage() {
  const { t, tp, fmt, locale } = useLocale();
  const build = useCallback((q: Record<string, string>) => routes.compare(locale, (q.ids ?? "").split(",").filter(Boolean)), [locale]);
  const { params, set } = useSearchState(build);
  const ids = idList(params.get("ids"), MAX_COMPARE);
  const queries = useBacktestRunsById(ids);
  const runs = queries.map((q) => q.data).filter((r): r is BacktestRunDetail => Boolean(r));
  const loading = queries.some((q) => q.isLoading);
  const failed = queries
    .map((q, i) => ({ id: ids[i], query: q }))
    .filter(({ query }) => query.isError);
  const pnl = useRunsPnl(ids, (id) => runs.some((r) => r.id === id && hasBets(r)));
  const diffs = differences(runs);
  const index = (id: string) => ids.indexOf(id);

  function remove(id: string) {
    set({ ids: ids.filter((x) => x !== id).join(",") || null });
  }

  const header = (
    <PageHeader
      crumbs={[
        { label: t("nav.lab"), href: routes.backtests(locale) },
        { label: t("nav.lab.backtests"), href: routes.backtests(locale) }
      ]}
      title={t("lab.compare.title")}
      description={t("lab.compare.description")}
      meta={ids.length > 0 ? tp("lab.runs", ids.length, { n: fmt.int(ids.length) }) : undefined}
      actions={
        <ButtonLink href={routes.backtests(locale, { selected: ids.join(",") || null })} size="sm">
          {t("lab.compare.change")}
        </ButtonLink>
      }
    />
  );

  const rows: Row[] = useMemo(
    () => [
      { key: "model", label: t("common.model"), cell: (r) => <ModelName name={r.model} /> },
      { key: "train", label: t("lab.new.trainUntil"), cell: (r) => utcDate(locale, r.train_until) },
      {
        key: "test",
        label: t("lab.new.testUntil"),
        cell: (r) => (r.test_until ? utcDate(locale, r.test_until) : t("lab.detail.testOpen"))
      },
      {
        key: "scope",
        label: t("lab.detail.scope"),
        cell: (r) =>
          r.scope.length ? tp("lab.competitions", r.scope.length, { n: fmt.int(r.scope.length) }) : t("lab.detail.scopeAll")
      },
      { key: "market", label: t("lab.detail.marketSpec"), cell: (r) => marketSpecLabel(r.market_spec, t) },
      { key: "edge", label: t("lab.new.minEdge"), cell: (r) => fmt.num(r.min_edge * 100, 1) },
      {
        key: "kelly",
        label: t("lab.new.kelly"),
        cell: (r) => `${fmt.num(r.kelly_fraction, 2)}${r.force_bets ? ` · ${t("lab.compare.forced")}` : ""}`
      },
      { key: "events", label: t("lab.detail.testEvents"), cell: (r) => fmt.int(r.test_events) },
      {
        key: "bets",
        label: t("common.bets"),
        cell: (r) =>
          r.status === "completed" ? (
            <span className="inline-flex items-baseline gap-2">
              {fmt.int(r.total_bets ?? 0)}
              {(r.total_bets ?? 0) < MIN_N && <SampleSize n={r.total_bets ?? 0} min={MIN_N} />}
            </span>
          ) : (
            "—"
          )
      },
      { key: "hit", label: t("common.hitRate"), cell: (r) => fmt.pct(betMetric(r, r.hit_rate)) },
      { key: "roi", label: t("common.roi"), cell: (r) => <Signed value={betMetric(r, r.roi)} format="pct" /> },
      {
        key: "brier",
        label: t("common.brier"),
        title: t("lab.metric.brier.title"),
        cell: (r) => fmt.num(betMetric(r, r.brier), 3)
      },
      { key: "logloss", label: t("common.logLoss"), cell: (r) => fmt.num(betMetric(r, r.log_loss), 3) },
      {
        key: "dd",
        label: t("common.maxDrawdown"),
        cell: (r) => {
          const dd = betMetric(r, r.max_drawdown);
          return dd === null ? "—" : <span className={dd ? "text-neg" : undefined}>{fmt.units(-Math.abs(dd))}</span>;
        }
      },
      {
        key: "sharpe",
        label: t("common.sharpeAdj"),
        title: t("lab.metric.sharpe.title"),
        cell: (r) => <Signed value={betMetric(r, r.sharpe_adjusted)} digits={3} />
      },
      { key: "clv", label: t("common.clv"), title: t("lab.detail.clvUndefined"), cell: () => "—" }
    ],
    [t, tp, fmt, locale]
  );

  if (ids.length < 2) {
    return (
      <>
        {header}
        <LabTabs active="backtests" />
        <Panel>
          <EmptyState
            title={t("lab.compare.empty.title")}
            action={
              <ButtonLink href={routes.backtests(locale, { selected: ids.join(",") || null })} variant="primary">
                {t("lab.compare.pickRuns")}
              </ButtonLink>
            }
          >
            {t("lab.compare.empty.body", { max: MAX_COMPARE })}
          </EmptyState>
        </Panel>
      </>
    );
  }

  const columns: Column<Row>[] = [
    {
      key: "metric",
      header: <span className="sr-only">{t("lab.compare.metric")}</span>,
      className: "whitespace-nowrap text-text-dim",
      cell: (row) => <span title={row.title}>{row.label}</span>
    },
    ...runs.map<Column<Row>>((run) => ({
      key: run.id,
      header: <RunHeader run={run} index={index(run.id)} onRemove={() => remove(run.id)} />,
      align: "right",
      className: "whitespace-nowrap",
      cell: (row) => row.cell(run)
    }))
  ];

  const series: PnlSeries[] = runs
    .map((run, i) => ({ run, curve: pnl[ids.indexOf(run.id)]?.data, i }))
    .filter(({ run, curve }) => hasBets(run) && curve && curve.days.length > 0)
    .map(({ run, curve }) => ({
      key: run.id,
      label: `#${index(run.id) + 1}`,
      title: runTitle(run, locale, t),
      color: seriesColor(index(run.id)),
      curve: curve!
    }));
  const pnlLoading = pnl.some((q) => q.isLoading);
  const pnlError = pnl.find((q) => q.isError);

  return (
    <>
      {header}
      <LabTabs active="backtests" />
      <div className="flex flex-col gap-6">
        {failed.map(({ id, query }) => {
          const missing = query.error instanceof ApiError && query.error.status === 404;
          return (
            <Callout
              key={id}
              tone="neg"
              title={missing ? t("lab.compare.missing", { id: shortId(id) }) : t("lab.compare.runError", { id: shortId(id) })}
              action={
                <>
                  {!missing && (
                    <Button size="sm" onClick={() => query.refetch()} loading={query.isFetching}>
                      {t("common.retry")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => remove(id)}>
                    {t("lab.compare.remove")}
                  </Button>
                </>
              }
            >
              {missing ? t("lab.compare.missingBody") : errorMessage(query.error)}
            </Callout>
          );
        })}

        {diffs.length > 0 && (
          <Callout tone="warn" title={t("lab.compare.notComparable")}>
            {t("lab.compare.notComparableBody", { what: diffs.map((d: Difference) => t(`lab.compare.diff.${d}`)).join(", ") })}
          </Callout>
        )}

        <Panel title={t("lab.compare.kpis")} description={t("lab.compare.kpis.description")} padding="none">
          {loading && runs.length === 0 ? (
            <div className="p-4">
              <Skeleton lines={8} />
            </div>
          ) : (
            <>
              <Table caption={t("lab.compare.caption")} columns={columns} rows={rows} rowKey={(r) => r.key} />
              {runs.length > 1 && (
                <p className="border-t border-border px-4 py-2 text-meta text-text-faint sm:hidden">
                  {t("lab.compare.scrollHint")}
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel title={t("lab.pnl.title")} description={t("lab.compare.pnl.description")}>
          {pnlLoading && series.length === 0 ? (
            <Skeleton className="h-60 w-full" />
          ) : pnlError ? (
            <Callout
              tone="neg"
              title={t("lab.pnl.error")}
              action={
                <Button size="sm" onClick={() => pnlError.refetch()} loading={pnlError.isFetching}>
                  {t("common.retry")}
                </Button>
              }
            >
              {errorMessage(pnlError.error)}
            </Callout>
          ) : series.length === 0 ? (
            <EmptyState compact title={t("lab.compare.pnl.empty")} />
          ) : (
            <PnlChart series={series} height={300} />
          )}
        </Panel>
      </div>
    </>
  );
}

function RunHeader({ run, index, onRemove }: { run: BacktestRunDetail; index: number; onRemove: () => void }) {
  const { t, locale } = useLocale();
  const title = runTitle(run, locale, t);
  return (
    <span className="flex flex-col items-end gap-1 normal-case tracking-normal">
      <span className="flex items-center gap-2">
        <span aria-hidden className="inline-block h-0.5 w-4" style={{ background: seriesColor(index) }} />
        <span className="font-mono text-text">#{index + 1}</span>
      </span>
      <TextLink href={routes.backtest(locale, run.id)} className="max-w-[9rem] truncate text-body sm:max-w-[14rem]">
        {title}
      </TextLink>
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t("lab.compare.removeNamed", { title })}>
        {t("lab.compare.remove")}
      </Button>
    </span>
  );
}
