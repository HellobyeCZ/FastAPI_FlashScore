"use client";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { normalizeState, STATE_TONE, type StateKey, type Tone } from "@/lib/labels";
import type { MessageKey } from "@/lib/i18n";

const toneClass: Record<Tone, string> = {
  neutral: "border-text-faint text-text-dim",
  accent: "border-accent text-accent",
  pos: "border-pos text-pos",
  neg: "border-neg text-neg",
  warn: "border-warn text-warn",
  info: "border-info text-info"
};

/** Compact tag. Color is always paired with text (never color alone). */
export function Badge({
  tone = "neutral",
  children,
  className,
  title
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center whitespace-nowrap border-l-2 bg-surface-2/60 px-1.5 py-px font-mono text-label uppercase tracking-[0.06em]",
        toneClass[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** Localized status badge from any backend status string ("settled", "FT", "failed", 1.0…). */
export function StateBadge({
  state,
  className,
  fallback
}: {
  state: StateKey | string | number | null | undefined;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const { t } = useLocale();
  const key = typeof state === "string" && state in STATE_TONE ? (state as StateKey) : normalizeState(state);
  if (!key) return <>{fallback ?? (state === null || state === undefined ? "—" : String(state))}</>;
  return (
    <Badge tone={STATE_TONE[key]} className={className}>
      {t(`state.${key}` as MessageKey)}
    </Badge>
  );
}
