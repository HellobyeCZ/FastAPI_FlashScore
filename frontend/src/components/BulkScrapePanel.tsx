"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startBulkScrapeJob } from "@/lib/api-client";
import { useLocale } from "@/contexts/LocaleContext";
import { useBulkScrapeJobsData } from "@/hooks/useBulkScrapeJobsData";
import type { BulkScrapeJob } from "@/types/bulk-scrape";
import type { MessageKey } from "@/lib/i18n";

const PREVIEW_LIMIT = 5;

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

function progressLabel(
  total: number,
  pending: number,
  running: number,
  succeeded: number,
  failed: number,
  skipped: number
): string {
  if (total <= 0) {
    return "0/0";
  }
  const done = succeeded + failed + skipped;
  return `${done}/${total} (pending ${pending}, running ${running})`;
}

const STATUS_LABELS: Record<string, MessageKey> = {
  queued: "bulk.status.queued",
  running: "bulk.status.running",
  completed: "bulk.status.completed",
  completed_with_errors: "bulk.status.completed_with_errors",
  failed: "bulk.status.failed",
};

function resolveStatusLabel(status: string): MessageKey {
  return STATUS_LABELS[status] ?? "bulk.status.unknown";
}

interface BulkScrapeJobsTableProps {
  jobs: BulkScrapeJob[];
}

function BulkScrapeJobsTable({ jobs }: BulkScrapeJobsTableProps) {
  const { t } = useLocale();
  return (
    <div className="overflow-x-auto rounded-2xl border border-[color:var(--color-brand-outline)]">
      <table className="w-full min-w-[780px] border-collapse text-left text-sm">
        <thead className="bg-[color:var(--color-brand-surface)] text-[color:var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2 font-medium">{t("bulk.table.id")}</th>
            <th className="px-3 py-2 font-medium">{t("bulk.table.competition")}</th>
            <th className="px-3 py-2 font-medium">{t("bulk.table.status")}</th>
            <th className="px-3 py-2 font-medium">{t("bulk.table.progress")}</th>
            <th className="px-3 py-2 font-medium">{t("bulk.table.updated")}</th>
            <th className="px-3 py-2 font-medium">{t("bulk.table.error")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-t border-[color:var(--color-brand-outline)]">
              <td className="px-3 py-2 text-[color:var(--color-text-high)]">#{job.id}</td>
              <td className="px-3 py-2 text-[color:var(--color-text-high)]">{job.competitionPath}</td>
              <td className="px-3 py-2 text-[color:var(--color-text-high)]">
                {t(resolveStatusLabel(job.status))}
              </td>
              <td className="px-3 py-2 text-[color:var(--color-text-high)]">
                {progressLabel(
                  job.totalEvents,
                  job.pendingEvents,
                  job.runningEvents,
                  job.succeededEvents,
                  job.failedEvents,
                  job.skippedEvents
                )}
              </td>
              <td className="px-3 py-2 text-[color:var(--color-text-muted)]">{formatDateTime(job.updatedAt)}</td>
              <td className="px-3 py-2 text-[color:var(--color-danger)]">{job.lastError ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BulkScrapePanel() {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [competitionPath, setCompetitionPath] = useState("football/czech-republic/chance-liga");
  const [seasons, setSeasons] = useState("5");
  const [maxConcurrency, setMaxConcurrency] = useState("4");
  const [includeStats, setIncludeStats] = useState(true);
  const [includeOdds, setIncludeOdds] = useState(true);
  const [showAllJobs, setShowAllJobs] = useState(false);

  const jobsQuery = useBulkScrapeJobsData({ enabled: true, limit: 100 });
  const { data: jobs, isLoading, error } = jobsQuery;
  const previewJobs = useMemo(() => jobs?.slice(0, PREVIEW_LIMIT), [jobs]);
  const hasMore = (jobs?.length ?? 0) > PREVIEW_LIMIT;

  // Lock body scroll while the modal is open and close on Escape.
  useEffect(() => {
    if (!showAllJobs) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAllJobs(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [showAllJobs]);

  const createJobMutation = useMutation({
    mutationFn: () =>
      startBulkScrapeJob({
        competitionPath: competitionPath.trim(),
        seasons: Number.parseInt(seasons, 10) || 5,
        includeStats,
        includeOdds,
        maxConcurrency: Number.parseInt(maxConcurrency, 10) || 4
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bulk-scrape-jobs"] });
    }
  });

  const submitDisabled = useMemo(() => {
    return (
      createJobMutation.isPending ||
      competitionPath.trim().length === 0 ||
      (!includeStats && !includeOdds)
    );
  }, [competitionPath, createJobMutation.isPending, includeStats, includeOdds]);

  return (
    <section className="space-y-4 rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-5 shadow-sm">
      <header className="space-y-1">
        <h3 className="text-xl font-bold text-[color:var(--color-text-high)]">{t("bulk.title")}</h3>
        <p className="text-sm text-[color:var(--color-text-muted)]">{t("bulk.description")}</p>
      </header>

      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          createJobMutation.mutate();
        }}
      >
        <label className="space-y-1 md:col-span-2">
          <span className="text-sm font-medium text-[color:var(--color-text-high)]">{t("bulk.pathLabel")}</span>
          <input
            type="text"
            value={competitionPath}
            onChange={(event) => setCompetitionPath(event.target.value)}
            placeholder={t("bulk.pathPlaceholder")}
            className="w-full rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2 text-sm text-[color:var(--color-text-high)] outline-none transition focus:border-[color:var(--color-brand-primary)] focus:ring-2 focus:ring-[color:var(--color-brand-primary)]/20"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-[color:var(--color-text-high)]">{t("bulk.seasonsLabel")}</span>
          <input
            type="number"
            min={1}
            max={50}
            value={seasons}
            onChange={(event) => setSeasons(event.target.value)}
            className="w-full rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2 text-sm text-[color:var(--color-text-high)] outline-none transition focus:border-[color:var(--color-brand-primary)] focus:ring-2 focus:ring-[color:var(--color-brand-primary)]/20"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-[color:var(--color-text-high)]">{t("bulk.concurrencyLabel")}</span>
          <input
            type="number"
            min={1}
            max={32}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(event.target.value)}
            className="w-full rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-2 text-sm text-[color:var(--color-text-high)] outline-none transition focus:border-[color:var(--color-brand-primary)] focus:ring-2 focus:ring-[color:var(--color-brand-primary)]/20"
          />
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-[color:var(--color-text-high)]">
          <input
            type="checkbox"
            checked={includeStats}
            onChange={(event) => setIncludeStats(event.target.checked)}
            className="h-4 w-4 rounded border-[color:var(--color-brand-outline)]"
          />
          <span>{t("bulk.includeStats")}</span>
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-[color:var(--color-text-high)]">
          <input
            type="checkbox"
            checked={includeOdds}
            onChange={(event) => setIncludeOdds(event.target.checked)}
            className="h-4 w-4 rounded border-[color:var(--color-brand-outline)]"
          />
          <span>{t("bulk.includeOdds")}</span>
        </label>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={submitDisabled}
            className="rounded-xl bg-[color:var(--color-brand-primary)] px-4 py-2 text-sm font-semibold text-[color:var(--color-text-inverse)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createJobMutation.isPending ? t("bulk.submitting") : t("bulk.submit")}
          </button>
        </div>
      </form>

      {createJobMutation.error && (
        <p className="text-sm text-[color:var(--color-danger)]">
          {t("bulk.errorStart")}: {createJobMutation.error.message}
        </p>
      )}

      <div className="space-y-2">
        <h4 className="text-base font-semibold text-[color:var(--color-text-high)]">{t("bulk.jobsTitle")}</h4>

        {isLoading && (
          <p className="text-sm text-[color:var(--color-text-muted)]">{t("saved.loading")}</p>
        )}

        {error && (
          <p className="text-sm text-[color:var(--color-danger)]">
            {t("bulk.errorLoad")}: {error.message}
          </p>
        )}

        {jobs && jobs.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-muted)]">{t("bulk.empty")}</p>
        )}

        {previewJobs && previewJobs.length > 0 && (
          <>
            <BulkScrapeJobsTable jobs={previewJobs} />
            {hasMore && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowAllJobs(true)}
                  className="rounded-xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-text-high)] transition hover:opacity-90"
                >
                  {t("bulk.showAll")} ({jobs?.length})
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showAllJobs && jobs && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("bulk.modalTitle")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowAllJobs(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-[color:var(--color-brand-outline)] px-5 py-4">
              <h4 className="text-base font-semibold text-[color:var(--color-text-high)]">
                {t("bulk.modalTitle")} ({jobs.length})
              </h4>
              <button
                type="button"
                onClick={() => setShowAllJobs(false)}
                className="rounded-lg px-3 py-1 text-sm text-[color:var(--color-text-muted)] transition hover:bg-[color:var(--color-brand-surface)] hover:text-[color:var(--color-text-high)]"
              >
                {t("bulk.modalClose")}
              </button>
            </header>
            <div className="flex-1 overflow-auto p-4">
              <BulkScrapeJobsTable jobs={jobs} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
