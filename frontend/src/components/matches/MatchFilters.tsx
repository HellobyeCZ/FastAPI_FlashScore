"use client";
import { useCallback, useMemo, useState } from "react";
import { Button, Dialog } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import type { MessageKey } from "@/lib/i18n";
import { countryLabel, sportLabel } from "@/lib/matches/display";
import { FACET_KEYS, activeFilterCount, type FacetKey, type MatchesUrlState } from "@/lib/matches/url";
import { MATCH_BETS_KINDS, MATCH_STATUS_KINDS, type MatchFacets } from "@/types/scraped-matches";
import { FacetOptions, FacetSelect, type FacetOption } from "./FacetSelect";

type Patch = Partial<MatchesUrlState>;

/** Human label for one facet value (sport/country/status/bets need translating or casing). */
export function useFacetValueLabel() {
  const { t } = useLocale();
  return useCallback(
    (key: FacetKey, value: string): string => {
      switch (key) {
        case "sport":
          return sportLabel(value, t);
        case "country":
          return countryLabel(value);
        case "status":
          return t(`matches.status.${value}` as MessageKey);
        case "bets":
          return t(`matches.betsFilter.${value}` as MessageKey);
        default:
          return value;
      }
    },
    [t]
  );
}

/**
 * Options per facet from the server counts. Status and bets always list every
 * value in a fixed order; selected values missing from the counts stay
 * visible (count 0) so they can be unticked.
 */
function useFacetOptions(state: MatchesUrlState, facets: MatchFacets | undefined): Record<FacetKey, FacetOption[]> {
  const label = useFacetValueLabel();
  return useMemo(() => {
    const out = {} as Record<FacetKey, FacetOption[]>;
    for (const key of FACET_KEYS) {
      const counts = new Map((facets?.[key] ?? []).map((f) => [f.value, f.count]));
      const fixed: readonly string[] | null =
        key === "status" ? MATCH_STATUS_KINDS : key === "bets" ? MATCH_BETS_KINDS : null;
      const values = fixed
        ? [...fixed]
        : Array.from(new Set([...(facets?.[key] ?? []).map((f) => f.value), ...state[key]]));
      out[key] = values.map((value) => ({
        value,
        label: label(key, value),
        count: facets ? (counts.get(value) ?? 0) : null
      }));
    }
    return out;
    // Selected lists are joined so the deps stay primitive (sanctioned pattern, see CLAUDE.md).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, label, state.sport.join(","), state.country.join(","), state.league.join(","), state.status.join(","), state.bets.join(",")]);
}

const FACET_LABEL: Record<FacetKey, MessageKey> = {
  sport: "matches.facet.sport",
  country: "matches.facet.country",
  league: "matches.facet.league",
  status: "matches.facet.status",
  bets: "matches.facet.bets"
};

/** Desktop: one compact multi-select per facet. Mobile: a "Filters" button opening a dialog. */
export function MatchFilters({
  state,
  facets,
  total,
  onChange
}: {
  state: MatchesUrlState;
  facets: MatchFacets | undefined;
  total: number | undefined;
  onChange: (patch: Patch) => void;
}) {
  const { t, tp, fmt } = useLocale();
  const [open, setOpen] = useState(false);
  const options = useFacetOptions(state, facets);
  const active = activeFilterCount(state);
  const clearAll: Patch = { sport: [], country: [], league: [], status: [], bets: [] };

  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        {FACET_KEYS.map((key) => (
          <FacetSelect
            key={key}
            label={t(FACET_LABEL[key])}
            options={options[key]}
            selected={state[key]}
            onChange={(next) => onChange({ [key]: next })}
            note={t("matches.facets.countsNote")}
          />
        ))}
      </div>
      <Button size="md" className="md:hidden" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {t("common.filters")}
        {active > 0 && <span className="tabular-nums text-accent">· {active}</span>}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("matches.filters.title")}
        description={t("matches.facets.countsNote")}
        footer={
          <>
            <Button variant="ghost" onClick={() => onChange(clearAll)} disabled={active === 0}>
              {t("matches.filters.clearAll")}
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              {total === undefined ? t("common.close") : tp("matches.filters.show", total, { count: fmt.int(total) })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {FACET_KEYS.map((key) => (
            <FacetOptions
              key={key}
              legend={t(FACET_LABEL[key])}
              legendVisible
              options={options[key]}
              selected={state[key]}
              onChange={(next) => onChange({ [key]: next })}
            />
          ))}
        </div>
      </Dialog>
    </>
  );
}

/** Removable chips for every active facet value, plus "Clear all". */
export function ActiveFilters({ state, onChange }: { state: MatchesUrlState; onChange: (patch: Patch) => void }) {
  const { t } = useLocale();
  const label = useFacetValueLabel();
  if (activeFilterCount(state) === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("matches.filters.active")}>
      {FACET_KEYS.flatMap((key) =>
        state[key].map((value) => {
          const text = `${t(FACET_LABEL[key])}: ${label(key, value)}`;
          return (
            <li key={`${key}:${value}`}>
              <button
                type="button"
                onClick={() => onChange({ [key]: state[key].filter((v) => v !== value) })}
                aria-label={t("matches.filters.remove", { filter: text })}
                className="inline-flex h-7 items-center gap-1.5 border border-border-strong bg-surface-2/60 px-2 text-meta text-text hover:border-text-dim"
              >
                <span className="max-w-[16rem] truncate">{text}</span>
                <span aria-hidden className="text-text-dim">
                  ×
                </span>
              </button>
            </li>
          );
        })
      )}
      <li>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ sport: [], country: [], league: [], status: [], bets: [] })}
        >
          {t("matches.filters.clearAll")}
        </Button>
      </li>
    </ul>
  );
}
