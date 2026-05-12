"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle } from "@visx/shape";
import type { CalibrationBucket } from "@/lib/api-picks";

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
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  const maxN = Math.max(...buckets.map((b) => b.n));

  return (
    <svg width={width} height={height} role="img" aria-label="calibration plot">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} label="predicted prob" />
        <AxisLeft scale={yScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} label="actual hit rate" />
        <line x1={xScale(0)} y1={yScale(0)} x2={xScale(1)} y2={yScale(1)} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="4 4" />
        {buckets.map((b, i) => {
          const r = 3 + 9 * Math.sqrt(b.n / Math.max(1, maxN));
          return (
            <Circle
              key={i}
              cx={xScale(b.mean_pred)}
              cy={yScale(b.hit_rate)}
              r={r}
              fill="#1f77b4"
              fillOpacity={0.7}
            />
          );
        })}
      </Group>
    </svg>
  );
}
