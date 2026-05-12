"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Bar } from "@visx/shape";
import { useMemo } from "react";

export type WaterfallBar = {
  label: string;
  value: number;
};

interface WaterfallChartProps {
  bars: WaterfallBar[];
  width?: number;
  height?: number;
}

export function WaterfallChart({ bars, width = 480, height = 220 }: WaterfallChartProps) {
  const padding = { top: 16, right: 16, bottom: 36, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const sorted = useMemo(() => [...bars].sort((a, b) => b.value - a.value), [bars]);
  const values = sorted.map((b) => b.value);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);

  const xScale = scaleBand<string>({
    domain: sorted.map((b) => b.label),
    range: [0, innerW],
    padding: 0.2,
  });
  const yScale = scaleLinear<number>({ domain: [yMin, yMax || 1], range: [innerH, 0] });

  if (sorted.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="waterfall by competition">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", angle: -20, textAnchor: "end", dx: -4 }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.3} />
        {sorted.map((b) => {
          const x = xScale(b.label) ?? 0;
          const y0 = yScale(0);
          const y1 = yScale(b.value);
          return (
            <Bar
              key={b.label}
              x={x}
              y={Math.min(y0, y1)}
              width={xScale.bandwidth()}
              height={Math.abs(y0 - y1)}
              fill={b.value >= 0 ? "#3a8e3a" : "#a33"}
              fillOpacity={0.7}
            />
          );
        })}
      </Group>
    </svg>
  );
}
