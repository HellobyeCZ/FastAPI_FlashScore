"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle } from "@visx/shape";
import { useMemo } from "react";

export type ScatterPoint = {
  x: number;
  y: number;
  category: string;
};

interface ScatterChartProps {
  points: ScatterPoint[];
  colorByCategory: Record<string, string>;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

export function ScatterChart({
  points,
  colorByCategory,
  width = 720,
  height = 240,
  xLabel,
  yLabel,
}: ScatterChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const xExtent = useMemo<[number, number]>(() => {
    if (points.length === 0) return [-0.05, 0.2];
    const xs = points.map((p) => p.x);
    return [Math.min(...xs, 0), Math.max(...xs, 0.05)];
  }, [points]);
  const yExtent = useMemo<[number, number]>(() => {
    if (points.length === 0) return [-1, 1];
    const ys = points.map((p) => p.y);
    return [Math.min(...ys, -1), Math.max(...ys, 1)];
  }, [points]);

  const xScale = scaleLinear<number>({ domain: xExtent, range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });

  if (points.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="scatter chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} label={xLabel} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} label={yLabel} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        <line x1={xScale(0)} x2={xScale(0)} y1={0} y2={innerH} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        {points.map((p, i) => (
          <Circle
            key={i}
            cx={xScale(p.x)}
            cy={yScale(p.y)}
            r={3}
            fill={colorByCategory[p.category] ?? "#888"}
            fillOpacity={0.7}
          />
        ))}
      </Group>
    </svg>
  );
}
