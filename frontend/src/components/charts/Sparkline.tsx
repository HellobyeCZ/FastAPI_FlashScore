"use client";

import { clsx } from "clsx";
import { DASH } from "@/lib/format";
import { useElementWidth } from "@/hooks/useElementWidth";
import { ChartSvg, isFiniteNumber, tok } from "./frame";
import { useChartText } from "./text";

/** Width used when the container gives no width of its own (inline, shrink-wrapped). */
const FALLBACK_WIDTH = 120;

/**
 * Tiny inline trend line. `points` are y-values in order (oldest first). Fills
 * its container's width when `width` is omitted; the stroke follows the sign
 * of the last value unless `color` is given.
 */
export function Sparkline({
  points,
  width,
  height = 28,
  ariaLabel,
  color,
  format
}: {
  points: number[];
  width?: number;
  height?: number;
  ariaLabel: string;
  color?: string;
  /** Formats the first/last/min/max values in the description (default: locale number). */
  format?: (v: number) => string;
}) {
  const { t, fmt } = useChartText();
  // -1 = not measured yet; 0 = the container has no width of its own.
  const [ref, measured] = useElementWidth<HTMLDivElement>(-1);
  const values = points.filter(isFiniteNumber);
  const w = Math.floor(width ?? (measured > 0 ? measured : measured === 0 ? FALLBACK_WIDTH : 0));

  // The wrapper is rendered in every state so the measured element never changes.
  // An explicit width sizes the wrapper itself, so it never claims a whole flex row.
  const box = width === undefined ? "w-full min-w-0" : "max-w-full";
  if (values.length < 2) {
    return (
      <div ref={ref} className={clsx(box, "text-text-faint")} style={{ width }} title={ariaLabel}>
        {DASH}
      </div>
    );
  }

  const fmtValue = format ?? ((v: number) => fmt.num(v, 2));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => (i / (values.length - 1)) * (w - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values[values.length - 1];
  const stroke = color ?? (last >= 0 ? tok("pos") : tok("neg"));
  const desc = t("sparkline.desc", {
    first: fmtValue(values[0]),
    last: fmtValue(last),
    min: fmtValue(Math.min(...values)),
    max: fmtValue(Math.max(...values))
  });

  return (
    <div ref={ref} className={box} style={{ width, height }}>
      {w > 0 && (
        <ChartSvg width={w} height={height} label={ariaLabel} desc={desc}>
          <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke={tok("border-strong")} strokeDasharray="2 2" />
          <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
          <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill={stroke} />
        </ChartSvg>
      )}
    </div>
  );
}
