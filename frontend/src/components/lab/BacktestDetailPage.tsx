"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  KeyValue,
  ModelName,
  PageHeader,
  Panel,
  SampleSize,
  Skeleton,
  Stat,
  StatGrid,
  type Crumb
} from "@/components/ui";
import { ApiError, errorMessage } from "@/lib/api/http";
import { signTone } from "@/lib/format";
import { routes } from "@/lib/routes";
import { isActiveRun, useBacktestRun, type BacktestRunDetail } from "@/lib/lab/backtests";
import {
  betMetric,
  formatDuration,
  isAutoLabel,
  marketSpecLabel,
  runDurationMs,
  runTitle,
  runWindow,
  shortId,
  utcDate
} from "@/lib/lab/format";
import { NewBacktestDialog, prefillFromRun } from "./NewBacktestDialog";
import { RunActions } from "./RunActions";
import { RunBetsPanel } from "./RunBetsPanel";
import { PnlPanel, ReliabilityPanel } from "./RunCharts";
import { RunMlflowPanel } from "./RunMlflowPanel";
import { RunStatus } from "./RunStatus";

/** Fewer bets than this and the KPI tiles carry a small-sample warning. */
const MIN_N = 30;

export function BacktestDetailPage({ id }: { id: string }) {
  const { t, locale } = useLocale();
  const run = useBacktestRun(id);
  const crumbs: Crumb[] = [
    { label: t("nav.lab"), href: routes.backtests(locale) },
    { label: t("nav.lab.backtests"), href: routes.backtests(locale) }
  ];

  if (run.isLoading) {
    return (
      <>
        <PageHeader crumbs={crumbs} title={`#${shortId(id)}`} meta={t("common.loading")} />
        <div aria-busy="true" className="flex flex-col gap-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton lines={6} />
        </div>
      </>
    );
  }

  if (run.isError || !run.data) {
    const missing = run.error instanceof ApiError && run.error.status === 404;
    return (
      <>
        <PageHeader crumbs={crumbs} title={missing ? t("lab.detail.notFound.title") : `#${shortId(id)}`} />
        {missing ? (
          <Panel>
            <EmptyState
              title={t("lab.detail.notFound.title")}
              action={
                <ButtonLink href={routes.backtests(locale)} variant="primary">
                  {t("lab.detail.backToRuns")}
                </ButtonLink>
              }
            >
              {t("lab.detail.notFound.body", { id })}
            </EmptyState>
          </Panel>
        ) : (
          <Callout
            tone="neg"
            title={t("lab.detail.error")}
            action={
              <Button size="sm" onClick={() => run.refetch()} loading={run.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(run.error)}
          </Callout>
        )}
      </>
    );
  }

  return <RunDetail run={run.data} crumbs={crumbs} />;
}

function RunDetail({ run, crumbs }: { run: BacktestRunDetail; crumbs: Crumb[] }) {
  const { t, tp, fmt, locale } = useLocale();
  const router = useRouter();
  const [rerun, setRerun] = useState(false);
  const title = runTitle(run, locale, t);
  const completed = run.status === "completed";
  const n = run.total_bets ?? 0;
  const zeroBets = completed && n === 0;
  const duration = runDurationMs(run);

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={title}
        description={
          isAutoLabel(run)
            ? t("lab.detail.subtitle", { id: shortId(run.id) })
            : t("lab.detail.subtitleLabelled", { model: runTitle({ ...run, label: "" }, locale, t), id: shortId(run.id) })
        }
        meta={<RunStatus run={run} />}
        actions={
          <>
            {completed && n > 0 && (
              <ButtonLink href={routes.backtests(locale, { selected: run.id })} size="sm">
                {t("lab.detail.compareWith")}
              </ButtonLink>
            )}
            <Button size="sm" onClick={() => setRerun(true)}>
              {t("lab.detail.rerun")}
            </Button>
            <RunActions
              run={run}
              variant="danger"
              onDeleted={() => router.push(routes.backtests(locale))}
            />
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {run.status === "failed" && (
          <Callout tone="neg" title={t("lab.detail.failed")}>
            <span className="whitespace-pre-wrap break-words font-mono text-meta">
              {run.error ?? t("lab.detail.failedNoReason")}
            </span>
          </Callout>
        )}
        {run.status === "cancelled" && <Callout title={t("lab.detail.cancelled")}>{t("lab.detail.cancelledBody")}</Callout>}
        {isActiveRun(run) && (
          <Callout tone="info" title={t(run.status === "queued" ? "lab.detail.queued" : "lab.detail.running")}>
            {t("lab.detail.activeBody")}
          </Callout>
        )}
        {zeroBets && (
          <Callout
            tone="warn"
            title={t("lab.detail.zeroBets.title")}
            action={
              !run.force_bets && (
                <Button size="sm" onClick={() => setRerun(true)}>
                  {t("lab.detail.zeroBets.action")}
                </Button>
              )
            }
          >
            {t(run.force_bets ? "lab.detail.zeroBets.forced" : "lab.detail.zeroBets.body", {
              edge: fmt.num(run.min_edge * 100, 1)
            })}
          </Callout>
        )}

        <section aria-labelledby="run-kpis" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="run-kpis" className="font-sans text-label uppercase tracking-label text-text">
              {t("lab.detail.kpis")}
            </h2>
            <span className="text-meta text-text-dim">
              {t("lab.detail.kpiScope", { window: runWindow(run, locale, t) })} · <SampleSize n={completed ? n : null} min={MIN_N} />
            </span>
          </div>
          <Kpis run={run} />
        </section>

        <Panel title={t("lab.detail.settings")} description={t("lab.detail.settings.description")}>
          <KeyValue
            cols={2}
            items={[
              { label: t("common.model"), value: <ModelName name={run.model} /> },
              { label: t("lab.detail.marketSpec"), value: marketSpecLabel(run.market_spec, t) },
              { label: t("lab.new.trainUntil"), value: utcDate(locale, run.train_until) },
              {
                label: t("lab.new.testUntil"),
                value: run.test_until ? utcDate(locale, run.test_until) : t("lab.detail.testOpen")
              },
              { label: t("lab.new.minEdge"), value: fmt.num(run.min_edge * 100, 1) },
              { label: t("lab.new.kelly"), value: fmt.num(run.kelly_fraction, 2) },
              { label: t("lab.new.forceBets"), value: run.force_bets ? t("common.yes") : t("common.no") },
              {
                label: t("lab.detail.scope"),
                value: run.scope.length ? tp("lab.competitions", run.scope.length, { n: fmt.int(run.scope.length) }) : t("lab.detail.scopeAll")
              },
              { label: t("lab.detail.trainEvents"), value: fmt.int(run.n_train_events) },
              { label: t("lab.detail.testEvents"), value: fmt.int(run.test_events) },
              { label: t("common.created"), value: fmt.dateTime(run.created_at) },
              { label: t("lab.detail.duration"), value: duration === null ? "—" : formatDuration(duration, locale) }
            ]}
          />
          {run.scope.length > 0 && (
            <details className="mt-4 text-body">
              <summary className="cursor-pointer text-meta uppercase tracking-label text-text-dim hover:text-text">
                {t("lab.detail.scopeList")}
              </summary>
              <ul className="mt-2 grid gap-x-6 gap-y-1 text-text-dim sm:grid-cols-2 lg:grid-cols-3">
                {run.scope.map(([country, competition]) => (
                  <li key={`${country}|${competition}`} className="min-w-0 truncate">
                    <span className="text-text">{competition}</span>{" "}
                    <span className="text-text-faint">· {country.charAt(0) + country.slice(1).toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>

        {completed && n > 0 && (
          <div className="grid gap-6 xl:grid-cols-2">
            <ReliabilityPanel run={run} />
            <PnlPanel run={run} />
          </div>
        )}

        {completed && <RunBetsPanel run={run} />}

        <RunMlflowPanel run={run} />
      </div>

      {rerun && (
        <NewBacktestDialog
          open
          onClose={() => setRerun(false)}
          prefill={prefillFromRun(run, zeroBets && !run.force_bets ? { forceBets: true } : {})}
        />
      )}
    </>
  );
}

function Kpis({ run }: { run: BacktestRunDetail }) {
  const { t, fmt } = useLocale();
  const n = run.total_bets ?? 0;
  const small = run.status === "completed" && n > 0 && n < MIN_N ? t("common.smallSample", { n }) : undefined;
  const metric = (v: number | null | undefined) => (run.status === "completed" ? betMetric(run, v) : null);
  const roi = metric(run.roi);
  const sharpe = metric(run.sharpe_adjusted);
  const drawdown = metric(run.max_drawdown);
  return (
    <StatGrid cols={4} className="grid-cols-2">
      <Stat
        label={t("common.bets")}
        value={run.status === "completed" ? fmt.int(n) : "—"}
        sub={run.test_events ? t("lab.detail.ofTestEvents", { n: fmt.int(run.test_events) }) : undefined}
      />
      <Stat label={t("common.hitRate")} value={fmt.pct(metric(run.hit_rate))} caution={small} />
      <Stat label={t("common.roi")} value={fmt.pct(roi, 1, true)} tone={signTone(roi)} caution={small} />
      <Stat
        label={t("common.brier")}
        value={fmt.num(metric(run.brier), 3)}
        sub={t("lab.detail.lowerBetter")}
        caution={small}
      />
      <Stat label={t("common.logLoss")} value={fmt.num(metric(run.log_loss), 3)} sub={t("lab.detail.lowerBetter")} />
      <Stat
        label={t("common.maxDrawdown")}
        value={drawdown === null ? "—" : fmt.units(-Math.abs(drawdown))}
        tone={drawdown ? "neg" : "neutral"}
        sub={t("lab.detail.units")}
      />
      <Stat label={t("common.sharpeAdj")} value={fmt.signed(sharpe, 3)} tone={signTone(sharpe)} />
      <Stat label={t("common.clv")} value="—" sub={t("lab.detail.clvUndefined")} />
    </StatGrid>
  );
}
