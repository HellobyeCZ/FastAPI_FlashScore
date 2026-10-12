"use client";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { marketLabel, modelLabel, selectionLabel } from "@/lib/labels";
import {
  activeFilterCount,
  competitionRoots,
  isPlausibleDay,
  WINDOW_PRESETS,
  type FilterKey,
  type PerfFilters,
  type WindowPreset
} from "@/lib/performance/filters";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import type { MessageKey } from "@/lib/i18n";
import { Button, Field, Input, Label, SegmentedControl, Select } from "@/components/ui";

/**
 * Filter bar shared by the Performance pages. Every control writes the URL
 * (via `state.update`), and every panel on the page reads the same query.
 * Below `md` the field grid folds behind a "Filters" toggle so results stay on
 * the first screen; the window control is always visible.
 */
export function FilterBar({ state }: { state: PerformanceFilterState }) {
  const { t } = useLocale();
  const { filters, keys, facets } = state;
  const [open, setOpen] = useState(false);
  const fieldsId = useId();
  const active = activeFilterCount(filters, keys);
  const windowValue: WindowPreset = state.window;

  const options = (values: string[] | undefined, label: (v: string) => string, current: string | null) => {
    const list = [...(values ?? [])];
    if (current && !list.includes(current)) list.push(current);
    return list.map((v) => ({ value: v, label: label(v) }));
  };

  const selects: { key: FilterKey; label: MessageKey; items: { value: string; label: string }[] }[] = [];
  if (keys.includes("market")) {
    selects.push({
      key: "market",
      label: "performance.filter.market",
      items: options(facets.data?.markets, (m) => marketLabel(m, t), filters.market)
    });
  }
  if (keys.includes("competition")) {
    selects.push({
      key: "competition",
      label: "performance.filter.competition",
      items: options(competitionRoots(facets.data), (c) => c, filters.competition)
    });
  }
  if (keys.includes("model")) {
    selects.push({
      key: "model",
      label: "performance.filter.model",
      items: options(facets.data?.models, (m) => modelLabel(m, t), filters.model)
    });
  }
  if (keys.includes("selection")) {
    selects.push({
      key: "selection",
      label: "performance.filter.selection",
      items: options(facets.data?.selections, (s) => selectionLabel(s, t), filters.selection)
    });
  }
  const ranges = keys.includes("edgeMin") || keys.includes("priceMin");

  return (
    <div className="mb-5 flex flex-col gap-3 border border-border bg-surface/60 p-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <Label as="span">{t("performance.window.label")}</Label>
          <SegmentedControl
            label={t("performance.window.label")}
            value={windowValue}
            onChange={(w) => state.update({ window: w, ...(w === "custom" ? {} : { from: null, to: null }) })}
            options={WINDOW_PRESETS.map((w) => ({ value: w, label: t(`performance.window.${w}` as MessageKey) }))}
            size="sm"
          />
        </div>
        {windowValue === "custom" && (
          <div className="flex gap-3">
            <DateField
              label={t("performance.window.from")}
              value={filters.from}
              max={filters.to}
              onCommit={(from) => state.update({ window: "custom", from })}
            />
            <DateField
              label={t("performance.window.to")}
              value={filters.to}
              min={filters.from}
              onCommit={(to) => state.update({ window: "custom", to })}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {active > 0 && (
            <Button size="sm" variant="ghost" onClick={state.clearFilters}>
              {t("performance.filter.clear")}
            </Button>
          )}
          <Button
            size="sm"
            className="md:hidden"
            aria-expanded={open}
            aria-controls={fieldsId}
            onClick={() => setOpen((v) => !v)}
          >
            {active > 0 ? t("performance.filter.toggleActive", { n: active }) : t("performance.filter.toggle")}
          </Button>
        </div>
      </div>

      <div
        id={fieldsId}
        className={clsx(
          "grid-cols-2 gap-3 sm:grid-cols-3",
          ranges ? "lg:grid-cols-6" : "lg:grid-cols-4",
          open ? "grid" : "hidden md:grid"
        )}
      >
        {selects.map((s) => (
          <Field key={s.key} label={t(s.label)} className="min-w-0">
            {(p) => (
              <Select
                {...p}
                value={(filters[s.key] as string | null) ?? ""}
                onChange={(e) => state.update({ [s.key]: e.target.value || null } as Partial<PerfFilters>)}
                className="w-full"
              >
                <option value="">{t("performance.filter.any")}</option>
                {s.items.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ))}
        {keys.includes("edgeMin") && (
          <RangeField
            label={t("performance.filter.edge")}
            unit={t("performance.filter.edgeUnit")}
            min={filters.edgeMin}
            max={filters.edgeMax}
            step={0.5}
            onCommit={(edgeMin, edgeMax) => state.update({ edgeMin, edgeMax })}
          />
        )}
        {keys.includes("priceMin") && (
          <RangeField
            label={t("performance.filter.price")}
            min={filters.priceMin}
            max={filters.priceMax}
            step={0.1}
            onCommit={(priceMin, priceMax) => state.update({ priceMin, priceMax })}
          />
        )}
      </div>

      {facets.isError && (
        <p className="flex flex-wrap items-center gap-2 text-meta text-warn">
          <span aria-hidden>△</span>
          {t("performance.filter.optionsError")}
          <Button size="sm" variant="ghost" onClick={() => void facets.refetch()} loading={facets.isFetching}>
            {t("common.retry")}
          </Button>
        </p>
      )}
    </div>
  );
}

/**
 * Custom-window bound. The input keeps a local draft: a date input reports
 * every edited segment (and years such as 0002 while one is typed), so only a
 * complete, plausible day reaches the URL. Clearing applies on blur or Enter.
 */
function DateField({
  label,
  value,
  min,
  max,
  onCommit
}: {
  label: string;
  value: string | null;
  min?: string | null;
  max?: string | null;
  onCommit: (day: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Follow URL changes (back/forward, "show all time") without remounting,
  // which would drop focus mid-edit.
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value ?? "");
  }
  const commit = (input: HTMLInputElement) => {
    // A half-typed date reads as "" with badInput set: keep the applied day.
    if (input.validity.badInput || (draft !== "" && !isPlausibleDay(draft))) setDraft(value ?? "");
    else if (draft === "" && value !== null) onCommit(null);
    else if (draft !== "" && draft !== value) onCommit(draft);
  };
  return (
    <Field label={label}>
      {(p) => (
        <Input
          {...p}
          type="date"
          value={draft}
          min={min ?? undefined}
          max={max ?? undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (isPlausibleDay(e.target.value) && e.target.value !== value) onCommit(e.target.value);
          }}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget);
          }}
          className="w-36"
        />
      )}
    </Field>
  );
}

/**
 * Min/max pair. Typing stays local; the URL (and the queries) change on blur
 * or Enter so every keystroke doesn't refetch the page.
 */
function RangeField({
  label,
  unit,
  min,
  max,
  step,
  onCommit
}: {
  label: string;
  unit?: string;
  min: number | null;
  max: number | null;
  step: number;
  onCommit: (min: number | null, max: number | null) => void;
}) {
  const { t } = useLocale();
  // Re-key on URL changes so the drafts reset to the committed values.
  return (
    <fieldset key={`${min}:${max}`} className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 font-sans text-label uppercase tracking-label text-text-dim">
        {label}
        {unit && <span className="normal-case tracking-normal text-text-faint"> ({unit})</span>}
      </legend>
      <RangeInputs min={min} max={max} step={step} onCommit={onCommit} minLabel={t("performance.filter.min")} maxLabel={t("performance.filter.max")} />
    </fieldset>
  );
}

function RangeInputs({
  min,
  max,
  step,
  onCommit,
  minLabel,
  maxLabel
}: {
  min: number | null;
  max: number | null;
  step: number;
  onCommit: (min: number | null, max: number | null) => void;
  minLabel: string;
  maxLabel: string;
}) {
  const [draftMin, setDraftMin] = useState(min === null ? "" : String(min));
  const [draftMax, setDraftMax] = useState(max === null ? "" : String(max));
  const parse = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const commit = () => {
    const nextMin = parse(draftMin);
    const nextMax = parse(draftMax);
    if (nextMin !== min || nextMax !== max) onCommit(nextMin, nextMax);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
  };
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        aria-label={minLabel}
        placeholder={minLabel}
        value={draftMin}
        onChange={(e) => setDraftMin(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="w-full"
      />
      <span aria-hidden className="text-text-faint">
        –
      </span>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        aria-label={maxLabel}
        placeholder={maxLabel}
        value={draftMax}
        onChange={(e) => setDraftMax(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="w-full"
      />
    </div>
  );
}
