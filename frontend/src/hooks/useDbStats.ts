"use client";
import { useQuery } from "@tanstack/react-query";

type DbStats =
  | { ok: true; rows: number; odds: number; stats: number }
  | { ok: false; error: string };

export function useDbStats() {
  return useQuery<DbStats>({
    queryKey: ["db-stats"],
    queryFn: async () => {
      const r = await fetch("/api/db-stats");
      if (!r.ok) throw new Error(`db-stats ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });
}
