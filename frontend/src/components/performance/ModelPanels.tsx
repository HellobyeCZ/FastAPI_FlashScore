"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { useRegistry } from "@/hooks/useMlflow";
import { ApiError } from "@/lib/api/http";
import { routes } from "@/lib/routes";
import { useBacktestRuns, useCalibration } from "@/lib/performance/api";
import { MIN_N, type PicksQuery } from "@/lib/performance/filters";
import type { BacktestRunLite, CalibrationBucket } from "@/lib/performance/types";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import type { ModelVersion } from "@/types/mlflow";
import { CalibrationPlot } from "@/components/charts";
import {
  Badge,
  ButtonLink,
  Callout,
  EmptyState,
  Panel,
  SampleSize,
  Signed,
  Skeleton,
  StateBadge,
  Table,
  TextLink
} from "@/components/ui";
import { CalloutBody, ChartPanel, Measured, NoBetsEmpty, OpsLink, PanelError, panelStatus } from "./shared";

// ---------------------------------------------------------------------------
// Calibration

/** Predicted vs. observed hit rate; below MIN_N settled bets only the bucket counts are shown. */
export function CalibrationPanel({
  state,
  model,
  q
}: {
  state: PerformanceFilterState;
  model: string;
  q: PicksQuery;
}) {
  const { t, tp, fmt } = useLocale();
  const cal = useCalibration(model, q, state.ready);
  const status = panelStatus(state.ready, cal);
  const buckets = useMemo(
    () => [...(cal.data?.buckets ?? [])].sort((a, b) => a.lower - b.lower),
    [cal.data]
  );
  const total = buckets.reduce((a, b) => a + b.n, 0);
  const enough = total >= MIN_N;
  const title = t("performance.chart.calibration.title");

  const table = (
    <Table<CalibrationBucket>
      caption={title}
      rows={buckets}
      rowKey={(b) => String(b.lower)}
      columns={[
        {
          key: "bucket",
          header: t("performance.col.bucket"),
          cell: (b) => `${fmt.pct(b.lower, 0)}–${fmt.pct(b.upper, 0)}`
        },
        { key: "n", header: t("performance.col.n"), cell: (b) => <SampleSize n={b.n} className="text-body" />, align: "right" },
        { key: "pred", header: t("performance.col.meanPred"), cell: (b) => fmt.pct(b.mean_pred), align: "right" },
        { key: "obs", header: t("performance.col.observed"), cell: (b) => fmt.pct(b.hit_rate), align: "right" }
      ]}
    />
  );

  return (
    <ChartPanel
      title={title}
      description={t("performance.chart.calibration.description")}
      status={status}
      isEmpty={buckets.length === 0}
      empty={<NoBetsEmpty state={state} compact />}
      table={enough ? table : undefined}
      skeletonClass="h-72"
    >
      {enough ? (
        <>
          <p className="sr-only">
            {t("performance.chart.calibration.summary", {
              summary: buckets
                .map((b) => `${fmt.pct(b.mean_pred)} → ${fmt.pct(b.hit_rate)} (n = ${fmt.int(b.n)})`)
                .join("; ")
            })}
          </p>
          <Measured height={320} max={480}>
            {(width) => <CalibrationPlot buckets={buckets} width={width} height={Math.min(width, 320)} />}
          </Measured>
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <Callout title={t("performance.chart.calibration.insufficient")}>
            {tp("performance.chart.calibration.insufficientBody", total, { count: fmt.int(total), min: MIN_N })}
          </Callout>
          {table}
        </div>
      )}
    </ChartPanel>
  );
}

// ---------------------------------------------------------------------------
// Registry

/** Version number for sorting ("12" > "9"). */
const versionNumber = (v: ModelVersion) => Number(v.version) || 0;

function metric(v: ModelVersion, ...keys: string[]): number | null {
  for (const k of keys) {
    const value = v.metrics[k];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** MLflow registry versions of `picks-<model>` with champion/challenger and their evidence. */
export function RegistryPanel({ model, className }: { model: string; className?: string }) {
  const { t, fmt, locale } = useLocale();
  const registry = useRegistry();
  const registeredName = `picks-${model}`;
  const entry = registry.data?.models.find((m) => m.model_name === model || m.name === registeredName);
  const versions = useMemo(
    () => [...(entry?.versions ?? [])].sort((a, b) => versionNumber(b) - versionNumber(a)),
    [entry]
  );
  const mlflow = registry.data?.status;
  const manage = (
    <ButtonLink href={routes.registry(locale)} size="sm">
      {t("performance.registry.manage")}
    </ButtonLink>
  );

  let body: React.ReactNode;
  if (registry.isLoading) {
    body = <Skeleton lines={4} className="p-4" />;
  } else if (registry.isError) {
    const missing = registry.error instanceof ApiError && registry.error.status === 404;
    body = (
      <div className="p-4">
        {missing ? (
          <Callout tone="info">{t("performance.registry.unavailable")}</Callout>
        ) : (
          <PanelError status={panelStatus(true, registry)} />
        )}
      </div>
    );
  } else if (mlflow && !mlflow.enabled) {
    body = (
      <div className="p-4">
        <Callout tone="info" title={t("performance.registry.disabled")} />
      </div>
    );
  } else if (mlflow && !mlflow.reachable) {
    body = (
      <div className="p-4">
        <Callout tone="warn" title={t("performance.registry.unreachable")}>
          <CalloutBody action={<OpsLink />}>{t("performance.registry.unreachableBody")}</CalloutBody>
        </Callout>
      </div>
    );
  } else if (!entry || versions.length === 0) {
    body = (
      <EmptyState compact title={t("performance.registry.empty")} action={manage}>
        {t("performance.registry.emptyBody", { name: registeredName })}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {entry.aliases.champion && (
            <Badge tone="accent">
              {t("performance.registry.champion")} · {t("performance.registry.version", { version: entry.aliases.champion })}
            </Badge>
          )}
          {entry.aliases.challenger && (
            <Badge tone="info">
              {t("performance.registry.challenger")} · {t("performance.registry.version", { version: entry.aliases.challenger })}
            </Badge>
          )}
          {entry.servable ? (
            <Badge tone="pos">{t("performance.registry.servable")}</Badge>
          ) : (
            <Badge title={t("performance.registry.notServableTitle")}>{t("performance.registry.notServable")}</Badge>
          )}
        </div>
        <Table<ModelVersion>
          caption={t("performance.registry.caption")}
          rows={versions}
          rowKey={(v) => v.version}
          columns={[
            {
              key: "version",
              header: t("performance.col.version"),
              cell: (v) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{t("performance.registry.version", { version: v.version })}</span>
                  {v.aliases.includes("champion") && <Badge tone="accent">{t("performance.registry.champion")}</Badge>}
                  {v.aliases.includes("challenger") && <Badge tone="info">{t("performance.registry.challenger")}</Badge>}
                </span>
              )
            },
            {
              key: "created",
              header: t("performance.col.created"),
              cell: (v) => <span className="whitespace-nowrap text-text-dim">{fmt.date(v.created_at)}</span>,
              hideBelow: "lg"
            },
            {
              key: "n",
              header: t("performance.col.n"),
              cell: (v) => {
                const n = metric(v, "n_bets", "total_bets");
                return n === null ? fmt.int(null) : <SampleSize n={n} className="text-body" />;
              },
              align: "right",
              hideBelow: "sm"
            },
            {
              key: "roi",
              header: t("performance.col.roi"),
              cell: (v) => <Signed value={metric(v, "n_bets", "total_bets") === 0 ? null : metric(v, "roi")} format="pct" />,
              align: "right"
            },
            {
              key: "sharpe",
              header: t("performance.col.sharpe"),
              cell: (v) => fmt.signed(metric(v, "sharpe_adjusted"), 2),
              align: "right",
              hideBelow: "md"
            },
            {
              key: "brier",
              header: t("performance.col.brier"),
              cell: (v) => fmt.num(metric(v, "brier"), 3),
              align: "right",
              hideBelow: "md"
            },
            {
              key: "mlflow",
              header: t("performance.col.links"),
              cell: (v) =>
                v.ui_url ? (
                  <TextLink href={v.ui_url} external>
                    {t("performance.registry.openMlflow")}
                  </TextLink>
                ) : (
                  fmt.num(null)
                ),
              align: "right"
            }
          ]}
        />
      </>
    );
  }

  return (
    <Panel
      title={t("performance.registry.title")}
      description={t("performance.registry.description", { name: registeredName })}
      padding="none"
      className={className}
      actions={
        entry ? (
          <>
            {entry.ui_url && (
              <ButtonLink href={entry.ui_url} external size="sm" variant="ghost">
                {t("performance.registry.openMlflow")}
              </ButtonLink>
            )}
            {manage}
          </>
        ) : undefined
      }
    >
      {body}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Backtests

/** This model's backtest runs (Model lab); 0-bet runs show "—" instead of a fake 0 %. */
export function BacktestsPanel({ model, className }: { model: string; className?: string }) {
  const { t, fmt, locale } = useLocale();
  const runs = useBacktestRuns();
  const rows = useMemo(
    () =>
      (runs.data?.items ?? [])
        .filter((r) => r.model === model)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs.data, model]
  );
  const status = panelStatus(true, runs);
  const hasBets = (r: BacktestRunLite) => (r.total_bets ?? 0) > 0;
  const lab = (
    <ButtonLink href={routes.backtests(locale)} size="sm">
      {t("performance.backtests.action")}
    </ButtonLink>
  );

  return (
    <Panel
      title={t("performance.backtests.title")}
      description={t("performance.backtests.description")}
      padding="none"
      className={className}
      actions={rows.length > 0 ? lab : undefined}
    >
      {status.error ? (
        <div className="p-4">
          <PanelError status={status} />
        </div>
      ) : (
        <Table<BacktestRunLite>
          caption={t("performance.backtests.caption")}
          rows={rows}
          rowKey={(r) => r.id}
          rowHref={(r) => routes.backtest(locale, r.id)}
          linkColumn="run"
          loading={status.loading}
          skeletonRows={3}
          empty={
            <EmptyState compact title={t("performance.backtests.empty")} action={lab}>
              {t("performance.backtests.emptyBody")}
            </EmptyState>
          }
          columns={[
            {
              key: "run",
              header: t("performance.col.run"),
              cell: (r) => (
                <span className="flex w-44 min-w-0 flex-col sm:w-auto sm:max-w-xs">
                  <span className="truncate">{r.label}</span>
                  <span className="truncate text-meta text-text-faint">{fmt.dateTime(r.created_at)}</span>
                  {/* Below sm the status column is hidden; keep the status visible here. */}
                  <span className="mt-1 sm:hidden">
                    <StateBadge state={r.status} />
                  </span>
                </span>
              )
            },
            {
              key: "status",
              header: t("performance.col.status"),
              cell: (r) => (
                <span title={r.error ?? undefined}>
                  <StateBadge state={r.status} />
                </span>
              ),
              hideBelow: "sm"
            },
            {
              key: "train",
              header: t("performance.col.trainUntil"),
              cell: (r) => <span className="whitespace-nowrap text-text-dim">{fmt.date(r.train_until)}</span>,
              hideBelow: "lg"
            },
            {
              key: "bets",
              header: t("performance.col.n"),
              cell: (r) =>
                r.total_bets === null ? (
                  fmt.int(null)
                ) : hasBets(r) ? (
                  <SampleSize n={r.total_bets} className="text-body" />
                ) : (
                  <span className="text-text-faint">{t("performance.backtests.noBets")}</span>
                ),
              align: "right",
              hideBelow: "sm"
            },
            {
              key: "roi",
              header: t("performance.col.roi"),
              cell: (r) => <Signed value={hasBets(r) ? r.roi : null} format="pct" />,
              align: "right"
            },
            {
              key: "hit",
              header: t("performance.col.hitRate"),
              cell: (r) => fmt.pct(hasBets(r) ? r.hit_rate : null),
              align: "right",
              hideBelow: "md"
            },
            {
              key: "brier",
              header: t("performance.col.brier"),
              cell: (r) => fmt.num(hasBets(r) ? r.brier : null, 3),
              align: "right",
              hideBelow: "lg"
            },
            {
              key: "sharpe",
              header: t("performance.col.sharpe"),
              cell: (r) => fmt.signed(hasBets(r) ? r.sharpe_adjusted : null, 2),
              align: "right",
              hideBelow: "xl"
            },
            {
              key: "mlflow",
              header: t("performance.col.links"),
              cell: (r) =>
                r.mlflow_ui_url ? (
                  <TextLink href={r.mlflow_ui_url} external>
                    {t("performance.registry.openMlflow")}
                  </TextLink>
                ) : (
                  fmt.num(null)
                ),
              align: "right",
              hideBelow: "md"
            }
          ]}
        />
      )}
    </Panel>
  );
}
