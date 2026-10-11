"use client";
import { useElementWidth } from "@/hooks/useElementWidth";

export type HBar = {
  label: string;
  value: number;
  /** Sample size shown next to the bar. */
  n?: number;
  /** Pre-formatted value label; defaults to value.toFixed(2). */
  valueLabel?: string;
};

export type HBarChartProps = {
  bars: HBar[];
  /** Accessible summary of what the chart shows. */
  ariaLabel: string;
  width?: number;
  rowHeight?: number;
  /** Sort descending by value (default true). */
  sort?: boolean;
  /** Color by sign (pos/neg) — default true. Otherwise uses `color`. */
  signed?: boolean;
  color?: string;
  emptyLabel?: string;
};

/**
 * Horizontal bars, one row per category, diverging around zero. Replaces the
 * old "waterfall" whose cumulative line ran across unrelated categories.
 */
export function HBarChart({
  bars,
  ariaLabel,
  width: widthProp,
  rowHeight = 22,
  sort = true,
  signed = true,
  color = "rgb(var(--cat-1))",
  emptyLabel = "—"
}: HBarChartProps) {
  const [ref, measured] = useElementWidth<HTMLDivElement>(480);
  const width = widthProp ?? Math.max(240, measured);
  const rows = sort ? [...bars].sort((a, b) => b.value - a.value) : bars;
  if (rows.length === 0) {
    return (
      <div ref={ref} className="py-6 text-center text-meta text-text-dim">
        {emptyLabel}
      </div>
    );
  }
  const labelW = Math.min(180, Math.max(90, width * 0.32));
  const valueW = 92;
  const plotW = Math.max(40, width - labelW - valueW);
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const hasNeg = rows.some((r) => r.value < 0);
  const zeroX = hasNeg ? labelW + plotW / 2 : labelW;
  const scale = (hasNeg ? plotW / 2 : plotW) / max;
  const height = rows.length * rowHeight + 8;

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        <title>{ariaLabel}</title>
        <line x1={zeroX} x2={zeroX} y1={0} y2={height} stroke="rgb(var(--border-strong))" />
        {rows.map((r, i) => {
          const y = i * rowHeight + 4;
          const w = Math.abs(r.value) * scale;
          const x = r.value >= 0 ? zeroX : zeroX - w;
          const fill = signed ? (r.value >= 0 ? "rgb(var(--pos))" : "rgb(var(--neg))") : color;
          return (
            <g key={r.label}>
              <text
                x={labelW - 8}
                y={y + rowHeight / 2}
                dominantBaseline="middle"
                textAnchor="end"
                fill="rgb(var(--text-dim))"
                fontSize={12}
                fontFamily="var(--font-mono)"
              >
                {r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}
              </text>
              <rect x={x} y={y + 4} width={Math.max(1, w)} height={rowHeight - 8} fill={fill} fillOpacity={0.85} />
              <text
                x={labelW + plotW + 8}
                y={y + rowHeight / 2}
                dominantBaseline="middle"
                fill="rgb(var(--text))"
                fontSize={12}
                fontFamily="var(--font-mono)"
              >
                {r.valueLabel ?? r.value.toFixed(2)}
                {r.n !== undefined && <tspan fill="rgb(var(--text-faint))">{`  n=${r.n}`}</tspan>}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
