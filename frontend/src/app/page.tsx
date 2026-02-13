"use client";

import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { EventSearchForm } from "@/components/EventSearchForm";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { MatchStatsTable } from "@/components/MatchStatsTable";
import { OddsTable } from "@/components/OddsTable";
import { BulkScrapePanel } from "@/components/BulkScrapePanel";
import { ScrapedMatchesMenu } from "@/components/ScrapedMatchesMenu";
import { useLocale } from "@/contexts/LocaleContext";
import { useMatchStatsData } from "@/hooks/useMatchStatsData";
import { useOddsData } from "@/hooks/useOddsData";
import { useScrapedMatchesData } from "@/hooks/useScrapedMatchesData";

type HomeTab = "live" | "saved";

export default function HomePage() {
  const { t, locale } = useLocale();
  const [activeTab, setActiveTab] = useState<HomeTab>("live");
  const [eventId, setEventId] = useState<string>("");

  const query = useOddsData({
    eventId,
    enabled: activeTab === "live" && Boolean(eventId)
  });
  const statsQuery = useMatchStatsData({
    eventId,
    enabled: activeTab === "live" && Boolean(eventId)
  });
  const savedQuery = useScrapedMatchesData({
    enabled: activeTab === "saved"
  });

  const { data, error, isLoading, isFetching, dataUpdatedAt } = query;
  const {
    data: statsData,
    error: statsError,
    isLoading: statsLoading,
    isFetching: statsFetching
  } = statsQuery;
  const {
    data: savedMatches,
    error: savedError,
    isLoading: savedLoading,
    isFetching: savedFetching
  } = savedQuery;

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

  const handleOpenSavedMatch = (nextEventId: string) => {
    setEventId(nextEventId);
    setActiveTab("live");
  };

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

      <section className="rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-2 shadow-sm">
        <div role="tablist" aria-label="Data views" className="grid grid-cols-2 gap-2">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "live"}
            onClick={() => setActiveTab("live")}
            className={clsx(
              "rounded-2xl px-4 py-2 text-sm font-semibold transition",
              activeTab === "live"
                ? "bg-[color:var(--color-brand-primary)] text-[color:var(--color-text-inverse)]"
                : "bg-[color:var(--color-brand-surface)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-high)]"
            )}
          >
            {t("tabs.live")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "saved"}
            onClick={() => setActiveTab("saved")}
            className={clsx(
              "rounded-2xl px-4 py-2 text-sm font-semibold transition",
              activeTab === "saved"
                ? "bg-[color:var(--color-brand-primary)] text-[color:var(--color-text-inverse)]"
                : "bg-[color:var(--color-brand-surface)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-high)]"
            )}
          >
            {t("tabs.saved")}
          </button>
        </div>
      </section>

      {activeTab === "live" && (
        <>
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
        </>
      )}

      {activeTab === "saved" && (
        <section aria-live="polite" aria-busy={savedLoading || savedFetching} className="space-y-4">
          <h2 className="text-2xl font-bold text-[color:var(--color-text-high)]">{t("saved.title")}</h2>
          <p className="text-sm text-[color:var(--color-text-muted)]">{t("saved.description")}</p>
          <BulkScrapePanel />

          {savedLoading && (
            <div className="rounded-3xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-text-muted)]">
              {t("saved.loading")}
            </div>
          )}

          {savedError && (
            <div
              role="alert"
              className="rounded-3xl border border-[color:var(--color-danger)] bg-[color:var(--color-brand-surface-alt)] p-6 text-sm text-[color:var(--color-danger)]"
            >
              {t("saved.error")}
            </div>
          )}

          {savedMatches && savedMatches.length === 0 && (
            <div className="rounded-3xl border border-dashed border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">
              {t("saved.empty")}
            </div>
          )}

          {savedMatches && savedMatches.length > 0 && (
            <ScrapedMatchesMenu matches={savedMatches} onOpenMatch={handleOpenSavedMatch} />
          )}
        </section>
      )}
    </main>
  );
}
