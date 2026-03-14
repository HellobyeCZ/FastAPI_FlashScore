"use client";

import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { EventSearchForm } from "@/components/EventSearchForm";
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

    if (!target || Number.isNaN(target.getTime())) return undefined;

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-high)]">
          {t("app.title")}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("app.description")}</p>
      </div>

      <div className="inline-flex rounded-xl border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface-alt)] p-1">
        {(["live", "saved"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              "rounded-lg px-5 py-2 text-sm font-medium transition",
              activeTab === tab
                ? "bg-[var(--color-brand-primary)] text-[var(--color-text-inverse)] shadow-sm"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-high)]"
            )}
          >
            {t(tab === "live" ? "tabs.live" : "tabs.saved")}
          </button>
        ))}
      </div>

      {activeTab === "live" && (
        <div className="space-y-6">
          <EventSearchForm
            initialEventId={eventId}
            onSearch={setEventId}
            isLoading={isLoading || (isFetching && !data)}
          />

          {(formattedUpdatedAt || (eventId && data)) && (
            <div className="flex flex-wrap items-center gap-2">
              {formattedUpdatedAt && (
                <span className="rounded-full bg-[var(--color-brand-surface-alt)] border border-[var(--color-brand-outline)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
                  {t("timestamp.updated", { time: formattedUpdatedAt })}
                </span>
              )}
              {eventId && data && (
                <span className="rounded-full bg-[var(--color-brand-surface-alt)] border border-[var(--color-brand-outline)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
                  {t("feedback.summary", { count: marketCount })}
                </span>
              )}
            </div>
          )}

          {eventId && (
            <section aria-live="polite" aria-busy={statsLoading || (statsFetching && !statsData)} className="space-y-4">
              <h2 className="text-lg font-semibold text-[var(--color-text-high)]">{t("stats.title")}</h2>
              {statsLoading && <LoadingCard>{t("feedback.statsLoading")}</LoadingCard>}
              {statsError && <ErrorCard>{t("feedback.statsError")}</ErrorCard>}
              {statsData && <MatchStatsTable summary={statsData} />}
            </section>
          )}

          <section aria-live="polite" aria-busy={isLoading} className="space-y-4">
            {isLoading && <LoadingCard>{t("feedback.loading")}</LoadingCard>}
            {error && <ErrorCard>{t("feedback.error")}</ErrorCard>}
            {data && <OddsTable summary={data} />}
          </section>
        </div>
      )}

      {activeTab === "saved" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-text-high)]">{t("saved.title")}</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("saved.description")}</p>
          </div>

          <BulkScrapePanel />

          {savedLoading && <LoadingCard>{t("saved.loading")}</LoadingCard>}
          {savedError && <ErrorCard>{t("saved.error")}</ErrorCard>}

          {savedMatches && savedMatches.length === 0 && (
            <EmptyCard>{t("saved.empty")}</EmptyCard>
          )}

          {savedMatches && savedMatches.length > 0 && (
            <ScrapedMatchesMenu matches={savedMatches} onOpenMatch={handleOpenSavedMatch} />
          )}
        </div>
      )}
    </div>
  );
}

function LoadingCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface-alt)] p-5 text-sm text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function ErrorCard({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl border border-[var(--color-danger)] bg-[var(--color-brand-surface-alt)] p-5 text-sm text-[var(--color-danger)]">
      {children}
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-brand-outline)] bg-[var(--color-brand-surface-alt)] p-6 text-center text-sm text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}
