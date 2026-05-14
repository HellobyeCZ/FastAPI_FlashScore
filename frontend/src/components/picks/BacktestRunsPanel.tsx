"use client";

import { useEffect, useState } from "react";
import {
  listBacktestRuns,
  deleteBacktestRun,
  type BacktestRunSummary,
} from "@/lib/api-backtest";

export function BacktestRunsPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [open, setOpen] = useState(false);

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

  return (
    <div className="text-xs border border-zinc-800 p-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="underline"
      >
        Backtest runs ({runs.length})
      </button>
      {open && (
        <table className="w-full mt-2">
          <thead className="text-zinc-500">
            <tr>
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
                <td>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onSelect(r.id)}
                  >
                    {r.label}
                  </button>
                </td>
                <td align="center">{r.status}</td>
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
