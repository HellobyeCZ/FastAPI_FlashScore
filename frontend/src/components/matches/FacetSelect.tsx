"use client";
import { useEffect, useId, useRef, useState } from "react";
import { clsx } from "clsx";
import { Button, Input } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";

export type FacetOption = { value: string; label: string; count: number | null };

/** Popover width in px (w-72). */
const PANEL_WIDTH = 288;
const SEARCHABLE_FROM = 10;

/** Checkbox list for one facet. Shared by the desktop popover and the mobile filter dialog. */
export function FacetOptions({
  legend,
  options,
  selected,
  onChange,
  legendVisible,
  className
}: {
  legend: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  legendVisible?: boolean;
  className?: string;
}) {
  const { t, fmt } = useLocale();
  const [filter, setFilter] = useState("");
  const searchable = options.length >= SEARCHABLE_FROM;
  const needle = filter.trim().toLowerCase();
  const visible = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  function toggle(value: string, on: boolean) {
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));
  }

  return (
    <fieldset className={clsx("min-w-0", className)}>
      <legend
        className={clsx(legendVisible ? "mb-2 font-sans text-label uppercase tracking-label text-text-dim" : "sr-only")}
      >
        {legend}
      </legend>
      {searchable && (
        <Input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("matches.facets.filter")}
          aria-label={t("matches.facets.filterAria", { facet: legend })}
          className="mb-1 h-8 w-full"
        />
      )}
      <ul className="max-h-64 overflow-y-auto">
        {visible.map((o) => {
          const checked = selected.includes(o.value);
          return (
            <li key={o.value}>
              <label className="flex min-h-8 cursor-pointer items-center gap-2 px-2 py-1 text-body text-text hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--accent))]"
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count !== null && (
                  <span className="shrink-0 font-mono text-meta tabular-nums text-text-faint">
                    <span className="sr-only">{t("matches.facets.countAria")} </span>
                    {fmt.int(o.count)}
                  </span>
                )}
              </label>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-2 py-2 text-meta text-text-faint">{t("matches.facets.noOptions")}</li>
        )}
      </ul>
    </fieldset>
  );
}

/**
 * Compact multi-select for desktop toolbars: a button showing how many values
 * are chosen, opening a checkbox list. Escape or a click outside closes it and
 * returns focus to the button.
 */
export function FacetSelect({
  label,
  options,
  selected,
  onChange,
  note
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  note?: string;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  function toggleOpen() {
    const rect = triggerRef.current?.getBoundingClientRect();
    // Keep the panel inside the viewport when the button sits near the right edge.
    if (rect) setAlignRight(rect.left + PANEL_WIDTH > window.innerWidth - 16);
    setOpen((v) => !v);
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <Button
        ref={triggerRef}
        size="sm"
        variant="secondary"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggleOpen}
        className={clsx(selected.length > 0 && "border-accent text-accent")}
      >
        {label}
        {selected.length > 0 && (
          <span className="tabular-nums">
            · {selected.length}
            <span className="sr-only"> {t("matches.facets.selected")}</span>
          </span>
        )}
        <span aria-hidden className="text-text-dim">
          ▾
        </span>
      </Button>
      {open && (
        <div
          id={panelId}
          className={clsx(
            "absolute top-full z-30 mt-1 w-72 border border-border-strong bg-surface p-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]",
            alignRight ? "right-0" : "left-0"
          )}
        >
          <FacetOptions legend={label} options={options} selected={selected} onChange={onChange} />
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border px-2 pt-1.5">
            <span className="text-meta text-text-faint">{note}</span>
            {selected.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onChange([])}>
                {t("common.clear")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
