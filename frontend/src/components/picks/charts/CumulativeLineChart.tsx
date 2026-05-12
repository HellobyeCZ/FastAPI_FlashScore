"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { LinePath } from "@visx/shape";
import { useMemo } from "react";

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

export function CumulativeLineChart({
  series,
  width = 720,
  height = 240,
}: CumulativeLineChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allPoints = useMemo(
    () => series.flatMap((s) => s.points),
    [series],
  );

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
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="cumulative line chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="4 4" />
        {series.map((s) => (
          <LinePath
            key={s.label}
            data={s.points}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke={s.color}
            strokeWidth={2}
          />
        ))}
        <Group left={innerW - 80} top={4}>
          {series.map((s, i) => (
            <Group key={s.label} top={i * 14}>
              <line x1={0} x2={14} y1={5} y2={5} stroke={s.color} strokeWidth={2} />
              <text x={18} y={9} fontSize={10} fill="currentColor">{s.label}</text>
            </Group>
          ))}
        </Group>
      </Group>
    </svg>
  );
}
