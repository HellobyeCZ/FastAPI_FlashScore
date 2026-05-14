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
  runId?: string,
): FacetsResponse {
  const [data, setData] = useState<FacetsResponse>(EMPTY);

  useEffect(() => {
    if (source !== "live" && !runId) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ source });
    if (runId) qs.set("run_id", runId);
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
  }, [source, runId]);

  return data;
}
