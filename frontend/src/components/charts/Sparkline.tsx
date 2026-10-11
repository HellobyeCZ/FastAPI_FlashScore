"use client";

/** Tiny inline trend line. `points` are y-values in order. */
export function Sparkline({
  points,
  width = 120,
  height = 28,
  ariaLabel,
  color
}: {
  points: number[];
  width?: number;
  height?: number;
  ariaLabel: string;
  color?: string;
}) {
  if (points.length < 2) return <span className="text-text-faint">—</span>;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const stroke = color ?? (last >= 0 ? "rgb(var(--pos))" : "rgb(var(--neg))");
  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="rgb(var(--border-strong))" strokeDasharray="2 2" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}
