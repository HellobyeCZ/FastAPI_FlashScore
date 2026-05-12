"use client";

import { Tooltip } from "@visx/tooltip";

export function TerminalTooltip({
  top,
  left,
  children,
}: {
  top: number;
  left: number;
  children: React.ReactNode;
}) {
  return (
    <Tooltip top={top} left={left} style={{ position: "absolute" }}>
      <div className="border border-border-hot bg-bg p-2 font-mono text-[11px] text-text">
        {children}
      </div>
    </Tooltip>
  );
}
