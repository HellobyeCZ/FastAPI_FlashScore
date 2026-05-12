"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { useMemo } from "react";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";

export type Series = {
  label: string;
  color: string;
  points: { x: number; y: number }[];
};

interface CumulativeLineChartProps {
  series: Series[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

// Fallback palette uses semantic terminal tokens.
const SERIES_TOKENS = [
  "var(--accent)",
  "var(--warn)",
  "var(--pos)",
  "var(--neg)",
  "var(--text-dim)",
];

export function CumulativeLineChart({
  series,
  width = 720,
  height = 240,
}: CumulativeLineChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allPoints = useMemo(() => series.flatMap((s) => s.points), [series]);

  const xExtent = useMemo<[number, number]>(() => {
    if (allPoints.length === 0) return [0, 1];
    const xs = allPoints.map((p) => p.x);
    return [Math.min(...xs), Math.max(...xs)];
  }, [allPoints]);
  const yExtent = useMemo<[number, number]>(() => {
    if (allPoints.length === 0) return [0, 1];
    const ys = allPoints.map((p) => p.y);
    return [Math.min(0, ...ys), Math.max(0, ...ys)];
  }, [allPoints]);

  const xScale = scaleLinear<number>({ domain: xExtent, range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });

  if (allPoints.length === 0) {
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
    <svg width={width} height={height} role="img" aria-label="cumulative line chart">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group left={padding.left} top={padding.top}>
        <TerminalAxisBottom top={innerH} scale={xScale} numTicks={6} />
        <TerminalAxisLeft scale={yScale} numTicks={5} />
        <line
          x1={0}
          x2={innerW}
          y1={yScale(0)}
          y2={yScale(0)}
          stroke="var(--text-faint)"
          strokeDasharray="2 2"
        />
        {series.map((s, idx) => {
          const stroke = SERIES_TOKENS[idx % SERIES_TOKENS.length];
          return (
            <LinePath
              key={s.label}
              data={s.points}
              x={(d) => xScale(d.x)}
              y={(d) => yScale(d.y)}
              stroke={stroke}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          );
        })}
        {series.length > 1 && (
          <Group left={innerW - 90} top={4}>
            {series.map((s, i) => {
              const stroke = SERIES_TOKENS[i % SERIES_TOKENS.length];
              return (
                <Group key={s.label} top={i * 14}>
                  <line x1={0} x2={14} y1={5} y2={5} stroke={stroke} strokeWidth={1} />
                  <text
                    x={18}
                    y={9}
                    fontSize={10}
                    fontFamily="var(--font-mono)"
                    fill="var(--text-dim)"
                  >
                    {s.label}
                  </text>
                </Group>
              );
            })}
          </Group>
        )}
      </Group>
    </svg>
  );
}
