import { clsx } from "clsx";
import type { Tone } from "@/lib/labels";

const toneClass: Record<Exclude<Tone, "accent" | "pos">, { box: string; glyph: string; icon: string }> = {
  neutral: { box: "border-border-strong bg-surface", glyph: "text-text-dim", icon: "▸" },
  info: { box: "border-info/50 bg-info/5", glyph: "text-info", icon: "ℹ" },
  warn: { box: "border-warn/60 bg-warn/5", glyph: "text-warn", icon: "△" },
  neg: { box: "border-neg/60 bg-neg/5", glyph: "text-neg", icon: "✕" }
};

/**
 * Inline message box for warnings, errors and explanations. Use `role="alert"`
 * (via `urgent`) only for errors that appear after a user action.
 */
export function Callout({
  tone = "neutral",
  title,
  children,
  action,
  urgent,
  className
}: {
  tone?: "neutral" | "info" | "warn" | "neg";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  urgent?: boolean;
  className?: string;
}) {
  const t = toneClass[tone];
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={clsx("flex flex-wrap items-start gap-x-3 gap-y-2 border px-3 py-2.5", t.box, className)}
    >
      <span aria-hidden className={clsx("mt-px font-mono", t.glyph)}>
        {t.icon}
      </span>
      <div className="min-w-0 flex-1 text-body">
        {title && <div className="font-medium text-text">{title}</div>}
        {children && <div className={clsx("text-text-dim", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
