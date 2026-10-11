"use client";
import { useCallback, useMemo, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  PageHeader,
  Panel,
  SegmentedControl,
  Select,
  Signed,
  Table,
  type Column
} from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import { modelColor, modelLabel } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { isActiveRun, useBacktestRuns, type BacktestRunSummary } from "@/lib/lab/backtests";
import { MAX_COMPARE, betMetric, isAutoLabel, runTitle, runWindow, shortId } from "@/lib/lab/format";
import { idList, useSearchState } from "@/lib/lab/hooks";
import { formatSort, parseSort, sortRows } from "@/lib/lab/sort";
import { LabTabs } from "./LabTabs";
import { NewBacktestDialog } from "./NewBacktestDialog";
import { RunActions } from "./RunActions";
import { RunMlflowLink } from "./RunMlflowLink";
import { RunStatus } from "./RunStatus";

type StatusFilter = "all" | "completed" | "active" | "failed";
const STATUS_FILTERS: StatusFilter[] = ["all", "completed", "active", "failed"];

function matchesStatus(run: BacktestRunSummary, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "active") return isActiveRun(run);
  if (f === "failed") return run.status === "failed" || run.status === "cancelled";
  return run.status === "completed";
}

export function BacktestsPage() {
  const { t, tp, fmt, locale } = useLocale();
  const runs = useBacktestRuns();
  const build = useCallback((q: Record<string, string>) => routes.backtests(locale, q), [locale]);
  const { params, set } = useSearchState(build);
  const [creating, setCreating] = useState(false);

  const rawStatus = params.get("status") as StatusFilter | null;
  const status: StatusFilter = rawStatus && STATUS_FILTERS.includes(rawStatus) ? rawStatus : "all";
  const model = params.get("model") ?? "";
  const selected = idList(params.get("selected"), MAX_COMPARE);
  const sort = parseSort(params.get("sort"));

  const all = useMemo(() => runs.data ?? [], [runs.data]);
  const models = useMemo(() => Array.from(new Set(all.map((r) => r.model))).sort(), [all]);
  const counts = useMemo(
    () => Object.fromEntries(STATUS_FILTERS.map((f) => [f, all.filter((r) => matchesStatus(r, f)).length])) as Record<
      StatusFilter,
      number
    >,
    [all]
  );
  const visible = all.filter((r) => matchesStatus(r, status) && (!model || r.model === model));
  const activeCount = counts.active;
  const selectable = (r: BacktestRunSummary) => r.status === "completed";

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    set({ selected: next.slice(0, MAX_COMPARE).join(",") || null });
  }

  const columns: Column<BacktestRunSummary>[] = [
    {
      key: "select",
      header: <span className="sr-only">{t("lab.runs.select")}</span>,
      width: "2.5rem",
      cell: (r) => {
        const checked = selected.includes(r.id);
        const full = !checked && selected.length >= MAX_COMPARE;
        const disabled = !selectable(r) || full;
        return (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled && !checked}
            onChange={() => toggle(r.id)}
            aria-label={t("lab.runs.selectNamed", { title: runTitle(r, locale, t) })}
            title={!selectable(r) ? t("lab.runs.selectOnlyCompleted") : full ? t("lab.runs.selectMax", { max: MAX_COMPARE }) : undefined}
            className="h-4 w-4 cursor-pointer align-middle accent-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-40"
          />
        );
      }
    },
    {
      key: "run",
      header: t("lab.runs.col.run"),
      headerTitle: t("lab.runs.col.run.title"),
      sortValue: (r) => r.created_at,
      cell: (r) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-2 text-text">
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: modelColor(r.model) }} />
            <span>{runTitle(r, locale, t)}</span>
          </span>
          <span className="pl-[1.125rem] text-meta text-text-faint">
            {isAutoLabel(r) ? "" : `${modelLabel(r.model, t)} · ${runWindow(r, locale, t)} · `}#{shortId(r.id)} ·{" "}
            {fmt.relative(r.created_at)}
          </span>
          {r.status === "failed" && r.error && (
            <span className="line-clamp-2 break-words pl-[1.125rem] text-meta text-neg" title={r.error}>
              {r.error}
            </span>
          )}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[1.125rem] sm:hidden">
            <RunStatus run={r} />
            {r.status === "completed" && r.total_bets !== null && (
              <span className="text-meta text-text-faint">
                {tp("lab.bets", r.total_bets, { n: fmt.int(r.total_bets) })}
              </span>
            )}
          </span>
        </span>
      )
    },
    {
      key: "status",
      header: t("common.status"),
      hideBelow: "sm",
      firstDir: "asc",
      sortValue: (r) => r.status,
      cell: (r) => <RunStatus run={r} />
    },
    {
      key: "bets",
      header: t("common.bets"),
      align: "right",
      hideBelow: "md",
      sortValue: (r) => r.total_bets,
      cell: (r) =>
        r.total_bets === 0 ? (
          <span className="whitespace-nowrap text-text-faint" title={t("lab.runs.noBets.title")}>
            {tp("lab.bets", 0, { n: fmt.int(0) })}
          </span>
        ) : (
          fmt.int(r.total_bets)
        )
    },
    {
      key: "roi",
      header: t("common.roi"),
      align: "right",
      sortValue: (r) => betMetric(r, r.roi),
      cell: (r) => <Signed value={betMetric(r, r.roi)} format="pct" />
    },
    {
      key: "hit",
      header: t("common.hitRate"),
      align: "right",
      hideBelow: "md",
      sortValue: (r) => betMetric(r, r.hit_rate),
      cell: (r) => fmt.pct(betMetric(r, r.hit_rate))
    },
    {
      key: "brier",
      header: t("common.brier"),
      headerTitle: t("lab.metric.brier.title"),
      align: "right",
      hideBelow: "lg",
      firstDir: "asc",
      sortValue: (r) => betMetric(r, r.brier),
      cell: (r) => fmt.num(betMetric(r, r.brier), 3)
    },
    {
      key: "sharpe",
      header: t("common.sharpeAdj"),
      headerTitle: t("lab.metric.sharpe.title"),
      align: "right",
      hideBelow: "xl",
      sortValue: (r) => betMetric(r, r.sharpe_adjusted),
      cell: (r) => <Signed value={betMetric(r, r.sharpe_adjusted)} digits={3} />
    },
    {
      key: "mlflow",
      header: t("common.mlflow"),
      hideBelow: "lg",
      cell: (r) => <RunMlflowLink run={r} />
    },
    {
      key: "actions",
      header: <span className="sr-only">{t("common.actions")}</span>,
      align: "right",
      hideBelow: "sm",
      cell: (r) => <RunActions run={r} />
    }
  ];

  const rows = sortRows(visible, columns, sort);
  const filtered = status !== "all" || Boolean(model);

  return (
    <>
      <PageHeader
        crumbs={[{ label: t("nav.lab") }]}
        title={t("nav.lab.backtests")}
        description={t("lab.runs.description")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("lab.new.open")}
          </Button>
        }
        meta={
          runs.data &&
          (activeCount > 0
            ? t("lab.runs.metaActive", { runs: tp("lab.runs", all.length, { n: fmt.int(all.length) }), active: fmt.int(activeCount) })
            : tp("lab.runs", all.length, { n: fmt.int(all.length) }))
        }
      />
      <LabTabs active="backtests" />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            label={t("lab.runs.filter.status")}
            size="sm"
            value={status}
            onChange={(v) => set({ status: v === "all" ? null : v })}
            options={STATUS_FILTERS.map((f) => ({
              value: f,
              label: t(`lab.runs.filter.${f}`),
              hint: runs.data ? fmt.int(counts[f]) : undefined
            }))}
          />
          <Select
            aria-label={t("lab.runs.filter.model")}
            value={model}
            onChange={(e) => set({ model: e.target.value || null })}
            className="min-w-[10rem]"
          >
            <option value="">{t("lab.runs.filter.allModels")}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m, t)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-meta text-text-faint">{t("lab.runs.compareHint", { max: MAX_COMPARE })}</span>
          {selected.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => set({ selected: null })}>
              {t("lab.runs.clearSelection")}
            </Button>
          )}
          {selected.length >= 2 ? (
            <ButtonLink size="sm" variant="secondary" href={routes.compare(locale, selected)}>
              {t("lab.runs.compare", { n: selected.length })}
            </ButtonLink>
          ) : (
            <Button size="sm" disabled title={t("lab.runs.compareNeedsTwo")}>
              {t("lab.runs.compare", { n: selected.length })}
            </Button>
          )}
        </div>
      </div>

      <Panel padding="none">
        {runs.isError ? (
          <div className="p-4">
            <Callout
              tone="neg"
              title={t("lab.runs.error")}
              action={
                <Button size="sm" onClick={() => runs.refetch()} loading={runs.isFetching}>
                  {t("common.retry")}
                </Button>
              }
            >
              {errorMessage(runs.error)}
            </Callout>
          </div>
        ) : runs.data && all.length === 0 ? (
          <EmptyState
            title={t("lab.runs.empty.title")}
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("lab.new.open")}
              </Button>
            }
          >
            {t("lab.runs.empty.body")}
          </EmptyState>
        ) : (
          <Table
            caption={t("lab.runs.caption")}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => routes.backtest(locale, r.id)}
            linkColumn="run"
            loading={runs.isLoading}
            sort={sort}
            onSortChange={(s) => set({ sort: formatSort(s) })}
            rowClassName={(r) => (selected.includes(r.id) ? "bg-surface-2" : undefined)}
            empty={
              filtered && (
                <EmptyState
                  compact
                  title={t("lab.runs.filteredEmpty.title")}
                  action={
                    <Button size="sm" onClick={() => set({ status: null, model: null })}>
                      {t("lab.runs.filteredEmpty.clear")}
                    </Button>
                  }
                >
                  {t("lab.runs.filteredEmpty.body", {
                    status: t(`lab.runs.filter.${status}`),
                    model: model ? modelLabel(model, t) : t("lab.runs.filter.allModels")
                  })}
                </EmptyState>
              )
            }
          />
        )}
      </Panel>
      {activeCount > 0 && <p className="mt-2 text-meta text-text-faint">{t("lab.runs.polling")}</p>}

      {creating && <NewBacktestDialog open onClose={() => setCreating(false)} />}
    </>
  );
}
