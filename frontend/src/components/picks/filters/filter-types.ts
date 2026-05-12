// FiltersState shape + URL serialization. Single source of truth.

export type DateRangePreset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

export type FiltersState = {
  status: "settled" | "pending" | "all";
  datePreset: DateRangePreset;
  dateFrom?: string;
  dateTo?: string;
  model?: string[];
  market?: string[];
  sport?: string[];
  country?: string[];
  competition?: string[];
  selection?: string[];
  edge?: string;       // bucket label e.g. "5-10"
  price?: string;      // bucket label e.g. "1.5-2"
};

export const DEFAULT_FILTERS: FiltersState = {
  status: "settled",
  datePreset: "90d",
};

export function filtersFromSearchParams(
  params: URLSearchParams,
): FiltersState {
  const get = (k: string) => params.get(k) ?? undefined;
  const getList = (k: string) => {
    const v = params.get(k);
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  };
  return {
    status: (get("status") as FiltersState["status"]) ?? DEFAULT_FILTERS.status,
    datePreset:
      (get("date") as DateRangePreset | undefined) ?? DEFAULT_FILTERS.datePreset,
    dateFrom: get("date_from"),
    dateTo: get("date_to"),
    model: getList("model"),
    market: getList("market"),
    sport: getList("sport"),
    country: getList("country"),
    competition: getList("competition"),
    selection: getList("selection"),
    edge: get("edge"),
    price: get("price"),
  };
}

export function filtersToSearchParams(
  filters: FiltersState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== DEFAULT_FILTERS.status) params.set("status", filters.status);
  if (filters.datePreset !== DEFAULT_FILTERS.datePreset) params.set("date", filters.datePreset);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.model?.length) params.set("model", filters.model.join(","));
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.sport?.length) params.set("sport", filters.sport.join(","));
  if (filters.country?.length) params.set("country", filters.country.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  if (filters.selection?.length) params.set("selection", filters.selection.join(","));
  if (filters.edge) params.set("edge", filters.edge);
  if (filters.price) params.set("price", filters.price);
  return params;
}

export function presetToDateRange(
  preset: DateRangePreset,
): { dateFrom?: string; dateTo?: string } {
  if (preset === "all" || preset === "custom") return {};
  const now = new Date();
  const ms = { "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, "90d": 90 * 86400e3 }[preset];
  const from = new Date(now.getTime() - ms);
  return { dateFrom: from.toISOString() };
}

export function edgeBucketToRange(bucket: string): { edgeMin?: number; edgeMax?: number } {
  switch (bucket) {
    case "0-2": return { edgeMin: 0, edgeMax: 0.02 };
    case "2-5": return { edgeMin: 0.02, edgeMax: 0.05 };
    case "5-10": return { edgeMin: 0.05, edgeMax: 0.10 };
    case "10-15": return { edgeMin: 0.10, edgeMax: 0.15 };
    case "15+": return { edgeMin: 0.15 };
    default: return {};
  }
}

export function priceBucketToRange(bucket: string): { priceMin?: number; priceMax?: number } {
  switch (bucket) {
    case "<=1.5": return { priceMax: 1.5 };
    case "1.5-2": return { priceMin: 1.5, priceMax: 2.0 };
    case "2-3": return { priceMin: 2.0, priceMax: 3.0 };
    case "3-5": return { priceMin: 3.0, priceMax: 5.0 };
    case "5+": return { priceMin: 5.0 };
    default: return {};
  }
}
