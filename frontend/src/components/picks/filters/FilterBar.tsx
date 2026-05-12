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

interface FilterBarProps {
  // Filters to render. Pass an empty array to render none (used by Health
  // tab which has no filter bar).
  fields: Array<
    | "date" | "status" | "model" | "market" | "sport" | "country"
    | "competition" | "selection" | "edge" | "price" | "bookmaker"
  >;
  // Known option lists for multi-select dropdowns. Caller pulls these
  // from a stats query (e.g. distinct models across the dataset).
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

  // Next.js 14 typedRoutes is enabled; router.replace expects a typed
  // Route. Querystring-suffixed paths are dynamic and not statically
  // typeable, so we widen to Parameters<typeof router.replace>[0] via a
  // pass-through helper.
  function replaceWithQuery(qs: URLSearchParams) {
    const href = `${pathname}?${qs.toString()}`;
    (router.replace as (h: string) => void)(href);
  }

  function update(patch: Partial<FiltersState>) {
    const next = { ...filters, ...patch } as FiltersState;
    const qs = filtersToSearchParams(next);
    // Preserve any non-filter params (currently just ?tab).
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
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-3 text-sm">
      {fields.includes("date") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.date")}</span>
          <select
            value={filters.datePreset}
            onChange={(e) => update({ datePreset: e.target.value as DateRangePreset })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
      {fields.includes("status") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.status")}</span>
          <select
            value={filters.status}
            onChange={(e) => update({ status: e.target.value as FiltersState["status"] })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            <option value="settled">settled</option>
            <option value="pending">pending</option>
            <option value="all">all</option>
          </select>
        </label>
      )}
      {(["model","market","sport","country","competition","selection"] as const).map((field) =>
        fields.includes(field) ? (
          <label key={field} className="flex items-center gap-1">
            <span className="text-xs text-[color:var(--color-text-muted)]">
              {t(`picks.filter.${field}` as MessageKey)}
            </span>
            <select
              value={(filters[field] ?? [])[0] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                update({ [field]: v ? [v] : undefined } as Partial<FiltersState>);
              }}
              className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
            >
              <option value="">{t("picks.filter.all")}</option>
              {((options?.[`${field}s` as keyof typeof options] ?? []) as string[]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
        ) : null
      )}
      {fields.includes("edge") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.edge")}</span>
          <select
            value={filters.edge ?? ""}
            onChange={(e) => update({ edge: e.target.value || undefined })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
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
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.price")}</span>
          <select
            value={filters.price ?? ""}
            onChange={(e) => update({ price: e.target.value || undefined })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
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
        <label className="flex items-center gap-1 opacity-50" title="Per-bookmaker pick recording lands later">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.bookmaker")}</span>
          <select disabled className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1">
            <option>{t("picks.filter.all")}</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={reset}
        className="ml-auto rounded-xl bg-[color:var(--color-brand-primary)] px-3 py-1.5 text-xs font-semibold text-[color:var(--color-text-inverse)]"
      >
        {t("picks.filter.reset")}
      </button>
    </div>
  );
}
