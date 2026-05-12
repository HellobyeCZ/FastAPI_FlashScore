"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/terminal/PageHeader";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken, type StatusKind } from "@/components/terminal/StatusToken";
import { AsciiProgress } from "@/components/terminal/AsciiProgress";
import { Glyph } from "@/components/terminal/Glyph";
import { useBulkScrapeJobsData } from "@/hooks/useBulkScrapeJobsData";
import { startBulkScrapeJob } from "@/lib/api-client";
import type { BulkScrapeJob } from "@/types/bulk-scrape";

const STATUS_MAP: Record<string, StatusKind> = {
  queued: "PEND",
  running: "RUN",
  completed: "OK",
  completed_with_errors: "OK",
  failed: "ERR"
};

function jobProgress(j: BulkScrapeJob): number {
  if (j.totalEvents <= 0) return 0;
  const done = j.succeededEvents + j.failedEvents + j.skippedEvents;
  return done / j.totalEvents;
}

function formatTs(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function JobsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useBulkScrapeJobsData({ enabled: true });
  const jobs: BulkScrapeJob[] = data ?? [];

  const [path, setPath] = useState("football/czech-republic/chance-liga");
  const [seasons, setSeasons] = useState(5);
  const [concurrency, setConcurrency] = useState(4);
  const [includeStats, setIncludeStats] = useState(true);
  const [includeOdds, setIncludeOdds] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createJob = useMutation({
    mutationFn: () =>
      startBulkScrapeJob({
        competitionPath: path.trim(),
        seasons,
        maxConcurrency: concurrency,
        includeStats,
        includeOdds
      }),
    onSuccess: () => {
      setSubmitError(null);
      qc.invalidateQueries({ queryKey: ["bulk-scrape-jobs"] });
    },
    onError: (err: Error) => setSubmitError(err.message)
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim() || (!includeStats && !includeOdds)) return;
    createJob.mutate();
  }

  function kill(id: number) {
    // TODO: backend does not yet expose a cancel endpoint for bulk-scrape jobs.
    // BulkScrapePanel.tsx (the existing UI) has no cancel either.
    console.warn(`cancel not yet supported (job #${id})`);
  }

  const columns: Column<BulkScrapeJob>[] = [
    {
      key: "id",
      header: "Job",
      render: (j) => <span className="text-text-dim">#{j.id}</span>
    },
    {
      key: "path",
      header: "Competition",
      render: (j) => <span className="text-text">{j.competitionPath}</span>
    },
    {
      key: "status",
      header: "Status",
      render: (j) => <StatusToken kind={STATUS_MAP[j.status] ?? "PEND"} />
    },
    {
      key: "progress",
      header: "Progress",
      render: (j) =>
        j.totalEvents > 0 ? (
          <span className="inline-flex items-center gap-2">
            <AsciiProgress value={jobProgress(j)} />
            <span className="text-text-faint">
              {j.succeededEvents + j.failedEvents + j.skippedEvents}/{j.totalEvents}
            </span>
          </span>
        ) : (
          <span className="text-text-faint">—</span>
        )
    },
    {
      key: "updated",
      header: "Updated",
      render: (j) => <span className="text-text-faint">{formatTs(j.updatedAt)}</span>
    },
    {
      key: "error",
      header: "Error",
      render: (j) =>
        j.lastError ? <span className="text-neg">{j.lastError}</span> : <span className="text-text-faint">—</span>
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (j) =>
        ["queued", "running"].includes(j.status) ? (
          <button
            onClick={() => kill(j.id)}
            className="border border-neg/60 px-2 py-0 font-mono text-[11px] text-neg hover:bg-surface"
          >
            [KILL]
          </button>
        ) : null
    }
  ];

  const submitDisabled =
    createJob.isPending || path.trim().length === 0 || (!includeStats && !includeOdds);

  return (
    <>
      <PageHeader kicker="Jobs · bulk scrape" />
      <form
        onSubmit={submit}
        className="mb-6 flex flex-wrap items-center gap-3 border border-border p-3 font-mono text-[12px]"
      >
        <Glyph kind="item" className="text-text-faint" />
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="football/czech-republic/chance-liga"
          className="min-w-[260px] flex-1 border border-border bg-bg px-2 py-1 text-[12px]"
          required
        />
        <label className="flex items-center gap-1 text-text-dim">
          seasons
          <input
            type="number"
            min={1}
            max={50}
            value={seasons}
            onChange={(e) => setSeasons(+e.target.value || 1)}
            className="w-14 border border-border bg-bg px-2 py-1 text-[12px]"
          />
        </label>
        <label className="flex items-center gap-1 text-text-dim">
          conc
          <input
            type="number"
            min={1}
            max={32}
            value={concurrency}
            onChange={(e) => setConcurrency(+e.target.value || 1)}
            className="w-14 border border-border bg-bg px-2 py-1 text-[12px]"
          />
        </label>
        <label className="flex items-center gap-1 text-text-dim">
          <input
            type="checkbox"
            checked={includeStats}
            onChange={(e) => setIncludeStats(e.target.checked)}
          />
          stats
        </label>
        <label className="flex items-center gap-1 text-text-dim">
          <input
            type="checkbox"
            checked={includeOdds}
            onChange={(e) => setIncludeOdds(e.target.checked)}
          />
          odds
        </label>
        <button
          type="submit"
          disabled={submitDisabled}
          className="border border-accent px-3 py-1 text-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createJob.isPending ? "starting…" : "▸ start"}
        </button>
      </form>
      {submitError && (
        <p className="mb-4 font-mono text-[12px] text-neg">▸ {submitError}</p>
      )}
      <DataTable
        columns={columns}
        rows={jobs}
        empty={isLoading ? "▸ loading…" : "▸ no jobs"}
      />
    </>
  );
}
