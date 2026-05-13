"use client";

import { useMemo } from "react";

export type HeatmapCell = {
  row: string;
  col: string;
  value: number | null;
  n: number;
};

interface HeatmapChartProps {
  cells: HeatmapCell[];
  rows: string[];
  cols: string[];
  /** Optional override; if not provided, the terminal default is used.
   * The default uses `--accent` for positive, `--neg` for negative, with
   * intensity proportional to |v|/vmax. */
  colorScale?: (v: number, vmax: number) => string;
  minNToShow?: number;
  width?: number;
  cellHeight?: number;
}

function terminalColorScale(v: number, vmax: number): string {
  const t = vmax === 0 ? 0 : Math.max(-1, Math.min(1, v / vmax));
  // Use CSS color-mix to interpolate between bg and accent/neg.
  const pct = Math.round(Math.abs(t) * 100);
  if (t >= 0) {
    return `color-mix(in srgb, var(--accent) ${pct}%, var(--bg))`;
  }
  return `color-mix(in srgb, var(--neg) ${pct}%, var(--bg))`;
}

export function HeatmapChart({
  cells,
  rows,
  cols,
  colorScale = terminalColorScale,
  minNToShow = 1,
  width = 720,
  cellHeight = 28,
}: HeatmapChartProps) {
  const cellWidth = (width - 120) / Math.max(1, cols.length);
  const map = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    cells.forEach((c) => m.set(`${c.row}::${c.col}`, c));
    return m;
  }, [cells]);
  const vmax = useMemo(() => {
    const vals = cells
      .filter((c) => c.value !== null && c.n >= minNToShow)
      .map((c) => Math.abs(c.value as number));
    return vals.length === 0 ? 0.05 : Math.max(...vals);
  }, [cells, minNToShow]);

  const rowTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) {
      let sum = 0;
      for (const c of cols) {
        const cell = map.get(`${r}::${c}`);
        if (cell && cell.value !== null && cell.n >= minNToShow) {
          sum += Math.abs(cell.value);
        }
      }
      totals.set(r, sum);
    }
    return totals;
  }, [rows, cols, map, minNToShow]);

  const maxRowTotal = useMemo(
    () => Math.max(0.0001, ...Array.from(rowTotals.values())),
    [rowTotals],
  );

  const hiddenCount = useMemo(
    () =>
      cells.filter((c) => c.value !== null && c.n < minNToShow).length,
    [cells, minNToShow],
  );

  return (
    <div style={{ overflowX: "auto" }} className="border border-border bg-bg">
      {hiddenCount > 0 && (
        <div className="border-b border-border px-3 py-1 font-mono text-[10px] text-text-faint">
          ▸ {hiddenCount} {hiddenCount === 1 ? "cell" : "cells"} hidden (n &lt; {minNToShow})
        </div>
      )}
      <table className="border-collapse font-mono text-[11px]">
        <thead>
          <tr>
            <th style={{ minWidth: 100 }} className="px-2 py-1 text-left font-sans text-[10px] uppercase text-text-dim" />
            {cols.map((c) => (
              <th
                key={c}
                style={{ minWidth: cellWidth }}
                className="px-1 py-1 text-center font-sans text-[10px] uppercase text-text-dim"
              >
                {c}
              </th>
            ))}
            <th
              style={{ minWidth: 80 }}
              className="px-1 py-1 text-left font-sans text-[10px] uppercase text-text-dim"
            >
              row total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td className="px-2 py-1 text-text">{r}</td>
              {cols.map((c) => {
                const cell = map.get(`${r}::${c}`);
                if (!cell || cell.value === null || cell.n < minNToShow) {
                  return (
                    <td
                      key={c}
                      style={{
                        height: cellHeight,
                        border: "1px solid var(--bg)",
                        background: "color-mix(in srgb, var(--text-faint) 12%, var(--bg))",
                      }}
                      className="text-center text-text-faint"
                      title={cell ? `n=${cell.n} (too small)` : "no data"}
                    >
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={c}
                    style={{
                      height: cellHeight,
                      background: colorScale(cell.value, vmax),
                      border: "1px solid var(--bg)",
                    }}
                    className="text-center tabular-nums text-text"
                    title={`${r} × ${c}: ${cell.value.toFixed(3)} (n=${cell.n})`}
                  >
                    {(cell.value * 100).toFixed(1)}%
                  </td>
                );
              })}
              <td className="px-1 py-1" style={{ height: cellHeight }}>
                <div className="flex items-center gap-1">
                  <div
                    style={{
                      width: Math.max(2, ((rowTotals.get(r) ?? 0) / maxRowTotal) * 60),
                      height: 6,
                      background: "var(--accent)",
                    }}
                  />
                  <span className="font-mono text-[10px] tabular-nums text-text-dim">
                    {((rowTotals.get(r) ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
