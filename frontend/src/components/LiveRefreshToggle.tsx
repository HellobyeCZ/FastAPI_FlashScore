"use client";

import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";

interface LiveRefreshToggleProps {
  active: boolean;
  secondsRemaining: number;
  onToggle: (next: boolean) => void;
}

export function LiveRefreshToggle({ active, secondsRemaining, onToggle }: LiveRefreshToggleProps) {
  const { t } = useLocale();

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-[color:var(--color-text-muted)]">{t("refresh.label")}</span>
      <button
        type="button"
        className={clsx(
          "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold",
          active
            ? "border-[color:var(--color-brand-accent)] bg-[color:var(--color-brand-accent)] text-[color:var(--color-text-inverse)]"
            : "border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] text-[color:var(--color-text-high)]",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-primary)]"
        )}
        aria-pressed={active}
        onClick={() => onToggle(!active)}
      >
        <span
          className={clsx(
            "inline-block h-2 w-2 rounded-full",
            active ? "bg-[color:var(--color-success)]" : "bg-[color:var(--color-text-muted)]"
          )}
          aria-hidden
        />
        <span>{active ? t("refresh.on") : t("refresh.off")}</span>
      </button>
      <p className="text-xs text-[color:var(--color-text-muted)]">
        {t("refresh.next", { seconds: Math.max(secondsRemaining, 0) })}
      </p>
    </div>
  );
}
