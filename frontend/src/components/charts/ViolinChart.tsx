"use client";

import { Group } from "@visx/group";
import { scaleLinear, scaleBand } from "@visx/scale";
import { ViolinPlot, BoxPlot } from "@visx/stats";
import { useMemo } from "react";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";

export type ViolinSeries = {
  label: string;
  color: string;
  values: number[];
};

interface ViolinChartProps {
  series: ViolinSeries[];
  width?: number;
  height?: number;
  yLabel?: string;
  referenceY?: number;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Silverman's rule of thumb: 1.06 * σ * n^(-1/5).
// Falls back to (max-min)/20 when σ is degenerate.
function silvermanBandwidth(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0.01;
  const sigma = stdev(values);
  if (sigma > 0) return 1.06 * sigma * Math.pow(n, -1 / 5);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (max - min) / 20 || 0.01;
}

function computeKde(values: number[]): { value: number; density: number }[] {
  if (values.length === 0) return [];
  const bandwidth = silvermanBandwidth(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Extend domain slightly past the data so the violin tails close.
  const pad = bandwidth * 2;
  const lo = min - pad;
  const hi = max + pad;
  const step = (hi - lo) / 64 || 0.001;
  const out: { value: number; density: number }[] = [];
  for (let x = lo; x <= hi; x += step) {
    let d = 0;
    for (const v of values) {
      const u = (x - v) / bandwidth;
      d += Math.exp(-0.5 * u * u);
    }
    out.push({ value: x, density: d / (values.length * bandwidth * Math.sqrt(2 * Math.PI)) });
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    firstQuartile: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    thirdQuartile: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function ViolinChart({ series, width = 480, height = 240, referenceY }: ViolinChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = useMemo(() => series.flatMap((s) => s.values), [series]);
  const yExtent = useMemo<[number, number]>(() => {
    if (allValues.length === 0) return [0, 1];
    const lo = Math.min(0, ...allValues);
    const hi = Math.max(0, ...allValues);
    return [lo, hi];
  }, [allValues]);

  const xScale = scaleBand<string>({
    domain: series.map((s) => s.label),
    range: [0, innerW],
    padding: 0.3,
  });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });
  const bandWidth = xScale.bandwidth();

  if (allValues.length === 0) {
    return (
      <svg width={width} height={height} role="img">
        <rect width={width} height={height} fill="var(--bg)" />
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          fontSize={11}
          fontFamily="var(--font-mono)"
          fill="var(--text-dim)"
        >
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="violin distribution">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group left={padding.left} top={padding.top}>
        <TerminalAxisBottom top={innerH} scale={xScale} />
        <TerminalAxisLeft scale={yScale} numTicks={5} />
        {referenceY !== undefined && (
          <line
            x1={0}
            x2={innerW}
            y1={yScale(referenceY)}
            y2={yScale(referenceY)}
            stroke="var(--text-faint)"
            strokeDasharray="2 2"
          />
        )}
        {series.map((s) => {
          const cx = (xScale(s.label) ?? 0) + bandWidth / 2;
          const stats = summary(s.values);
          return (
            <Group key={s.label} left={cx}>
              <ViolinPlot
                data={computeKde(s.values)}
                stroke={s.color || "var(--accent)"}
                fill="transparent"
                valueScale={yScale}
                width={bandWidth * 0.85}
                horizontal={false}
                count={(d) => d.density}
                value={(d) => d.value}
              />
              <BoxPlot
                min={stats.min}
                max={stats.max}
                left={-bandWidth * 0.18}
                firstQuartile={stats.firstQuartile}
                thirdQuartile={stats.thirdQuartile}
                median={stats.median}
                boxWidth={bandWidth * 0.36}
                fill="var(--bg)"
                fillOpacity={1}
                stroke="var(--text-dim)"
                strokeWidth={1}
                valueScale={yScale}
              />
            </Group>
          );
        })}
      </Group>
    </svg>
  );
}
