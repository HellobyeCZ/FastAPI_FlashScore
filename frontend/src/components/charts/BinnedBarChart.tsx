"use client";
import { useElementWidth } from "@/hooks/useElementWidth";

export type Bin = {
  label: string;
  value: number | null;
  n: number;
  /** Optional 95% interval. */
  ciLow?: number | null;
  ciHigh?: number | null;
  /** Optional reference value (e.g. expected ROI implied by edge). */
  expected?: number | null;
};

export type BinnedBarChartProps = {
  bins: Bin[];
  ariaLabel: string;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  /** Formats y tick + value labels. */
  format?: (v: number) => string;
  /** Bins with n below this are drawn hatched/dim. */
  minN?: number;
  emptyLabel?: string;
};

/**
 * Vertical bars per bin with CI whiskers and n labels — for "ROI by edge
 * decile", "hit rate by price bucket", reliability-style summaries.
 */
export function BinnedBarChart({
  bins,
  ariaLabel,
  width: widthProp,
  height = 240,
  xLabel,
  yLabel,
  format = (v) => v.toFixed(2),
  minN = 10,
  emptyLabel = "—"
}: BinnedBarChartProps) {
  const [ref, measured] = useElementWidth<HTMLDivElement>(480);
  const width = widthProp ?? Math.max(260, measured);
  const valid = bins.filter((b) => b.value !== null && Number.isFinite(b.value));
  if (valid.length === 0) {
    return (
      <div ref={ref} className="py-6 text-center text-meta text-text-dim">
        {emptyLabel}
      </div>
    );
  }
  const m = { top: 16, right: 12, bottom: xLabel ? 46 : 32, left: yLabel ? 58 : 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const vals = bins.flatMap((b) => [b.value, b.ciLow, b.ciHigh, b.expected]).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => m.top + innerH - ((v - lo) / span) * innerH;
  const band = innerW / bins.length;
  const barW = Math.max(4, band * 0.62);
  const ticks = [lo, lo + span / 2, hi];

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        <title>{ariaLabel}</title>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke="rgb(var(--border))" />
            <text x={m.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="rgb(var(--text-dim))" fontFamily="var(--font-mono)">
              {format(t)}
            </text>
          </g>
        ))}
        <line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="rgb(var(--border-strong))" />
        {bins.map((b, i) => {
          const cx = m.left + band * i + band / 2;
          const small = b.n < minN;
          const v = b.value;
          return (
            <g key={b.label}>
              {v !== null && Number.isFinite(v) && (
                <rect
                  x={cx - barW / 2}
                  y={Math.min(y(v), y(0))}
                  width={barW}
                  height={Math.max(1, Math.abs(y(v) - y(0)))}
                  fill={v >= 0 ? "rgb(var(--pos))" : "rgb(var(--neg))"}
                  fillOpacity={small ? 0.3 : 0.8}
                />
              )}
              {b.ciLow != null && b.ciHigh != null && (
                <line x1={cx} x2={cx} y1={y(b.ciLow)} y2={y(b.ciHigh)} stroke="rgb(var(--text))" strokeOpacity={0.7} />
              )}
              {b.expected != null && (
                <line x1={cx - barW / 2 - 2} x2={cx + barW / 2 + 2} y1={y(b.expected)} y2={y(b.expected)} stroke="rgb(var(--info))" strokeDasharray="3 2" />
              )}
              <text x={cx} y={height - m.bottom + 14} textAnchor="middle" fontSize={11} fill="rgb(var(--text-dim))" fontFamily="var(--font-mono)">
                {b.label}
              </text>
              <text x={cx} y={height - m.bottom + 27} textAnchor="middle" fontSize={10} fill={small ? "rgb(var(--warn))" : "rgb(var(--text-faint))"} fontFamily="var(--font-mono)">
                n={b.n}
              </text>
            </g>
          );
        })}
        {xLabel && (
          <text x={m.left + innerW / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="rgb(var(--text-dim))">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text transform={`translate(12 ${m.top + innerH / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="rgb(var(--text-dim))">
            {yLabel}
          </text>
        )}
      </svg>
    </div>
  );
}
