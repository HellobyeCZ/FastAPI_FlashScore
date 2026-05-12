import { clsx } from "clsx";

export function AsciiProgress({
  value,
  width = 10,
  className
}: {
  value: number; // 0..1
  width?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const pct = Math.round(clamped * 100);
  return (
    <span className={clsx("font-mono text-[11px]", className)}>
      <span className="text-accent">{"█".repeat(filled)}</span>
      <span className="text-text-faint">{"░".repeat(empty)}</span>
      <span className="ml-2 text-text-dim">{pct}%</span>
    </span>
  );
}
