"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Bar } from "@visx/shape";
import { useMemo } from "react";

export type Bucket = {
  label: string;
  value: number | null;
  n: number;
};

interface BucketedBarChartProps {
  buckets: Bucket[];
  width?: number;
  height?: number;
  referenceY?: number;
  colorFor?: (v: number) => string;
}

export function BucketedBarChart({
  buckets,
  width = 480,
  height = 220,
  referenceY,
  colorFor = (v) => (v >= 0 ? "#3a8e3a" : "#a33"),
}: BucketedBarChartProps) {
  const padding = { top: 16, right: 16, bottom: 36, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const values = useMemo(() => buckets.map((b) => b.value ?? 0), [buckets]);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);

  const xScale = scaleBand<string>({
    domain: buckets.map((b) => b.label),
    range: [0, innerW],
    padding: 0.2,
  });
  const yScale = scaleLinear<number>({ domain: [yMin, yMax || 1], range: [innerH, 0] });

  return (
    <svg width={width} height={height} role="img" aria-label="bucketed bar chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        {referenceY !== undefined && (
          <line x1={0} x2={innerW} y1={yScale(referenceY)} y2={yScale(referenceY)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        )}
        {buckets.map((b) => {
          const x = xScale(b.label) ?? 0;
          const v = b.value ?? 0;
          const y0 = yScale(0);
          const y1 = yScale(v);
          const top = Math.min(y0, y1);
          const h = Math.abs(y0 - y1);
          return (
            <Group key={b.label}>
              <Bar
                x={x}
                y={top}
                width={xScale.bandwidth()}
                height={h}
                fill={colorFor(v)}
                fillOpacity={0.7}
              />
              <text
                x={x + xScale.bandwidth() / 2}
                y={top - 4}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
              >
                n={b.n}
              </text>
            </Group>
          );
        })}
      </Group>
    </svg>
  );
}
