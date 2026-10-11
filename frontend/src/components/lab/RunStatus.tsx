"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { StateBadge } from "@/components/ui";
import { parseDate } from "@/lib/format";
import { isActiveRun, type BacktestRunSummary } from "@/lib/lab/backtests";
import { formatDuration } from "@/lib/lab/format";
import { useNow } from "@/lib/lab/hooks";
import type { MessageKey } from "@/lib/i18n";

const STAGES = ["training", "backtesting", "logging"];

/** Status badge + current stage + live elapsed time while queued/running. */
export function RunStatus({ run }: { run: Pick<BacktestRunSummary, "status" | "stage" | "created_at" | "started_at"> }) {
  const { t, locale } = useLocale();
  const active = isActiveRun(run);
  const now = useNow(1000, active);
  const since = parseDate(run.status === "running" ? (run.started_at ?? run.created_at) : run.created_at);
  const stage = run.stage
    ? STAGES.includes(run.stage)
      ? t(`lab.stage.${run.stage}` as MessageKey)
      : run.stage.replace(/_/g, " ")
    : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StateBadge state={run.status} />
      {active && stage && <span className="text-meta text-text-dim">{stage}</span>}
      {active && since && (
        <span
          className="text-meta tabular-nums text-text-faint"
          title={t(run.status === "running" ? "lab.status.runningFor" : "lab.status.queuedFor")}
        >
          {formatDuration(now - since.getTime(), locale)}
        </span>
      )}
    </span>
  );
}
