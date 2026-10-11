"use client";

import { useMemo } from "react";
import { clsx } from "clsx";
import { EmptyState } from "@/components/ui";
import { useElementWidth } from "@/hooks/useElementWidth";
import { tok } from "./frame";
import { useChartText } from "./text";

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
  /**
   * Optional fill override. The default diverges around zero (`--pos` above,
   * `--neg` below) and picks a legible ink for every fill; a custom scale is
   * always printed with the light text ink, so keep its fills dark.
   */
  colorScale?: (v: number, vmax: number) => string;
  /** Cells with fewer observations are shown as "—" and left out of row means. */
  minNToShow?: number;
  width?: number;
  cellHeight?: number;
  /** Table caption (screen readers); default "Heatmap". */
  ariaLabel?: string;
  /** Header of the row-label column, e.g. "Competition". */
  rowHeader?: string;
  /** Display text for row / column keys (default: the key). */
  rowLabel?: (row: string) => string;
  colLabel?: (col: string) => string;
  /** Formats cell values (default: signed percent, 1 decimal). */
  formatValue?: (v: number) => string;
  /** Trailing n-weighted row mean column (default true). */
  showRowMean?: boolean;
  emptyLabel?: string;
}

type Fill = { background: string; color: string };

/*
 * Fill = the sign hue mixed over --bg. Each sign has a light-ink band (weak
 * values) and a dark-ink band (strong values); mixes between them are skipped
 * because neither ink reaches WCAG AA there. Contrast at the band edges with
 * the current tokens (text 232, accent-ink 10, pos 200/240/0, neg 255/85/119):
 *   pos: light ink ≥ 5.20:1 up to 40 %, dark ink ≥ 4.97:1 from 55 %
 *   neg: light ink ≥ 4.99:1 up to 65 %, dark ink ≥ 4.86:1 from 85 %
 */
const BANDS = {
  pos: { light: [8, 40], dark: [55, 90] },
  neg: { light: [8, 65], dark: [85, 100] }
} as const;

function divergingFill(v: number, vmax: number): Fill {
  if (v === 0 || vmax === 0) return { background: tok("surface-2"), color: tok("text") };
  const t = Math.min(1, Math.abs(v) / vmax);
  const hue = v > 0 ? "pos" : "neg";
  const strong = t > 0.5;
  const [a, b] = strong ? BANDS[hue].dark : BANDS[hue].light;
  const u = strong ? (t - 0.5) / 0.5 : t / 0.5;
  const mix = Math.round(a + (b - a) * u);
  return {
    background: `color-mix(in srgb, ${tok(hue)} ${mix}%, ${tok("bg")})`,
    color: strong ? tok("accent-ink") : tok("text")
  };
}

const MIN_CELL = 64;
const MEAN_COL = 92;

/**
 * Value matrix (e.g. ROI by competition × market) as a real table: row and
 * column headers, the value and its n printed in every cell, an n-weighted
 * row mean, and a horizontal scroll inside the panel when columns don't fit.
 */
export function HeatmapChart({
  cells,
  rows,
  cols,
  colorScale,
  minNToShow = 1,
  width: widthProp,
  cellHeight = 40,
  ariaLabel,
  rowHeader,
  rowLabel = (r) => r,
  colLabel = (c) => c,
  formatValue,
  showRowMean = true,
  emptyLabel
}: HeatmapChartProps) {
  const { t, tp, fmt, noData } = useChartText();
  const [ref, measured] = useElementWidth<HTMLDivElement>(0);
  const width = widthProp ?? measured;
  const fmtValue = formatValue ?? ((v: number) => fmt.pct(v, 1, true));
  const shown = (c: HeatmapCell | undefined): c is HeatmapCell & { value: number } =>
    !!c && c.value !== null && Number.isFinite(c.value) && c.n >= minNToShow;

  const map = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    cells.forEach((c) => m.set(`${c.row}::${c.col}`, c));
    return m;
  }, [cells]);

  const rowMeans = useMemo(() => {
    const out = new Map<string, { value: number; n: number } | null>();
    for (const r of rows) {
      let weighted = 0;
      let n = 0;
      for (const c of cols) {
        const cell = map.get(`${r}::${c}`);
        if (cell && cell.value !== null && Number.isFinite(cell.value) && cell.n >= minNToShow) {
          weighted += cell.value * cell.n;
          n += cell.n;
        }
      }
      out.set(r, n > 0 ? { value: weighted / n, n } : null);
    }
    return out;
  }, [rows, cols, map, minNToShow]);

  const visible = cells.filter((c) => shown(c));
  const vmax = Math.max(0, ...visible.map((c) => Math.abs(c.value as number)));
  const hidden = cells.filter((c) => c.value !== null && c.n < minNToShow).length;
  const fill = (v: number): Fill =>
    colorScale ? { background: colorScale(v, vmax), color: tok("text") } : divergingFill(v, vmax);

  const labelW = Math.round(Math.min(180, Math.max(96, width * 0.26)));
  const minTableW = labelW + cols.length * MIN_CELL + (showRowMean ? MEAN_COL : 0);
  const caption = ariaLabel ?? t("heatmap.aria");
  // When the table scrolls inside its panel, row labels stay pinned on the left.
  const pinned = width > 0 && width < minTableW && "sticky left-0 z-10 border-r border-border bg-surface";
  const empty = rows.length === 0 || cols.length === 0 || visible.length === 0;

  return (
    <div ref={ref} className="w-full min-w-0">
      {empty ? (
        <EmptyState compact title={emptyLabel ?? noData}>
          {hidden > 0 ? tp("hidden", hidden, { min: minNToShow }) : null}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed border-collapse font-mono text-meta"
              style={{ minWidth: minTableW }}
            >
              <caption className="sr-only">{caption}</caption>
              <colgroup>
                <col style={{ width: labelW }} />
                {cols.map((c) => (
                  <col key={c} />
                ))}
                {showRowMean && <col style={{ width: MEAN_COL }} />}
              </colgroup>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={clsx(
                      "truncate px-2 py-1.5 text-left align-bottom font-sans text-label font-normal uppercase tracking-label text-text-dim",
                      pinned
                    )}
                  >
                    {rowHeader}
                  </th>
                  {cols.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      title={colLabel(c)}
                      className="break-words px-1 py-1.5 text-center align-bottom font-sans text-label font-normal uppercase tracking-label text-text-dim"
                    >
                      {colLabel(c)}
                    </th>
                  ))}
                  {showRowMean && (
                    <th
                      scope="col"
                      title={t("heatmap.rowMeanHint")}
                      className="break-words border-l border-border-strong px-1 py-1.5 text-center align-bottom font-sans text-label font-normal uppercase tracking-label text-text-dim"
                    >
                      {t("heatmap.rowMean")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mean = rowMeans.get(r) ?? null;
                  return (
                    <tr key={r}>
                      <th
                        scope="row"
                        title={rowLabel(r)}
                        className={clsx("truncate px-2 text-left font-sans text-body font-normal text-text", pinned)}
                      >
                        {rowLabel(r)}
                      </th>
                      {cols.map((c) => {
                        const cell = map.get(`${r}::${c}`);
                        if (shown(cell)) {
                          const f = fill(cell.value);
                          return (
                            <Cell
                              key={c}
                              height={cellHeight}
                              fill={f}
                              value={fmtValue(cell.value)}
                              n={fmt.int(cell.n)}
                              title={t("heatmap.cell", {
                                row: rowLabel(r),
                                col: colLabel(c),
                                value: fmtValue(cell.value),
                                n: fmt.int(cell.n)
                              })}
                            />
                          );
                        }
                        const small = !!cell && cell.value !== null;
                        return (
                          <Cell
                            key={c}
                            height={cellHeight}
                            muted
                            value="—"
                            n={small ? fmt.int(cell.n) : undefined}
                            title={
                              small
                                ? t("heatmap.cellSmall", {
                                    row: rowLabel(r),
                                    col: colLabel(c),
                                    n: fmt.int(cell.n),
                                    min: minNToShow
                                  })
                                : t("heatmap.cellEmpty", { row: rowLabel(r), col: colLabel(c) })
                            }
                          />
                        );
                      })}
                      {showRowMean &&
                        (mean ? (
                          <Cell
                            height={cellHeight}
                            fill={fill(mean.value)}
                            value={fmtValue(mean.value)}
                            n={fmt.int(mean.n)}
                            separated
                            title={t("heatmap.cell", {
                              row: rowLabel(r),
                              col: t("heatmap.rowMean"),
                              value: fmtValue(mean.value),
                              n: fmt.int(mean.n)
                            })}
                          />
                        ) : (
                          <Cell height={cellHeight} muted separated value="—" />
                        ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hidden > 0 && <p className="mt-2 text-meta text-text-dim">{tp("hidden", hidden, { min: minNToShow })}</p>}
        </>
      )}
    </div>
  );
}

function Cell({
  height,
  fill,
  muted,
  separated,
  value,
  n,
  title
}: {
  height: number;
  fill?: Fill;
  muted?: boolean;
  separated?: boolean;
  value: string;
  n?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      style={{
        height,
        background: fill?.background,
        color: fill?.color,
        boxShadow: `inset 0 0 0 1px ${tok("bg")}`
      }}
      className={clsx(
        "px-1 text-center tabular-nums leading-tight",
        muted && "bg-surface text-text-faint",
        separated && "border-l border-border-strong"
      )}
    >
      <div className="truncate">{value}</div>
      {n !== undefined && <div className="truncate text-label">{`n\u00a0${n}`}</div>}
    </td>
  );
}
