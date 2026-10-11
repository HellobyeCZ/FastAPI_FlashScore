"use client";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  Panel,
  QueryState,
  Spinner,
  StateBadge,
  Table,
  type Column
} from "@/components/ui";
import type { Tone } from "@/lib/labels";
import type { MessageKey } from "@/lib/i18n";
import {
  REFRESH_PARAMS,
  REFRESH_STAGES,
  isRunActive,
  stageState,
  useRefreshNow,
  type RefreshRun,
  type RefreshStage,
  type StageState
} from "./refresh";

/** Stage results worth showing, in display order (other keys are internal). */
const STAGE_METRICS: Record<RefreshStage, string[]> = {
  scrape: ["competitions_processed", "fixtures_discovered_or_updated", "events_snapshotted", "live_rows_written"],
  phase1: ["labels_upserted", "closing_upserted", "closing_from_live_upserted", "elo_upserted"],
  settle: ["pending_at_start", "settled", "voided", "skipped_no_label"],
  predict: ["upcoming_events", "candidate_picks", "newly_inserted", "duplicates_skipped"]
};

const STATE_TONE: Record<StageState, Tone> = {
  pending: "neutral",
  running: "warn",
  done: "pos",
  failed: "neg",
  skipped: "neutral"
};

function useDuration() {
  const { t } = useLocale();
  return (seconds: number) => {
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? t("ops.duration.ms", { m, s }) : t("ops.duration.s", { s });
  };
}

/** Result column of the recent-runs table: the run's terminal or live status. */
function runState(run: RefreshRun): "completed" | "failed" | "running" {
  if (run.status === "done") return "completed";
  if (run.status === "error") return "failed";
  return "running";
}

function StageList({ run }: { run: RefreshRun | undefined }) {
  const { t, fmt } = useLocale();
  const params = {
    days: REFRESH_PARAMS.window_days,
    hours: REFRESH_PARAMS.hours_ahead,
    edge: fmt.pct(REFRESH_PARAMS.min_edge, 0)
  };
  return (
    <ol aria-label={t("ops.refresh.steps")} className="flex flex-col">
      {REFRESH_STAGES.map((stage, i) => {
        const state = run ? stageState(run, stage) : null;
        const block = run?.stage_progress[stage];
        const metrics =
          state === "done" && block
            ? STAGE_METRICS[stage].filter((k) => typeof block[k] === "number")
            : [];
        const eloError = stage === "phase1" && typeof block?.elo_error === "string" ? block.elo_error : null;
        return (
          <li
            key={stage}
            data-stage={stage}
            data-state={state ?? "idle"}
            className="flex gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <span
              aria-hidden
              className={clsx(
                "flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-meta",
                state === "done" && "border-pos text-pos",
                state === "running" && "border-warn text-warn",
                state === "failed" && "border-neg text-neg",
                (!state || state === "pending" || state === "skipped") && "border-border-strong text-text-dim"
              )}
            >
              {state === "running" ? <Spinner /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="font-sans text-body text-text">{t(`ops.refresh.step.${stage}` as MessageKey)}</span>
                {state && <Badge tone={STATE_TONE[state]}>{t(`ops.refresh.state.${state}` as MessageKey)}</Badge>}
              </div>
              <p className="mt-0.5 text-meta text-text-dim">
                {t(`ops.refresh.step.${stage}.desc` as MessageKey, params)}
              </p>
              {metrics.length > 0 && (
                <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-meta">
                  {metrics.map((k) => (
                    <div key={k} className="flex gap-1.5">
                      <dt className="text-text-dim">{t(`ops.refresh.metric.${k}` as MessageKey)}</dt>
                      <dd className="font-mono tabular-nums text-text">{fmt.int(block![k] as number)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {eloError && (
                <p className="mt-1 text-meta text-warn">{t("ops.refresh.eloError", { message: eloError })}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Refresh-all: one confirmed action that runs the whole live pipeline, with
 * per-stage progress while it runs and the last few runs for context.
 */
export function RefreshPanel() {
  const { t, fmt } = useLocale();
  const duration = useDuration();
  const { list, run, start, active } = useRefreshNow();
  const [confirming, setConfirming] = useState(false);
  const recentId = useId();
  const current = run.data;
  const failedStage = current?.status === "error" ? REFRESH_STAGES.find((s) => stageState(current, s) === "failed") : undefined;

  const columns: Column<RefreshRun>[] = [
    {
      key: "started",
      header: t("ops.refresh.col.started"),
      cell: (r) => (
        <time dateTime={r.started_at} title={fmt.dateTime(r.started_at)}>
          {fmt.relative(r.started_at)}
        </time>
      ),
      sortValue: (r) => r.started_at
    },
    {
      key: "result",
      header: t("ops.refresh.col.result"),
      cell: (r) => <StateBadge state={runState(r)} />
    },
    {
      key: "duration",
      header: t("ops.refresh.col.duration"),
      align: "right",
      cell: (r) => duration(r.duration_seconds)
    }
  ];

  return (
    <Panel
      title={t("ops.refresh.title")}
      description={t("ops.refresh.description")}
      actions={
        <Button variant="primary" onClick={() => setConfirming(true)} disabled={active} loading={active}>
          {active ? t("ops.refresh.running") : t("ops.refresh.run")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {current && (
          <p className="text-meta text-text-dim" aria-live="polite">
            {isRunActive(current.status)
              ? t("ops.refresh.current", {
                  age: fmt.relative(current.started_at),
                  duration: duration(current.duration_seconds)
                })
              : t("ops.refresh.last", {
                  age: fmt.relative(current.finished_at ?? current.started_at),
                  duration: duration(current.duration_seconds)
                })}
          </p>
        )}

        <StageList run={current} />

        {run.isError && (
          <Callout
            tone="neg"
            title={t("ops.refresh.listError")}
            action={
              <Button size="sm" onClick={() => run.refetch()} loading={run.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(run.error)}
          </Callout>
        )}

        {current?.status === "error" && (
          <Callout
            tone="neg"
            title={t("ops.refresh.failedTitle", {
              stage: failedStage ? t(`ops.refresh.step.${failedStage}` as MessageKey) : "—"
            })}
          >
            <code className="break-all">{current.error}</code>
          </Callout>
        )}

        <section aria-labelledby={recentId} className="flex flex-col gap-2">
          <h3 id={recentId} className="font-sans text-label uppercase tracking-label text-text-dim">
            {t("ops.refresh.recent")}
          </h3>
          <QueryState
            query={list}
            errorTitle={t("ops.refresh.listError")}
            isEmpty={(d) => d.runs.length === 0}
            empty={
              <EmptyState compact title={t("ops.refresh.recent.empty")}>
                {t("ops.refresh.recent.emptyHint")}
              </EmptyState>
            }
          >
            {(d) => (
              <Table
                caption={t("ops.refresh.recent.caption")}
                columns={columns}
                rows={d.runs.slice(0, 5)}
                rowKey={(r) => r.run_id}
              />
            )}
          </QueryState>
        </section>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          start.reset();
        }}
        onConfirm={() =>
          start.mutate(undefined, {
            onSuccess: () => setConfirming(false)
          })
        }
        title={t("ops.refresh.confirm.title")}
        confirmLabel={t("ops.refresh.run")}
        busy={start.isPending}
        error={start.isError ? t("ops.refresh.startFailed", { message: errorMessage(start.error) }) : undefined}
      >
        <p className="text-warn">
          {t("ops.refresh.confirm.upstream", {
            days: REFRESH_PARAMS.window_days,
            concurrency: REFRESH_PARAMS.max_concurrency
          })}
        </p>
        <p>
          {t("ops.refresh.confirm.then", {
            hours: REFRESH_PARAMS.hours_ahead,
            edge: fmt.pct(REFRESH_PARAMS.min_edge, 0)
          })}
        </p>
        <p>{t("ops.refresh.confirm.single")}</p>
      </ConfirmDialog>
    </Panel>
  );
}
