"use client";

import { AxisLeft, AxisBottom } from "@visx/axis";

const baseTickLabelProps = () => ({
  fill: "rgb(var(--text-dim))",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  textAnchor: "middle" as const,
});

export function TerminalAxisLeft(props: React.ComponentProps<typeof AxisLeft>) {
  return (
    <AxisLeft
      stroke="rgb(var(--text-faint))"
      tickStroke="rgb(var(--text-faint))"
      tickLabelProps={() => ({
        ...baseTickLabelProps(),
        textAnchor: "end" as const,
        dx: -4,
      })}
      {...props}
    />
  );
}

export function TerminalAxisBottom(props: React.ComponentProps<typeof AxisBottom>) {
  return (
    <AxisBottom
      stroke="rgb(var(--text-faint))"
      tickStroke="rgb(var(--text-faint))"
      tickLabelProps={baseTickLabelProps}
      {...props}
    />
  );
}
