"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { useMemo } from "react";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";
import { useElementWidth } from "@/hooks/useElementWidth";

export type ScatterPoint = {
  x: number;
  y: number;
  category: string;
};

interface ScatterChartProps {
  points: ScatterPoint[];
  /** Caller-provided color mapping; ignored in terminal style — all points use --accent.
   * Kept for API compatibility with the old chart. */
  colorByCategory?: Record<string, string>;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

export function ScatterChart({
  points,
  width: widthProp,
  height = 240,
}: ScatterChartProps) {
  const [containerRef, measuredWidth] = useElementWidth<HTMLDivElement>(720);
  const width = widthProp ?? Math.max(320, measuredWidth);
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
      <div ref={containerRef} style={{ width: "100%" }}>
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
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
    <svg width={width} height={height} role="img" aria-label="scatter chart">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group left={padding.left} top={padding.top}>
        <TerminalAxisBottom top={innerH} scale={xScale} />
        <TerminalAxisLeft scale={yScale} numTicks={5} />
        <line
          x1={0}
          x2={innerW}
          y1={yScale(0)}
          y2={yScale(0)}
          stroke="var(--text-faint)"
          strokeDasharray="2 2"
        />
        <line
          x1={xScale(0)}
          x2={xScale(0)}
          y1={0}
          y2={innerH}
          stroke="var(--text-faint)"
          strokeDasharray="2 2"
        />
        {points.map((p, i) => {
          // Tone by y sign — positive returns accent, negatives muted.
          const fill = p.y >= 0 ? "var(--accent)" : "var(--text-dim)";
          return (
            <rect
              key={i}
              x={xScale(p.x) - 1.5}
              y={yScale(p.y) - 1.5}
              width={3}
              height={3}
              fill={fill}
              shapeRendering="crispEdges"
            />
          );
        })}
      </Group>
    </svg>
    </div>
  );
}
