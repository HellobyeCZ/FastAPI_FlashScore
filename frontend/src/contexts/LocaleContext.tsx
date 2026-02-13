"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { defaultLocale, formatMessage, isLocale, type Locale, type MessageKey } from "@/lib/i18n";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function extractLocaleFromPath(pathname: string | null): Locale | null {
  if (!pathname) {
    return null;
  }

  const [segment] = pathname.split("/").filter(Boolean);
  return segment && isLocale(segment) ? segment : null;
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [locale, setLocale] = useState<Locale>(() => extractLocaleFromPath(pathname) ?? defaultLocale);

  useEffect(() => {
    const localeFromPath = extractLocaleFromPath(pathname);
    if (localeFromPath && localeFromPath !== locale) {
      setLocale(localeFromPath);
    }
  }, [locale, pathname]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const translate = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) =>
      formatMessage(locale, key, values),
    [locale]
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t: translate
    }),
    [locale, translate]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useLocale must be used within a LocaleProvider");
  }

  return context;
}
