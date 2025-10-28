"use client";

import { useId } from "react";
import { useLocale, locales } from "@/contexts/LocaleContext";
import type { MessageKey } from "@/lib/i18n";
import { clsx } from "clsx";

export function LocaleSwitcher() {
  const controlId = useId();
  const { locale, setLocale, t } = useLocale();

  return (
    <div className="flex items-center gap-2" role="group" aria-labelledby={`${controlId}-label`}>
      <span id={`${controlId}-label`} className="text-sm font-medium text-[color:var(--color-text-muted)]">
        {t("locale.switcher")}
      </span>
      <select
        id={controlId}
        className={clsx(
          "rounded-full border px-3 py-1 text-sm", 
          "border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)]",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-accent)]"
        )}
        value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
      >
        {locales.map((value) => (
          <option key={value} value={value}>
            {t(`locale.${value}` as MessageKey)}
          </option>
        ))}
      </select>
    </div>
  );
}
