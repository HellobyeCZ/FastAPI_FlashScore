import { clsx } from "clsx";

type StatusKind =
  | "OPEN" | "PEND" | "WON" | "LOST" | "VOID"
  | "LIVE" | "FT" | "SCHED"
  | "RUN" | "OK" | "ERR";

const COLOR: Record<StatusKind, string> = {
  OPEN: "border-accent text-accent",
  PEND: "border-warn text-warn",
  WON: "border-pos text-pos",
  LOST: "border-neg text-neg",
  VOID: "border-text-faint text-text-dim",
  LIVE: "border-accent text-accent",
  FT: "border-text-faint text-text-dim",
  SCHED: "border-text-dim text-text-dim",
  RUN: "border-warn text-warn",
  OK: "border-pos text-pos",
  ERR: "border-neg text-neg"
};

export function StatusToken({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block border-l-2 px-2 py-[1px] font-mono text-[10px] uppercase",
        COLOR[kind],
        className
      )}
    >
      {kind}
    </span>
  );
}

export type { StatusKind };
