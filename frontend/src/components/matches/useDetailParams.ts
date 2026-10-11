"use client";
import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import { asRoute, buildQuery, routes } from "@/lib/routes";

/**
 * Match-detail view state in the URL (?market=&period=&snap=&stats=), so a
 * shared link or Back restores the same market, capture and stats period.
 * Passing null removes a key.
 */
export function useDetailParams(eventId: string) {
  const { locale } = useLocale();
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next: Record<string, string> = {};
      params.forEach((value, key) => {
        next[key] = value;
      });
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") delete next[key];
        else next[key] = value;
      }
      router.replace(asRoute(`${routes.match(locale, eventId)}${buildQuery(next)}`), { scroll: false });
    },
    [params, router, locale, eventId]
  );

  return { get: (key: string) => params.get(key), set };
}
