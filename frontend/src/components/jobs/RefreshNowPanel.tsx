"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import { Glyph } from "@/components/terminal/Glyph";
import { AsciiProgress } from "@/components/terminal/AsciiProgress";

type Stage = "queued" | "scrape" | "phase1" | "settle" | "predict" | "done" | "error";

type StageBlock = { state?: string } & Record<string, unknown>;

type RefreshRun = {
  run_id: string;
  status: Stage;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number;
  stage_progress: Record<string, StageBlock>;
  error: string | null;
  summary: {
    scrape?: Record<string, unknown>;
    phase1?: {
      labels_scanned?: number;
      labels_upserted?: number;
      closing_upserted?: number;
      closing_from_live_upserted?: number;
      elo_upserted?: number;
      elo_error?: string;
    };
    settle?: {
      pending_at_start?: number;
      settled?: number;
      voided?: number;
      skipped_no_label?: number;
      skipped_no_closing_price?: number;
    };
    predict?: {
      upcoming_events?: number;
      candidate_picks?: number;
      newly_inserted?: number;
      duplicates_skipped?: number;
    };
  };
};

type ListResponse = { active_run_id: string | null; runs: RefreshRun[] };

const STAGE_LABEL: Record<Stage, string> = {
  queued: "queued",
  scrape: "scrape · upcoming",
  phase1: "labels · closing · elo",
  settle: "settle · pending",
  predict: "predict · record",
  done: "done",
  error: "error",
};

const STAGE_ORDER: Stage[] = ["scrape", "phase1", "settle", "predict"];

function stageStep(status: Stage): number {
  if (status === "done") return STAGE_ORDER.length;
  if (status === "error") return -1;
  const idx = STAGE_ORDER.indexOf(status);
  return idx < 0 ? 0 : idx;
}

function stageToneClass(status: Stage): string {
  if (status === "error") return "border-neg text-neg";
  if (status === "done") return "border-pos text-pos";
  return "border-warn text-warn";
}

async function fetchList(): Promise<ListResponse> {
  const r = await fetch("/api/refresh-now");
  if (!r.ok) throw new Error(`refresh-now list ${r.status}`);
  return r.json();
}

async function fetchRun(runId: string): Promise<RefreshRun> {
  const r = await fetch(`/api/refresh-now/${encodeURIComponent(runId)}`);
  if (!r.ok) throw new Error(`refresh-now ${runId} ${r.status}`);
  return r.json();
}

async function startRun(): Promise<RefreshRun> {
  const r = await fetch("/api/refresh-now", { method: "POST" });
  if (!r.ok) throw new Error(`refresh-now POST ${r.status}`);
  return r.json();
}

export function RefreshNowPanel() {
  const qc = useQueryClient();

  // Poll the list every 3s so we always know if a run is active (and which one).
  const listQuery = useQuery({
    queryKey: ["refresh-now", "list"],
    queryFn: fetchList,
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });

  const activeId = listQuery.data?.active_run_id ?? null;
  const lastRun = listQuery.data?.runs?.[0];
  const focused = activeId ?? lastRun?.run_id ?? null;

  // Poll the focused run faster so the stage flips feel live.
  const runQuery = useQuery({
    queryKey: ["refresh-now", "run", focused],
    queryFn: () => (focused ? fetchRun(focused) : Promise.reject(new Error("no run"))),
    enabled: !!focused,
    refetchInterval: activeId ? 1500 : false,
    refetchOnWindowFocus: false,
  });

  const start = useMutation({
    mutationFn: startRun,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["refresh-now"] });
    },
  });

  const run = runQuery.data;
  const isActive = !!activeId;
  const error = start.error?.message ?? listQuery.error?.message ?? runQuery.error?.message;

  // Once the active run resolves we want the bulk-scrape job list to refresh
  // too — the scrape stage may have written new jobs.
  useEffect(() => {
    if (run?.status === "done" || run?.status === "error") {
      qc.invalidateQueries({ queryKey: ["bulk-scrape-jobs"] });
    }
  }, [run?.status, qc]);

  return (
    <section className="mb-6 border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-4 py-2">
        <Kicker>Refresh · scrape → settle → predict</Kicker>
        <span className="font-mono text-[10px] text-text-faint">
          ▸ one button: pull odds for upcoming, settle terminals, run models
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 px-4 py-3 font-mono text-[12px]">
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={isActive || start.isPending}
          className="border border-accent px-3 py-1 text-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isActive ? "running…" : start.isPending ? "starting…" : "▸ refresh all"}
        </button>

        {run && <RunBadge run={run} />}

        {!run && !isActive && (
          <span className="text-text-faint">no runs yet</span>
        )}
      </div>

      {run && <StageStrip run={run} />}

      {run?.status === "done" && <SummaryGrid run={run} />}

      {error && (
        <div className="border-t border-border px-4 py-2 font-mono text-[12px] text-neg">
          ▸ {error}
        </div>
      )}

      {run?.error && (
        <div className="border-t border-border px-4 py-2 font-mono text-[12px] text-neg">
          ▸ {run.error}
        </div>
      )}
    </section>
  );
}

function RunBadge({ run }: { run: RefreshRun }) {
  const label = STAGE_LABEL[run.status];
  const tone = stageToneClass(run.status);
  return (
    <span className={`inline-flex items-center gap-1 border-l-2 px-2 py-[1px] font-sans text-[10px] uppercase ${tone}`}
      style={{ letterSpacing: "var(--track-wide)" }}
    >
      <Glyph kind="led" />
      {label} · {run.duration_seconds.toFixed(0)}s
    </span>
  );
}

function StageStrip({ run }: { run: RefreshRun }) {
  const step = stageStep(run.status);
  return (
    <div className="grid grid-cols-1 gap-px border-t border-border bg-border md:grid-cols-4">
      {STAGE_ORDER.map((stage, i) => {
        const state =
          step < 0
            ? i === Math.max(0, run.status === "error" ? STAGE_ORDER.indexOf("scrape") : 0)
              ? "running"
              : "pending"
            : i < step
              ? "done"
              : i === step && run.status !== "done"
                ? "running"
                : i === step && run.status === "done"
                  ? "done"
                  : "pending";
        return <StageCell key={stage} stage={stage} state={state} block={run.stage_progress[stage]} />;
      })}
    </div>
  );
}

function StageCell({
  stage,
  state,
  block,
}: {
  stage: Stage;
  state: "pending" | "running" | "done";
  block?: StageBlock;
}) {
  const tone =
    state === "done"
      ? "text-pos"
      : state === "running"
        ? "text-warn"
        : "text-text-faint";
  return (
    <div className="bg-bg px-3 py-2">
      <div className="flex items-center justify-between font-sans text-[10px] uppercase">
        <span className={tone} style={{ letterSpacing: "var(--track-wide)" }}>
          {STAGE_LABEL[stage]}
        </span>
        <span className={tone}>{state}</span>
      </div>
      {state === "running" && <AsciiProgressIndeterminate />}
      {state === "done" && block && (
        <ul className="mt-1 font-mono text-[11px] text-text-dim">
          {Object.entries(block)
            .filter(([k]) => k !== "state")
            .slice(0, 6)
            .map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-3">
                <span className="text-text-faint">{k}</span>
                <span className="tabular-nums">{String(v)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function AsciiProgressIndeterminate() {
  // Indeterminate sweep: animate a single █ across a 10-cell track.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 10), 200);
    return () => clearInterval(id);
  }, []);
  const cells = Array.from({ length: 10 }, (_, i) => (i === tick ? "█" : "░"));
  return (
    <div className="mt-1 font-mono text-[11px] text-warn">
      {cells.join("")}
    </div>
  );
}

function SummaryGrid({ run }: { run: RefreshRun }) {
  const s = run.summary;
  const items = useMemo(
    () =>
      [
        s.scrape && {
          label: "scrape",
          rows: Object.entries(s.scrape).filter(([k]) => !k.startsWith("_")),
        },
        s.phase1 && {
          label: "phase1",
          rows: Object.entries(s.phase1),
        },
        s.settle && {
          label: "settle",
          rows: Object.entries(s.settle),
        },
        s.predict && {
          label: "predict",
          rows: Object.entries(s.predict),
        },
      ].filter(Boolean) as Array<{ label: string; rows: [string, unknown][] }>,
    [s.scrape, s.phase1, s.settle, s.predict],
  );
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-px border-t border-border bg-border md:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="bg-bg px-3 py-2">
          <div
            className="font-sans text-[10px] uppercase text-text-dim"
            style={{ letterSpacing: "var(--track-wide)" }}
          >
            {it.label}
          </div>
          <ul className="mt-1 font-mono text-[11px] text-text">
            {it.rows.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-3">
                <span className="text-text-faint">{k}</span>
                <span className="tabular-nums">{String(v)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
