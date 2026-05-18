"use client";

import { useEffect, useState } from "react";

export type FacetsResponse = {
  models: string[];
  markets: string[];
  sports: string[];
  countries: string[];
  competitions: string[];
  selections: string[];
};

const EMPTY: FacetsResponse = {
  models: [],
  markets: [],
  sports: [],
  countries: [],
  competitions: [],
  selections: [],
};

export function usePicksFacets(
  source: "live" | "backtest" | "both",
  runIds?: string | string[],
): FacetsResponse {
  const [data, setData] = useState<FacetsResponse>(EMPTY);
  const ids = Array.isArray(runIds) ? runIds.filter(Boolean) : runIds ? [runIds] : [];
  const idsKey = ids.join(",");

  useEffect(() => {
    if (source !== "live" && ids.length === 0) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ source });
    if (ids.length === 1) qs.set("run_id", ids[0]);
    else if (ids.length > 1) qs.set("run_ids", idsKey);
    fetch(`/api/picks/facets?${qs.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : EMPTY))
      .then((j) => {
        if (!cancelled) setData(j as FacetsResponse);
      })
      .catch(() => {
        if (!cancelled) setData(EMPTY);
      });
    return () => {
      cancelled = true;
    };
    // ids is derived from runIds; idsKey carries its identity for the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, idsKey]);

  return data;
}
