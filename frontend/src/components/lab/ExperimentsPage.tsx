"use client";
import { useCallback, useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  ModelName,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  Signed,
  StateBadge,
  Table,
  TextLink,
  type Column
} from "@/components/ui";
import { useMlflowRuns } from "@/hooks/useMlflow";
import { errorMessage } from "@/lib/api/http";
import { KNOWN_MODELS, modelLabel, type Tone } from "@/lib/labels";
import { routes } from "@/lib/routes";
import type { MessageKey } from "@/lib/i18n";
import type { MlflowRun } from "@/types/mlflow";
import { utcDate } from "@/lib/lab/format";
import { useSearchState } from "@/lib/lab/hooks";
import { formatSort, parseSort, sortRows } from "@/lib/lab/sort";
import { LabTabs } from "./LabTabs";
import { MlflowStatusCallout } from "./MlflowStatusCallout";

const PURPOSES = ["walk_forward_backtest", "offline_training", "scheduled_retrain", "backfill"] as const;
type Purpose = (typeof PURPOSES)[number];
type PurposeFilter = Purpose | "all";

const PURPOSE_TONE: Record<Purpose, Tone> = {
  walk_forward_backtest: "accent",
  offline_training: "info",
  scheduled_retrain: "info",
  backfill: "neutral"
};

const isPurpose = (v: string | null | undefined): v is Purpose => (PURPOSES as readonly string[]).includes(v ?? "");
const isTraining = (p: string | null | undefined) => p === "offline_training" || p === "scheduled_retrain";

/** Training runs log calibrated/uncalibrated metrics; backtests log bet KPIs. */
const metric = (run: MlflowRun, key: string): number | null => {
  const v = run.metrics[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export function PurposeBadge({ purpose }: { purpose: string | null }) {
  const { t } = useLocale();
  if (!purpose) return <span className="text-text-faint">—</span>;
  return (
    <Badge tone={isPurpose(purpose) ? PURPOSE_TONE[purpose] : "neutral"}>
      {isPurpose(purpose) ? t(`lab.purpose.${purpose}` as MessageKey) : purpose.replace(/_/g, " ")}
    </Badge>
  );
}

/** MLflow runs of the "picks" experiment, filterable by purpose and model. */
export function ExperimentsPage() {
  const { t, fmt, locale } = useLocale();
  const build = useCallback((q: Record<string, string>) => routes.experiments(locale, q), [locale]);
  const { params, set } = useSearchState(build);
  const rawPurpose = params.get("purpose");
  const purpose: PurposeFilter = isPurpose(rawPurpose) ? rawPurpose : "all";
  const rawModel = params.get("model");
  const model = rawModel && (KNOWN_MODELS as readonly string[]).includes(rawModel) ? rawModel : "";
  const sort = parseSort(params.get("sort"));
  const runs = useMlflowRuns({ purpose: purpose === "all" ? null : purpose, model: model || null });
  const status = runs.data?.status;
  const down = Boolean(status && !(status.enabled && status.reachable));
  const training = isTraining(purpose);
  const filtered = purpose !== "all" || Boolean(model);

  const columns = useMemo<Column<MlflowRun>[]>(() => {
    const name: Column<MlflowRun> = {
      key: "run",
      header: t("lab.exp.col.run"),
      sortValue: (r) => r.start_time,
      cell: (r) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-text">{r.run_name ?? r.run_id.slice(0, 8)}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-meta text-text-faint">
            {fmt.relative(r.start_time)}
            {r.status !== "FINISHED" && <StateBadge state={mlflowState(r.status)} fallback={r.status.toLowerCase()} />}
            <span className="md:hidden">
              <PurposeBadge purpose={r.purpose} />
            </span>
            {r.registered_versions.length > 0 && (
              <span className="flex flex-wrap gap-1 lg:hidden">
                <VersionBadges versions={r.registered_versions} />
              </span>
            )}
          </span>
        </span>
      )
    };
    const common: Column<MlflowRun>[] = [
      {
        key: "purpose",
        header: t("lab.exp.col.purpose"),
        hideBelow: "md",
        firstDir: "asc",
        sortValue: (r) => r.purpose,
        cell: (r) => <PurposeBadge purpose={r.purpose} />
      },
      {
        key: "model",
        header: t("common.model"),
        hideBelow: "lg",
        firstDir: "asc",
        sortValue: (r) => (r.model_name ? modelLabel(r.model_name, t) : null),
        cell: (r) => (r.model_name ? <ModelName name={r.model_name} /> : <span className="text-text-faint">—</span>)
      },
      {
        key: "train",
        header: t("lab.new.trainUntil"),
        hideBelow: "xl",
        sortValue: (r) => r.train_until,
        cell: (r) => <span className="whitespace-nowrap text-text-dim">{utcDate(locale, r.train_until)}</span>
      }
    ];
    const metrics: Column<MlflowRun>[] = training
      ? [
          {
            key: "cal_brier",
            header: t("lab.exp.col.calBrier"),
            headerTitle: t("lab.exp.col.calBrier.title"),
            align: "right",
            firstDir: "asc",
            sortValue: (r) => metric(r, "cal_brier"),
            cell: (r) => fmt.num(metric(r, "cal_brier"), 4)
          },
          {
            key: "uncal_brier",
            header: t("lab.exp.col.uncalBrier"),
            align: "right",
            hideBelow: "sm",
            firstDir: "asc",
            sortValue: (r) => metric(r, "uncal_brier"),
            cell: (r) => fmt.num(metric(r, "uncal_brier"), 4)
          },
          {
            key: "cal_log_loss",
            header: t("lab.exp.col.calLogLoss"),
            align: "right",
            hideBelow: "md",
            firstDir: "asc",
            sortValue: (r) => metric(r, "cal_log_loss"),
            cell: (r) => fmt.num(metric(r, "cal_log_loss"), 4)
          },
          {
            key: "train_events",
            header: t("lab.detail.trainEvents"),
            align: "right",
            hideBelow: "lg",
            sortValue: (r) => Number(r.params.n_train_events) || null,
            cell: (r) => fmt.int(Number(r.params.n_train_events) || null)
          }
        ]
      : [
          {
            key: "roi",
            header: t("common.roi"),
            align: "right",
            sortValue: (r) => metric(r, "roi"),
            cell: (r) => <Signed value={metric(r, "roi")} format="pct" />
          },
          {
            key: "sharpe",
            header: t("common.sharpeAdj"),
            headerTitle: t("lab.metric.sharpe.title"),
            align: "right",
            hideBelow: "sm",
            sortValue: (r) => metric(r, "sharpe_adjusted"),
            cell: (r) => fmt.signed(metric(r, "sharpe_adjusted"), 3)
          },
          {
            key: "n_bets",
            header: t("common.bets"),
            align: "right",
            hideBelow: "md",
            sortValue: (r) => metric(r, "n_bets"),
            cell: (r) => fmt.int(metric(r, "n_bets"))
          },
          {
            key: "brier",
            header: t("common.brier"),
            headerTitle: t("lab.exp.col.brier.title"),
            align: "right",
            hideBelow: "lg",
            firstDir: "asc",
            sortValue: (r) => metric(r, "brier") ?? metric(r, "cal_brier"),
            cell: (r) => {
              const own = metric(r, "brier");
              const cal = metric(r, "cal_brier");
              if (own !== null || cal === null) return fmt.num(own, 4);
              return (
                <span title={t("lab.exp.col.calBrier.title")}>
                  {fmt.num(cal, 4)} <span className="text-meta text-text-faint">{t("lab.exp.cal")}</span>
                </span>
              );
            }
          }
        ];
    const tail: Column<MlflowRun>[] = [
      {
        key: "versions",
        header: t("lab.exp.col.versions"),
        hideBelow: "lg",
        cell: (r) =>
          r.registered_versions.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              <VersionBadges versions={r.registered_versions} />
            </span>
          ) : (
            <span className="text-text-faint">—</span>
          )
      },
      {
        key: "links",
        header: <span className="sr-only">{t("lab.exp.col.links")}</span>,
        align: "right",
        hideBelow: "sm",
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1 whitespace-nowrap">
            {r.backtest_run_id && (
              <TextLink href={routes.backtest(locale, r.backtest_run_id)}>{t("lab.exp.openBacktest")}</TextLink>
            )}
            {r.ui_url && (
              <TextLink href={r.ui_url} external>
                {t("common.mlflow")}
              </TextLink>
            )}
          </span>
        )
      }
    ];
    return [name, ...common, ...metrics, ...tail];
  }, [t, fmt, locale, training]);

  const rows = sortRows(runs.data?.runs ?? [], columns, sort);

  return (
    <>
      <PageHeader
        crumbs={[{ label: t("nav.lab"), href: routes.backtests(locale) }]}
        title={t("nav.lab.experiments")}
        description={t("lab.exp.description")}
        meta={
          status?.reachable
            ? t("lab.exp.meta", { name: status.experiment_name, id: runs.data?.experiment_id ?? "—" })
            : undefined
        }
        actions={
          runs.data?.experiment_ui_url ? (
            <ButtonLink href={runs.data.experiment_ui_url} external size="sm">
              {t("common.openInMlflow")}
            </ButtonLink>
          ) : undefined
        }
      />
      <LabTabs active="experiments" />

      <div className="flex flex-col gap-4">
        {down && <MlflowStatusCallout status={status} onRetry={() => runs.refetch()} retrying={runs.isFetching} />}

        <div className="flex flex-wrap items-end gap-3">
          <div className="max-w-full overflow-x-auto">
            <SegmentedControl
              label={t("lab.exp.filter.purpose")}
              size="sm"
              value={purpose}
              onChange={(v) => set({ purpose: v === "all" ? null : v, sort: null })}
              options={[
                { value: "all" as PurposeFilter, label: t("lab.runs.filter.all") },
                ...PURPOSES.map((p) => ({ value: p as PurposeFilter, label: t(`lab.purpose.${p}` as MessageKey) }))
              ]}
            />
          </div>
          <Select
            aria-label={t("lab.runs.filter.model")}
            value={model}
            onChange={(e) => set({ model: e.target.value || null })}
            className="min-w-[10rem]"
          >
            <option value="">{t("lab.runs.filter.allModels")}</option>
            {KNOWN_MODELS.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m, t)}
              </option>
            ))}
          </Select>
        </div>

        <Panel padding="none">
          {runs.isError ? (
            <div className="p-4">
              <Callout
                tone="neg"
                title={t("lab.exp.error")}
                action={
                  <Button size="sm" onClick={() => runs.refetch()} loading={runs.isFetching}>
                    {t("common.retry")}
                  </Button>
                }
              >
                {errorMessage(runs.error)}
              </Callout>
            </div>
          ) : (
            <Table
              caption={t("lab.exp.caption")}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.run_id}
              rowHref={(r) => (r.backtest_run_id ? routes.backtest(locale, r.backtest_run_id) : null)}
              linkColumn="run"
              loading={runs.isLoading}
              sort={sort}
              onSortChange={(s) => set({ sort: formatSort(s) })}
              empty={
                down ? (
                  <EmptyState compact title={t("lab.exp.empty.down")} />
                ) : filtered ? (
                  <EmptyState
                    compact
                    title={t("lab.exp.empty.filtered")}
                    action={
                      <Button size="sm" onClick={() => set({ purpose: null, model: null })}>
                        {t("lab.exp.empty.clear")}
                      </Button>
                    }
                  >
                    {t("lab.exp.empty.filteredBody", {
                      purpose: purpose === "all" ? t("lab.runs.filter.all") : t(`lab.purpose.${purpose}` as MessageKey),
                      model: model ? modelLabel(model, t) : t("lab.runs.filter.allModels")
                    })}
                  </EmptyState>
                ) : (
                  <EmptyState
                    compact
                    title={t("lab.exp.empty.title")}
                    action={
                      <ButtonLink href={routes.backtests(locale)} variant="primary" size="sm">
                        {t("lab.exp.empty.action")}
                      </ButtonLink>
                    }
                  >
                    {t("lab.exp.empty.body")}
                  </EmptyState>
                )
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}

function VersionBadges({ versions }: { versions: MlflowRun["registered_versions"] }) {
  return (
    <>
      {versions.map((v) => (
        <Badge key={`${v.name}-${v.version}`} tone="accent" title={v.name}>
          v{v.version}
        </Badge>
      ))}
    </>
  );
}

/** MLflow run status (RUNNING/FINISHED/FAILED/KILLED) → app state vocabulary. */
function mlflowState(status: string): string {
  const s = status.toUpperCase();
  return s === "KILLED" ? "cancelled" : s === "SCHEDULED" ? "queued" : s.toLowerCase();
}
