"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  Label,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  Table,
  TextLink,
  type Column,
  type SortState
} from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { useMatchesQuery } from "@/hooks/useMatchesQuery";
import { errorMessage } from "@/lib/api/http";
import { competitionRoot } from "@/lib/competition";
import type { MessageKey } from "@/lib/i18n";
import { countryLabel, matchTitle, sportLabel } from "@/lib/matches/display";
import { activeFilterCount, matchesQuery, parseMatchesUrl, type MatchesUrlState } from "@/lib/matches/url";
import { routes } from "@/lib/routes";
import { MATCHES_SORTS, type MatchListItem, type MatchesSort } from "@/types/scraped-matches";
import { ActiveFilters, MatchFilters } from "./MatchFilters";
import { MatchResult } from "./MatchStatus";

const SEARCH_DEBOUNCE_MS = 300;

const SORT_LABEL: Record<MatchesSort, MessageKey> = {
  kickoff_desc: "matches.sort.kickoff_desc",
  kickoff_asc: "matches.sort.kickoff_asc",
  fetched_desc: "matches.sort.fetched_desc"
};

/** Stored-matches index. Every filter, the search and the sort live in the URL. */
export function MatchesPage() {
  const { t, tp, fmt, locale } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => parseMatchesUrl(params), [params]);

  const update = useCallback(
    (patch: Partial<MatchesUrlState>) => {
      router.replace(routes.matches(locale, matchesQuery({ ...parseMatchesUrl(params), ...patch })), { scroll: false });
    },
    [router, locale, params]
  );

  // The box updates the URL after a pause; the URL (back/forward, chips) wins
  // whenever it disagrees with what was typed.
  const [text, setText] = useState(state.q);
  useEffect(() => {
    setText((prev) => (prev.trim() === state.q ? prev : state.q));
  }, [state.q]);
  useEffect(() => {
    if (text.trim() === state.q) return;
    const id = window.setTimeout(() => update({ q: text.trim() }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text, state.q, update]);

  const query = useMatchesQuery(state);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const items = pages.flatMap((p) => p.items);
  const total = first?.total;
  const filtered = activeFilterCount(state) > 0 || state.q !== "";
  const refreshing = query.isFetching && !query.isFetchingNextPage && query.isPlaceholderData;

  const sort: SortState =
    state.sort === "kickoff_asc"
      ? { key: "kickoff", dir: "asc" }
      : state.sort === "kickoff_desc"
        ? { key: "kickoff", dir: "desc" }
        : null;

  const columns: Column<MatchListItem>[] = [
    {
      key: "kickoff",
      header: t("matches.col.kickoff"),
      headerTitle: t("matches.col.kickoffTitle"),
      sortValue: (m) => m.start_time_utc,
      cell: (m) => (
        <span className="flex flex-col whitespace-nowrap leading-tight">
          <span>{fmt.date(m.start_time_utc)}</span>
          <span className="text-meta text-text-dim">{fmt.time(m.start_time_utc)}</span>
        </span>
      ),
      width: "1%"
    },
    {
      key: "sport",
      header: t("matches.col.sport"),
      hideBelow: "md",
      cell: (m) => <span className="whitespace-nowrap text-text-dim">{sportLabel(m.sport, t) || "—"}</span>
    },
    {
      key: "country",
      header: t("matches.col.country"),
      hideBelow: "lg",
      cell: (m) => <span className="whitespace-nowrap text-text-dim">{countryLabel(m.country) || "—"}</span>
    },
    {
      key: "league",
      header: t("matches.col.league"),
      hideBelow: "sm",
      cell: (m) => (
        <span className="block max-w-[14rem] truncate" title={m.competition ?? undefined}>
          {competitionRoot(m.competition) ?? "—"}
        </span>
      )
    },
    {
      key: "match",
      header: t("matches.col.match"),
      cell: (m) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-sans text-body text-text">{matchTitle(m, t)}</span>
          {/* League is its own column from sm up; phones read it under the teams. */}
          <span className="truncate text-meta text-text-dim sm:hidden">{competitionRoot(m.competition)}</span>
          {(m.live_bets > 0 || m.backtest_bets > 0) && (
            <span className="flex flex-wrap gap-1">
              {m.live_bets > 0 && <Badge tone="accent">{tp("matches.badge.live", m.live_bets)}</Badge>}
              {m.backtest_bets > 0 && <Badge tone="info">{tp("matches.badge.backtest", m.backtest_bets)}</Badge>}
            </span>
          )}
        </span>
      )
    },
    {
      key: "result",
      header: t("matches.col.result"),
      cell: (m) => <MatchResult status={m.status} score={m.score} outcome={m.outcome} />
    },
    {
      key: "snapshots",
      header: t("matches.col.snapshots"),
      headerTitle: t("matches.col.snapshotsTitle"),
      hideBelow: "lg",
      align: "right",
      cell: (m) => (
        <span className="flex flex-col items-end leading-tight">
          <span className="whitespace-nowrap">
            {t("matches.snapshots.counts", { odds: fmt.int(m.odds_snapshots), stats: fmt.int(m.stats_snapshots) })}
          </span>
          <span className="whitespace-nowrap text-meta text-text-dim" title={fmt.dateTime(m.last_fetched_at)}>
            {m.last_fetched_at ? fmt.relative(m.last_fetched_at) : t("matches.snapshots.never")}
          </span>
        </span>
      )
    }
  ];

  const hasMore = Boolean(query.hasNextPage);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("matches.title")}
        description={t("matches.description")}
        meta={
          total !== undefined
            ? filtered
              ? tp("matches.meta.filtered", total, { count: fmt.int(total) })
              : tp("matches.meta.all", total, { count: fmt.int(total) })
            : undefined
        }
        className="mb-2"
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            label={t("matches.search.label")}
            placeholder={t("matches.search.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full min-w-0 md:w-auto md:flex-1 md:basis-80 md:max-w-xl"
          />
          <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto">
            <MatchFilters state={state} facets={first?.facets} total={total} onChange={update} />
            <span className="ml-auto flex min-w-0 items-center gap-2 md:ml-0">
              <Label htmlFor="matches-sort" className="hidden sm:inline">
                {t("matches.sort.label")}
              </Label>
              <Select
                id="matches-sort"
                aria-label={t("matches.sort.label")}
                value={state.sort}
                onChange={(e) => update({ sort: e.target.value as MatchesSort })}
                className="min-w-0"
              >
                {MATCHES_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(SORT_LABEL[s])}
                  </option>
                ))}
              </Select>
            </span>
          </div>
        </div>
        <ActiveFilters state={state} onChange={update} />
      </div>

      {first?.exact && (
        <Callout
          tone="info"
          title={t("matches.exact.title", { id: first.exact.event_id })}
          action={
            <ButtonLink href={routes.match(locale, first.exact.event_id)} size="sm" variant="primary">
              {t("matches.exact.open")}
            </ButtonLink>
          }
        >
          <TextLink href={routes.match(locale, first.exact.event_id)}>{matchTitle(first.exact, t)}</TextLink>
          {" · "}
          {competitionRoot(first.exact.competition)} · {fmt.dateTime(first.exact.start_time_utc)}
        </Callout>
      )}

      {query.isError && !query.data ? (
        <Callout
          tone="neg"
          title={t("matches.error")}
          action={
            <Button size="sm" onClick={() => query.refetch()} loading={query.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Callout>
      ) : (
        <section aria-labelledby="matches-results" className="min-w-0 border border-border bg-surface/60">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <h2 id="matches-results" className="font-sans text-label uppercase tracking-label text-text">
              {t("matches.results")}
            </h2>
            <span className="flex items-center gap-2 text-meta text-text-dim" aria-live="polite">
              {refreshing && <Spinner />}
              {total !== undefined &&
                t("matches.showing", { shown: fmt.int(items.length), total: fmt.int(total) })}
            </span>
          </div>
          <Table<MatchListItem>
            caption={t("matches.caption")}
            columns={columns}
            rows={items}
            rowKey={(m) => m.event_id}
            rowHref={(m) => routes.match(locale, m.event_id)}
            linkColumn="match"
            loading={query.isLoading}
            sort={sort}
            onSortChange={(s) =>
              update({ sort: s?.key === "kickoff" && s.dir === "asc" ? "kickoff_asc" : "kickoff_desc" })
            }
            className={refreshing ? "opacity-60 transition-opacity" : undefined}
            empty={
              filtered ? (
                <EmptyState
                  title={t("matches.empty.filtered")}
                  action={
                    <Button
                      onClick={() => {
                        setText("");
                        update({ q: "", sport: [], country: [], league: [], status: [], bets: [] });
                      }}
                    >
                      {t("matches.empty.clear")}
                    </Button>
                  }
                >
                  <FilterSummary state={state} />
                </EmptyState>
              ) : (
                <EmptyState
                  title={t("matches.empty.none")}
                  action={<ButtonLink href={routes.ops(locale)}>{t("matches.empty.ops")}</ButtonLink>}
                >
                  {t("matches.empty.noneBody")}
                </EmptyState>
              )
            }
            footer={
              items.length > 0 && total !== undefined ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t("matches.showing", { shown: fmt.int(items.length), total: fmt.int(total) })}</span>
                  {hasMore && (
                    <Button size="sm" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                      {t("common.loadMore")}
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          />
          {query.isError && query.data && (
            <Callout tone="neg" title={t("matches.error")} className="m-3">
              {errorMessage(query.error)}
            </Callout>
          )}
        </section>
      )}
    </div>
  );
}

/** "Search “sparta” · Country: Czech Republic" — names what produced an empty result. */
function FilterSummary({ state }: { state: MatchesUrlState }) {
  const { t, tp } = useLocale();
  const parts: string[] = [];
  if (state.q) parts.push(t("matches.empty.search", { q: state.q }));
  const n = activeFilterCount(state);
  if (n > 0) parts.push(tp("matches.empty.facets", n));
  return <>{parts.join(" · ")}</>;
}
