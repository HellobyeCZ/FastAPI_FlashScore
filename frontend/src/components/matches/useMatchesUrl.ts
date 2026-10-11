"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import { matchesQuery, parseMatchesUrl, type MatchesUrlState } from "@/lib/matches/url";
import { routes } from "@/lib/routes";

function queryOf(href: string): string {
  return new URLSearchParams(href.split("?")[1] ?? "").toString();
}

/**
 * Matches-list state backed by the URL. Changes are applied optimistically so
 * a ticked checkbox reacts at once and quick successive changes build on each
 * other instead of on a URL that has not caught up yet; the optimistic copy
 * is dropped once the URL matches it, or when the URL moves elsewhere
 * (back/forward).
 */
export function useMatchesUrl() {
  const { locale } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const urlState = useMemo(() => parseMatchesUrl(params), [params]);
  const [optimistic, setOptimistic] = useState<{ state: MatchesUrlState; query: string } | null>(null);
  const requested = useRef(new Set<string>());
  const state = optimistic?.state ?? urlState;
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const current = params.toString();
    setOptimistic((o) => {
      if (o && o.query !== current && requested.current.has(current)) return o; // an earlier change landing
      requested.current.clear();
      return null;
    });
  }, [params]);

  const update = useCallback(
    (patch: Partial<MatchesUrlState>) => {
      const next = { ...latest.current, ...patch };
      const href = routes.matches(locale, matchesQuery(next));
      const query = queryOf(href);
      latest.current = next;
      requested.current.add(query);
      setOptimistic({ state: next, query });
      router.replace(href, { scroll: false });
    },
    [locale, router]
  );

  return { state, update };
}
