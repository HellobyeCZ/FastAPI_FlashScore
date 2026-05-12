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
  colorScale?: (v: number, vmax: number) => string;
  minNToShow?: number;
  width?: number;
  cellHeight?: number;
}

function defaultColorScale(v: number, vmax: number): string {
  const t = Math.max(-1, Math.min(1, v / (vmax || 1)));
  if (t >= 0) {
    const r = Math.round(232 - t * (232 - 200));
    const g = Math.round(232 + t * (230 - 232));
    const b = Math.round(232 - t * (232 - 200));
    return `rgb(${r},${g},${b})`;
  } else {
    const r = Math.round(232 + (-t) * (252 - 232));
    const g = Math.round(232 - (-t) * (232 - 224));
    const b = Math.round(232 - (-t) * (232 - 224));
    return `rgb(${r},${g},${b})`;
  }
}

export function HeatmapChart({
  cells,
  rows,
  cols,
  colorScale = defaultColorScale,
  minNToShow = 1,
  width = 720,
  cellHeight = 32,
}: HeatmapChartProps) {
  const cellWidth = (width - 100) / Math.max(1, cols.length);
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

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ minWidth: 100 }} />
            {cols.map((c) => (
              <th key={c} style={{ minWidth: cellWidth, padding: "4px 6px", textAlign: "center" }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td style={{ padding: "4px 6px", fontWeight: 600 }}>{r}</td>
              {cols.map((c) => {
                const cell = map.get(`${r}::${c}`);
                if (!cell || cell.value === null || cell.n < minNToShow) {
                  return (
                    <td
                      key={c}
                      style={{ height: cellHeight, background: "#e0e0e0", textAlign: "center", color: "#888" }}
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
                      textAlign: "center",
                      color: "#222",
                    }}
                    title={`${r} × ${c}: ${cell.value.toFixed(3)} (n=${cell.n})`}
                  >
                    {(cell.value * 100).toFixed(1)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
