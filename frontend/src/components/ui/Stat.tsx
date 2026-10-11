import { clsx } from "clsx";
import { Label } from "./Field";
import type { Tone } from "@/lib/labels";

const toneText: Record<Tone, string> = {
  neutral: "text-text",
  accent: "text-accent",
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  info: "text-info"
};

/**
 * KPI tile. `sub` carries context the number needs to be trusted: sample
 * size, window, comparison. `caution` dims the value and explains why
 * (e.g. small n) instead of presenting noise as a headline.
 */
export function Stat({
  label,
  value,
  tone = "neutral",
  sub,
  caution,
  size = "md",
  className,
  children
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  sub?: React.ReactNode;
  caution?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-1.5 px-4 py-3", className)}>
      <Label as="div">{label}</Label>
      <div
        className={clsx(
          "font-mono leading-none tabular-nums",
          size === "sm" && "text-lead",
          size === "md" && "text-stat",
          size === "lg" && "text-hero",
          caution ? "text-text-dim" : toneText[tone]
        )}
      >
        {value}
      </div>
      {sub && <div className="text-meta text-text-dim">{sub}</div>}
      {caution && (
        <div className="flex items-start gap-1 text-meta text-warn">
          <span aria-hidden>△</span>
          <span>{caution}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** Responsive row of Stat tiles separated by hairlines. */
export function StatGrid({
  children,
  cols = 4,
  className
}: {
  children: React.ReactNode;
  cols?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}) {
  const colClass = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-3 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6"
  }[cols];
  return (
    <div
      className={clsx(
        "grid grid-cols-1 gap-px border border-border bg-border [&>*]:bg-bg",
        colClass,
        className
      )}
    >
      {children}
    </div>
  );
}
