"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  defaultLocale,
  formatMessage,
  formatPlural,
  isLocale,
  switchLocalePath,
  type Locale,
  type MessageKey,
  type MessageValues,
  type PluralKey
} from "@/lib/i18n";
import { makeFormatters, type Formatters } from "@/lib/format";

type LocaleContextValue = {
  locale: Locale;
  /** Navigates to the same page in another locale (URL is the source of truth). */
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
  tp: (base: PluralKey, count: number, values?: MessageValues) => string;
  fmt: Formatters;
};

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function localeFromPath(pathname: string | null): Locale {
  const segment = pathname?.split("/").filter(Boolean)[0];
  return segment && isLocale(segment) ? segment : defaultLocale;
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = localeFromPath(pathname);

  const setLocale = useCallback(
    (next: Locale) => {
      if (next === locale || !pathname) return;
      const search = typeof window !== "undefined" ? window.location.search : "";
      try {
        document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // cookie is a convenience for "/" redirects only
      }
      router.push(`${switchLocalePath(pathname, next)}${search}` as Parameters<typeof router.push>[0]);
    },
    [locale, pathname, router]
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => formatMessage(locale, key, values),
      tp: (base, count, values) => formatPlural(locale, base, count, values),
      fmt: makeFormatters(locale)
    }),
    [locale, setLocale]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used within a LocaleProvider");
  return context;
}
