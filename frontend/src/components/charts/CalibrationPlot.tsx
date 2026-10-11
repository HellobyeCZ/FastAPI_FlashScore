"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import type { CalibrationBucket } from "@/lib/api-picks";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";

interface CalibrationPlotProps {
  buckets: CalibrationBucket[];
  width?: number;
  height?: number;
}

export function CalibrationPlot({ buckets, width = 480, height = 480 }: CalibrationPlotProps) {
  const padding = { top: 16, right: 16, bottom: 48, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const xScale = scaleLinear<number>({ domain: [0, 1], range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: [0, 1], range: [innerH, 0] });

  if (buckets.length === 0) {
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

  const sortedByPred = [...buckets].sort((a, b) => a.mean_pred - b.mean_pred);

  return (
    <svg width={width} height={height} role="img" aria-label="calibration plot">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group left={padding.left} top={padding.top}>
        <line
          x1={xScale(0)}
          y1={yScale(0)}
          x2={xScale(1)}
          y2={yScale(1)}
          stroke="var(--text-faint)"
          strokeDasharray="2 2"
        />
        {sortedByPred.length > 1 && (
          <polyline
            points={sortedByPred
              .map((b) => `${xScale(b.mean_pred).toFixed(1)},${yScale(b.hit_rate).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
          />
        )}
        {buckets.map((b, i) => (
          <rect
            key={i}
            x={xScale(b.mean_pred) - 2}
            y={yScale(b.hit_rate) - 2}
            width={4}
            height={4}
            fill="var(--accent)"
            shapeRendering="crispEdges"
          />
        ))}
        <TerminalAxisLeft scale={yScale} numTicks={5} />
        <TerminalAxisBottom top={innerH} scale={xScale} numTicks={5} />
      </Group>
    </svg>
  );
}
