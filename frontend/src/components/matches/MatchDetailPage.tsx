"use client";
import { Button, ButtonLink, Callout, EmptyState, PageHeader, Skeleton, type Crumb } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import { competitionRoot } from "@/lib/competition";
import type { MessageKey } from "@/lib/i18n";
import { countryLabel, eventStatus, matchTitle, sportLabel } from "@/lib/matches/display";
import type { Teams } from "@/lib/matches/labels";
import { isNotFound, useEvent, useStoredMatchLookup } from "@/lib/matches/queries";
import type { EventDetail } from "@/lib/matches/types";
import { routes } from "@/lib/routes";
import { BetsPanel } from "./BetsPanel";
import { FetchLatest } from "./FetchLatest";
import { MatchResult } from "./MatchStatus";
import { ModelViewPanel } from "./ModelViewPanel";
import { OddsPanel } from "./OddsPanel";
import { StatsPanel } from "./StatsPanel";

const SECTIONS: { id: string; label: MessageKey }[] = [
  { id: "model", label: "matches.model.title" },
  { id: "bets", label: "matches.bets.title" },
  { id: "odds", label: "matches.odds.title" },
  { id: "stats", label: "matches.stats.title" }
];

function newest(...stamps: (string | null | undefined)[]): string | null {
  return (
    stamps
      .filter((s): s is string => Boolean(s))
      .sort()
      .pop() ?? null
  );
}

/**
 * One stored match: identity and provenance, model view, bets, odds by market
 * and statistics. Opening it reads stored data only; refreshing from
 * FlashScore is an explicit, confirmed action.
 */
export function MatchDetailPage({ eventId }: { eventId: string }) {
  const { t, locale } = useLocale();
  const event = useEvent(eventId);
  const e = event.data;

  if (event.isError && isNotFound(event.error)) {
    // Retry goes through this page's observer: a second useEvent() mounting on
    // an errored query would refetch on mount and flip this branch back and forth.
    return (
      <EventNotFound
        eventId={eventId}
        error={event.error}
        onRetry={() => event.refetch()}
        retrying={event.isFetching}
      />
    );
  }

  const teams: Teams = { home: e?.home_team ?? null, away: e?.away_team ?? null };
  const status = e ? eventStatus(e) : null;
  const league = competitionRoot(e?.competition);
  const crumbs: Crumb[] = [{ label: t("matches.title"), href: routes.matches(locale) }];
  if (league) crumbs.push({ label: league, href: routes.matches(locale, { league: [league] }) });

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          e ? (
            matchTitle(e, t)
          ) : event.isLoading ? (
            <Skeleton className="inline-block h-6 w-64 max-w-full" />
          ) : (
            t("matches.detail.fallbackTitle")
          )
        }
        description={e && <HeaderFacts event={e} />}
        meta={e && <Provenance event={e} />}
        actions={
          e && !e.is_terminal ? (
            <FetchLatest
              eventId={eventId}
              lastFetchedAt={newest(e.latest_odds_fetched_at, e.latest_stats_fetched_at)}
            />
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        {event.isError && (
          <Callout
            tone="neg"
            title={t("matches.detail.error")}
            action={
              <Button size="sm" onClick={() => event.refetch()} loading={event.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(event.error)}
          </Callout>
        )}

        <nav aria-label={t("matches.detail.sections")} className="-mt-2 overflow-x-auto">
          <ul className="flex min-w-max items-center gap-4 text-meta">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-text-dim underline-offset-2 hover:text-text hover:underline">
                  {t(s.label)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <ModelViewPanel eventId={eventId} teams={teams} finished={status === "finished"} />
        <BetsPanel eventId={eventId} />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] xl:items-start">
          <OddsPanel eventId={eventId} teams={teams} terminal={e?.is_terminal} />
          <StatsPanel eventId={eventId} teams={teams} terminal={e?.is_terminal} />
        </div>
      </div>
    </>
  );
}

/**
 * Line 1: "24 May 2026, 14:00 · Finished 2:1".
 * Line 2: "Chance Liga - Championship Group · Czech Republic · Football".
 */
function HeaderFacts({ event }: { event: EventDetail }) {
  const { t, fmt } = useLocale();
  const facts = [event.competition, countryLabel(event.country), sportLabel(event.sport, t)].filter(Boolean);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-text">{fmt.dateTime(event.start_time_utc)}</span>
        <span aria-hidden className="text-text-faint">
          ·
        </span>
        <MatchResult status={eventStatus(event)} score={event.score} outcome={event.outcome} />
      </span>
      {facts.length > 0 && <span>{facts.join(" · ")}</span>}
    </span>
  );
}

/** Where the numbers on this page come from and how old they are. */
function Provenance({ event }: { event: EventDetail }) {
  const { t, fmt } = useLocale();
  const latest = newest(event.latest_odds_fetched_at, event.latest_stats_fetched_at);
  return (
    <span className="flex flex-col gap-0.5 sm:items-end">
      <span>
        {latest
          ? t("matches.detail.provenance", { time: fmt.dateTime(latest), age: fmt.relative(latest) })
          : t("matches.detail.provenanceNone")}
      </span>
      {event.is_terminal && <span>{t("matches.detail.frozen")}</span>}
    </span>
  );
}

/**
 * /events/{id} answered 404. If the id is in the stored-matches index the
 * event endpoint itself is failing (say so, offer a retry); only a truly
 * unknown id gets "not found" plus the option to fetch it from FlashScore.
 */
function EventNotFound({
  eventId,
  error,
  onRetry,
  retrying
}: {
  eventId: string;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t, locale } = useLocale();
  const lookup = useStoredMatchLookup(eventId, true);
  const stored = lookup.data?.exact ?? null;
  const crumbs: Crumb[] = [{ label: t("matches.title"), href: routes.matches(locale) }];

  if (lookup.isLoading) {
    return (
      <>
        <PageHeader title={<Skeleton className="inline-block h-6 w-64 max-w-full" />} crumbs={crumbs} />
        <Skeleton lines={4} />
      </>
    );
  }
  if (stored) {
    return (
      <>
        <PageHeader title={matchTitle(stored, t)} crumbs={crumbs} />
        <Callout
          tone="neg"
          title={t("matches.detail.unavailable")}
          action={
            <Button size="sm" onClick={onRetry} loading={retrying}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("matches.detail.unavailableBody", { message: errorMessage(error) })}
        </Callout>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t("matches.detail.notFound")} crumbs={crumbs} />
      <EmptyState
        title={t("matches.detail.notFoundBody", { id: eventId })}
        action={
          <>
            <ButtonLink href={routes.matches(locale, { q: eventId })}>{t("matches.detail.searchStored")}</ButtonLink>
            {/* Only offered when the index confirms the id is not stored. */}
            {lookup.isSuccess && <FetchLatest eventId={eventId} lastFetchedAt={null} size="md" />}
          </>
        }
      >
        {lookup.isSuccess ? t("matches.detail.notFoundHint") : t("matches.detail.notFoundHintNoFetch")}
      </EmptyState>
    </>
  );
}
