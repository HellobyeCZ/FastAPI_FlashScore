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

function computeKde(values: number[], bandwidth = 0.02): { value: number; density: number }[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / 30 || 0.001;
  const out: { value: number; density: number }[] = [];
  for (let x = min; x <= max; x += step) {
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
                stroke="var(--accent)"
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
