"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { useMemo } from "react";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";

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

  // Cumulative trace across sorted bars (running total).
  let running = 0;
  const cumulative = sorted.map((b) => {
    running += b.value;
    return running;
  });

  return (
    <svg width={width} height={height} role="img" aria-label="waterfall by competition">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group left={padding.left} top={padding.top}>
        <TerminalAxisBottom
          top={innerH}
          scale={xScale}
          tickLabelProps={() => ({
            fill: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textAnchor: "end" as const,
            angle: -20,
            dx: -4,
          })}
        />
        <TerminalAxisLeft scale={yScale} numTicks={5} />
        <line
          x1={0}
          x2={innerW}
          y1={yScale(0)}
          y2={yScale(0)}
          stroke="var(--text-faint)"
          strokeDasharray="2 2"
        />
        {sorted.map((b) => {
          const x = xScale(b.label) ?? 0;
          const y0 = yScale(0);
          const y1 = yScale(b.value);
          return (
            <rect
              key={b.label}
              x={x}
              y={Math.min(y0, y1)}
              width={xScale.bandwidth()}
              height={Math.abs(y0 - y1)}
              fill={b.value >= 0 ? "var(--pos)" : "var(--neg)"}
              shapeRendering="crispEdges"
            />
          );
        })}
        {cumulative.length > 1 && (
          <polyline
            points={sorted
              .map((b, i) => {
                const cx = (xScale(b.label) ?? 0) + xScale.bandwidth() / 2;
                return `${cx.toFixed(1)},${yScale(cumulative[i]).toFixed(1)}`;
              })
              .join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
          />
        )}
      </Group>
    </svg>
  );
}
