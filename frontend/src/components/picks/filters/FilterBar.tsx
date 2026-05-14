"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import {
  DEFAULT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type FiltersState,
  type DateRangePreset,
} from "./filter-types";
import type { MessageKey } from "@/lib/i18n";

const DATE_PRESETS: DateRangePreset[] = ["24h", "7d", "30d", "90d", "all"];

// Plural overrides for fields whose plural isn't `${field}s`.
const PLURAL_OVERRIDES: Record<string, keyof NonNullable<FilterBarProps["options"]>> = {
  country: "countries",
};

function pluralKey(field: string): keyof NonNullable<FilterBarProps["options"]> {
  return (PLURAL_OVERRIDES[field] ?? (`${field}s` as keyof NonNullable<FilterBarProps["options"]>));
}

const SELECT_CLS =
  "border border-border bg-bg px-2 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none";
const LABEL_CLS = "font-sans text-[10px] uppercase text-text-dim";

interface FilterBarProps {
  fields: Array<
    | "date" | "status" | "model" | "market" | "sport" | "country"
    | "competition" | "selection" | "edge" | "price" | "bookmaker"
  >;
  options?: {
    models?: string[];
    markets?: string[];
    sports?: string[];
    countries?: string[];
    competitions?: string[];
    selections?: string[];
  };
}

export function FilterBar({ fields, options }: FilterBarProps) {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = filtersFromSearchParams(new URLSearchParams(searchParams.toString()));

  function replaceWithQuery(qs: URLSearchParams) {
    const href = `${pathname}?${qs.toString()}`;
    (router.replace as (h: string) => void)(href);
  }

  function update(patch: Partial<FiltersState>) {
    const next = { ...filters, ...patch } as FiltersState;
    const qs = filtersToSearchParams(next);
    const tab = searchParams.get("tab");
    if (tab) qs.set("tab", tab);
    replaceWithQuery(qs);
  }

  function reset() {
    const tab = searchParams.get("tab");
    const qs = new URLSearchParams();
    if (tab) qs.set("tab", tab);
    replaceWithQuery(qs);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border border-border bg-bg p-3 font-mono text-[11px]">
      {fields.includes("date") && (
        <label className="flex items-center gap-2">
          <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.date")}</span>
          <select
            value={filters.datePreset}
            onChange={(e) => update({ datePreset: e.target.value as DateRangePreset })}
            className={SELECT_CLS}
          >
            {DATE_PRESETS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
      {fields.includes("status") && (
        <label className="flex items-center gap-2">
          <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.status")}</span>
          <select
            value={filters.status}
            onChange={(e) => update({ status: e.target.value as FiltersState["status"] })}
            className={SELECT_CLS}
          >
            <option value="settled">settled</option>
            <option value="pending">pending</option>
            <option value="all">all</option>
          </select>
        </label>
      )}
      {(["model","market","sport","country","competition","selection"] as const).map((field) =>
        fields.includes(field) ? (
          <label key={field} className="flex items-center gap-2">
            <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>
              {t(`picks.filter.${field}` as MessageKey)}
            </span>
            <select
              value={(filters[field] ?? [])[0] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                update({ [field]: v ? [v] : undefined } as Partial<FiltersState>);
              }}
              className={SELECT_CLS}
            >
              <option value="">{t("picks.filter.all")}</option>
              {((options?.[pluralKey(field)] ?? []) as string[]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
        ) : null
      )}
      {fields.includes("edge") && (
        <label className="flex items-center gap-2">
          <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.edge")}</span>
          <select
            value={filters.edge ?? ""}
            onChange={(e) => update({ edge: e.target.value || undefined })}
            className={SELECT_CLS}
          >
            <option value="">{t("picks.filter.all")}</option>
            <option value="0-2">0–2%</option>
            <option value="2-5">2–5%</option>
            <option value="5-10">5–10%</option>
            <option value="10-15">10–15%</option>
            <option value="15+">15%+</option>
          </select>
        </label>
      )}
      {fields.includes("price") && (
        <label className="flex items-center gap-2">
          <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.price")}</span>
          <select
            value={filters.price ?? ""}
            onChange={(e) => update({ price: e.target.value || undefined })}
            className={SELECT_CLS}
          >
            <option value="">{t("picks.filter.all")}</option>
            <option value="<=1.5">≤1.5</option>
            <option value="1.5-2">1.5–2</option>
            <option value="2-3">2–3</option>
            <option value="3-5">3–5</option>
            <option value="5+">5+</option>
          </select>
        </label>
      )}
      {fields.includes("bookmaker") && (
        <label className="flex items-center gap-2 opacity-50" title="Per-bookmaker pick recording lands later">
          <span className={LABEL_CLS} style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.bookmaker")}</span>
          <select disabled className={SELECT_CLS}>
            <option>{t("picks.filter.all")}</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={reset}
        className="ml-auto border border-accent px-3 py-1 font-mono text-[11px] text-accent hover:bg-surface"
      >
        {t("picks.filter.reset")}
      </button>
    </div>
  );
}
