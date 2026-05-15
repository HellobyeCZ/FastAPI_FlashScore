"use client";

import { useEffect, useMemo, useState } from "react";
import {
  listBacktestRuns,
  deleteBacktestRun,
  type BacktestRunSummary,
} from "@/lib/api-backtest";

export function BacktestRunsPanel({
  onSelect,
  onCompare,
  activeIds,
}: {
  onSelect: (id: string) => void;
  onCompare?: (ids: string[]) => void;
  activeIds?: string[];
}) {
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Sync local checked state with the URL-driven activeIds whenever it changes.
  const activeKey = (activeIds ?? []).join(",");
  useEffect(() => {
    setChecked(new Set(activeIds ?? []));
  }, [activeKey]);

  const statuses = runs.map((r) => r.status).join(",");

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const r = await listBacktestRuns();
        if (!stop) setRuns(r);
      } catch {
        /* ignore transient errors */
      }
    }
    tick();
    const pending = runs.some(
      (r) => r.status === "queued" || r.status === "running",
    );
    const intervalMs = pending ? 5000 : 30000;
    const id = setInterval(tick, intervalMs);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses]);

  const completedCount = useMemo(
    () => runs.filter((r) => r.status === "completed").length,
    [runs],
  );

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCompleted() {
    setChecked(
      new Set(runs.filter((r) => r.status === "completed").map((r) => r.id)),
    );
  }

  function clearSelection() {
    setChecked(new Set());
  }

  function applyCompare() {
    if (!onCompare) return;
    onCompare(Array.from(checked));
  }

  return (
    <div className="text-xs border border-zinc-800 p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="underline"
        >
          Backtest runs ({runs.length})
        </button>
        {onCompare && (
          <>
            <span className="text-zinc-500">·</span>
            <button
              type="button"
              onClick={selectAllCompleted}
              className="underline text-zinc-400"
              disabled={completedCount === 0}
              title="Select every completed run"
            >
              all completed
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="underline text-zinc-400"
              disabled={checked.size === 0}
            >
              clear
            </button>
            <button
              type="button"
              onClick={applyCompare}
              className="ml-auto border border-zinc-600 px-2 py-0.5 text-zinc-200 disabled:opacity-40"
              disabled={checked.size === 0}
            >
              Compare selected ({checked.size})
            </button>
          </>
        )}
      </div>
      {open && (
        <table className="w-full mt-2">
          <thead className="text-zinc-500">
            <tr>
              {onCompare && <th align="left"> </th>}
              <th align="left">model</th>
              <th align="left">label</th>
              <th>status</th>
              <th>bets</th>
              <th>ROI</th>
              <th>created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-zinc-900">
                {onCompare && (
                  <td>
                    <input
                      type="checkbox"
                      checked={checked.has(r.id)}
                      onChange={() => toggle(r.id)}
                      disabled={r.status !== "completed"}
                      title={
                        r.status === "completed"
                          ? "Include in comparison"
                          : "Only completed runs can be compared"
                      }
                    />
                  </td>
                )}
                <td>{r.model}</td>
                <td>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onSelect(r.id)}
                  >
                    {r.label}
                  </button>
                </td>
                <td align="center">
                  {r.status}
                  {r.stage ? <span className="text-zinc-500"> · {r.stage}</span> : null}
                </td>
                <td align="right">{r.total_bets ?? "—"}</td>
                <td align="right">
                  {r.roi !== null ? `${(r.roi * 100).toFixed(1)}%` : "—"}
                </td>
                <td align="right">
                  {r.created_at.slice(0, 16).replace("T", " ")}
                </td>
                <td align="right">
                  <button
                    type="button"
                    onClick={async () => {
                      if (confirm(`Delete run ${r.label}?`)) {
                        await deleteBacktestRun(r.id);
                        setRuns((prev) => prev.filter((x) => x.id !== r.id));
                      }
                    }}
                    className="text-red-400"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
