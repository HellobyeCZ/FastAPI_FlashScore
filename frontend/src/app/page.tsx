"use client";

import { useEffect, useMemo, useState } from "react";
import { EventSearchForm } from "@/components/EventSearchForm";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { LiveRefreshToggle } from "@/components/LiveRefreshToggle";
import { LiveRegion } from "@/components/LiveRegion";
import { OddsTable } from "@/components/OddsTable";
import { useLocale } from "@/contexts/LocaleContext";
import { useOddsData } from "@/hooks/useOddsData";

const REFRESH_INTERVAL_MS = 15_000;

export default function HomePage() {
  const { t, locale } = useLocale();
  const [eventId, setEventId] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(REFRESH_INTERVAL_MS / 1000);

  const query = useOddsData({
    eventId,
    enabled: Boolean(eventId),
    refetchInterval: autoRefresh ? REFRESH_INTERVAL_MS : false
  });

  const { data, error, isLoading, isFetching, dataUpdatedAt } = query;

  useEffect(() => {
    if (!autoRefresh) {
      setSecondsRemaining(REFRESH_INTERVAL_MS / 1000);
      return;
    }

    setSecondsRemaining(REFRESH_INTERVAL_MS / 1000);
    const timer = window.setInterval(() => {
      setSecondsRemaining((current) => (current <= 1 ? REFRESH_INTERVAL_MS / 1000 : current - 1));
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [autoRefresh, dataUpdatedAt]);

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

  const liveAnnouncement = autoRefresh ? t("a11y.live") : "";
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
          <LiveRefreshToggle
            active={autoRefresh}
            secondsRemaining={secondsRemaining}
            onToggle={setAutoRefresh}
          />
          <div className="flex flex-wrap items-center gap-3 text-sm">
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
        <LiveRegion message={liveAnnouncement} />
      </section>
    </main>
  );
}
