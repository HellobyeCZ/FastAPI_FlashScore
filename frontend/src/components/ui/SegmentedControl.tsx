"use client";
import { useRef } from "react";
import { clsx } from "clsx";

export type SegmentOption<V extends string> = {
  value: V;
  label: React.ReactNode;
  /** Optional count/badge shown after the label. */
  hint?: React.ReactNode;
  disabled?: boolean;
};

/**
 * Mutually exclusive choice (radiogroup semantics, arrow-key navigation).
 * Use for small option sets: data source, time window, edge threshold.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
  className
}: {
  /** Accessible name; also rendered as a visible label unless `label` is hidden by the caller. */
  label: string;
  value: V;
  options: SegmentOption<V>[];
  onChange: (value: V) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  function move(delta: number) {
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + delta + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    const el = refs.current[options.indexOf(next)];
    el?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx("inline-flex items-stretch border border-border-strong", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              "inline-flex items-center gap-1.5 border-r border-border-strong font-mono uppercase tracking-[0.06em] last:border-r-0",
              "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              size === "sm" ? "h-7 px-2.5 text-label" : "h-8 px-3 text-meta",
              selected ? "bg-accent text-accent-ink" : "text-text-dim hover:bg-surface-2 hover:text-text"
            )}
          >
            {o.label}
            {o.hint !== undefined && (
              <span className={clsx("tabular-nums", selected ? "text-accent-ink/70" : "text-text-faint")}>
                {o.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
