"use client";

import { useMemo, useState } from "react";
import { EventSearchForm } from "@/components/EventSearchForm";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { MatchStatsTable } from "@/components/MatchStatsTable";
import { OddsTable } from "@/components/OddsTable";
import { useLocale } from "@/contexts/LocaleContext";
import { useMatchStatsData } from "@/hooks/useMatchStatsData";
import { useOddsData } from "@/hooks/useOddsData";

export default function HomePage() {
  const { t, locale } = useLocale();
  const [eventId, setEventId] = useState<string>("");

  const query = useOddsData({
    eventId,
    enabled: Boolean(eventId)
  });
  const statsQuery = useMatchStatsData({
    eventId,
    enabled: Boolean(eventId)
  });

  const { data, error, isLoading, isFetching, dataUpdatedAt } = query;
  const {
    data: statsData,
    error: statsError,
    isLoading: statsLoading,
    isFetching: statsFetching
  } = statsQuery;

  const formattedUpdatedAt = useMemo(() => {
    const explicit = data?.lastUpdated ? new Date(data.lastUpdated) : undefined;
    const derived = dataUpdatedAt ? new Date(dataUpdatedAt) : undefined;
    const target = explicit ?? derived;

    if (!target || Number.isNaN(target.getTime())) {
      return undefined;
    }

    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(target);
  }, [data?.lastUpdated, dataUpdatedAt, locale]);

  const marketCount = data?.markets.length ?? 0;

  return (
    <main className="space-y-8">
      <header className="flex flex-col gap-6 rounded-3xl bg-[color:var(--color-brand-surface-alt)] p-6 shadow-md md:flex-row md:items-start md:justify-between">
        <div className="space-y-3">
          <h1 className="text-3xl font-extrabold text-[color:var(--color-text-high)] md:text-4xl">
            {t("app.title")}
          </h1>
          <p className="max-w-2xl text-base text-[color:var(--color-text-muted)]">{t("app.description")}</p>
        </div>
        <LocaleSwitcher />
      </header>

      <section aria-label="Odds controls" className="space-y-4">
        <EventSearchForm
          initialEventId={eventId}
          onSearch={setEventId}
          isLoading={isLoading || (isFetching && !data)}
        />
        <div className="flex flex-col gap-4 rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-4 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-3 text-sm md:ml-auto">
            {formattedUpdatedAt && (
              <span className="rounded-full bg-[color:var(--color-brand-surface)] px-3 py-1 text-[color:var(--color-text-muted)]">
                {t("timestamp.updated", { time: formattedUpdatedAt })}
              </span>
            )}
            {eventId && data && (
              <span className="rounded-full bg-[color:var(--color-brand-surface)] px-3 py-1 text-[color:var(--color-text-muted)]">
                {t("feedback.summary", { count: marketCount })}
              </span>
            )}
          </div>
        </div>
      </section>

      {eventId && (
        <section aria-live="polite" aria-busy={statsLoading || (statsFetching && !statsData)} className="space-y-4">
          <h2 className="text-2xl font-bold text-[color:var(--color-text-high)]">{t("stats.title")}</h2>
          {statsLoading && (
            <div className="rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-text-muted)]">
              {t("feedback.statsLoading")}
            </div>
          )}
          {statsError && (
            <div
              role="alert"
              className="rounded-3xl border border-[color:var(--color-danger)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-danger)]"
            >
              {t("feedback.statsError")}
            </div>
          )}
          {statsData && <MatchStatsTable summary={statsData} />}
        </section>
      )}

      <section aria-live="polite" aria-busy={isLoading} className="space-y-4">
        {isLoading && (
          <div className="rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-text-muted)]">
            {t("feedback.loading")}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-3xl border border-[color:var(--color-danger)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-danger)]"
          >
            {t("feedback.error")}
          </div>
        )}
        {data && <OddsTable summary={data} />}
      </section>
    </main>
  );
}
