"use client";

import { FormEvent, useId, useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";

interface EventSearchFormProps {
  initialEventId?: string;
  onSearch: (eventId: string) => void;
  isLoading?: boolean;
}

export function EventSearchForm({ initialEventId = "", onSearch, isLoading = false }: EventSearchFormProps) {
  const { t } = useLocale();
  const [value, setValue] = useState(initialEventId);
  const controlId = useId();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();

    if (trimmed) {
      onSearch(trimmed);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-4 shadow-sm"
      noValidate
      aria-describedby={`${controlId}-hint`}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <div className="flex-1 space-y-2">
          <label htmlFor={controlId} className="text-sm font-semibold text-[color:var(--color-text-high)]">
            {t("search.label")}
          </label>
          <input
            id={controlId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className={clsx(
              "w-full rounded-2xl border px-4 py-3 text-base", 
              "border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-accent)]"
            )}
            aria-label={t("search.aria")}
            placeholder={t("search.placeholder")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={clsx(
            "inline-flex items-center justify-center rounded-2xl px-6 py-3 text-base font-semibold text-[color:var(--color-text-inverse)]", 
            "bg-[color:var(--color-brand-primary)] transition hover:bg-[color:var(--color-brand-accent)]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-secondary)]",
            isLoading && "cursor-progress opacity-80"
          )}
          disabled={isLoading}
        >
          {t("search.cta")}
        </button>
      </div>
      <p id={`${controlId}-hint`} className="text-sm text-[color:var(--color-text-muted)]">
        {t("search.support")}
      </p>
    </form>
  );
}
