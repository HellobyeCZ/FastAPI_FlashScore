"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "@/contexts/LocaleContext";
import { ApiError, appGet } from "@/lib/api/http";
import type { MessageKey } from "@/lib/i18n";
import type { TodayErrorCode, TodayResponse } from "@/components/today/types";

/** Copy shown in place of the route's generic English error messages. */
const ERROR_COPY = new Map<string, MessageKey>([
  ["today_db_busy", "today.error.busy"],
  ["today_query_failed", "today.error.failed"]
] satisfies [TodayErrorCode, MessageKey][]);

/** IANA zone of the browser, or its UTC offset in minutes when Intl can't tell. */
function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // very old engines: fall through to the offset
  }
  return String(new Date().getTimezoneOffset());
}

export const todayKey = (tz: string) => ["today", tz] as const;

/** GET /api/today for the viewer's local day (see components/today/types). */
export function useToday() {
  const { t } = useLocale();
  // Lazy initial state runs again on the client during hydration, so the
  // query always carries the viewer's zone (it never fetches on the server).
  const [tz] = useState(browserTimeZone);
  return useQuery({
    queryKey: todayKey(tz),
    queryFn: async () => {
      try {
        return await appGet<TodayResponse>("today", { tz });
      } catch (err) {
        const copy = err instanceof ApiError ? ERROR_COPY.get(err.code) : undefined;
        if (err instanceof ApiError && copy) throw new ApiError(err.status, err.code, t(copy));
        throw err;
      }
    },
    staleTime: 60_000
  });
}
