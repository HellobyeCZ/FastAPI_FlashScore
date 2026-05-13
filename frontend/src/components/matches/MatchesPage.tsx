"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Facets, type Facet } from "@/components/terminal/Facets";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken, type StatusKind } from "@/components/terminal/StatusToken";
import { Chip } from "@/components/terminal/Chip";
import { Kicker } from "@/components/terminal/Kicker";
import { useLocale } from "@/contexts/LocaleContext";
import { useMatchesQuery, type MatchesSort } from "@/hooks/useMatchesQuery";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

const SORT_LABEL: Record<MatchesSort, string> = {
  last_fetch_desc: "Last fetch ↓",
  kickoff_desc: "Kickoff ↓",
  kickoff_asc: "Kickoff ↑",
  snaps_desc: "Snapshots ↓",
};

const STATUS_VALUES: StatusKind[] = ["LIVE", "FT", "SCHED"];

function statusKind(raw?: string): StatusKind {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("live") || s.includes("in_play") || s.includes("running")) return "LIVE";
  if (s.includes("finished") || s.includes("ft") || s.includes("ended") || s.includes("completed"))
    return "FT";
  return "SCHED";
}

function formatKickoff(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function formatLastFetched(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}

export function MatchesPage() {
  const router = useRouter();
  const { locale } = useLocale();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [countries, setCountries] = useState<string[]>([]);
  const [leagues, setLeagues] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sort, setSort] = useState<MatchesSort>("last_fetch_desc");

  const query = useMatchesQuery({
    q: debouncedSearch,
    countries,
    leagues,
    statuses,
    sort,
    limit: 50,
  });

  const rows: ScrapedMatchSummary[] = useMemo(() => {
    if (!query.data) return [];
    return query.data.pages.flatMap((p) => p.matches);
  }, [query.data]);

  const total = query.data?.pages[0]?.total ?? 0;
  const facetsFromServer = query.data?.pages[0]?.facets;

  const facets: Facet[] = useMemo(() => {
    return [
      {
        key: "country",
        label: "Country",
        options:
          facetsFromServer?.country.map((c) => ({
            value: c.value,
            label: c.value,
            count: c.count,
          })) ?? [],
        selected: countries,
        onChange: setCountries,
      },
      {
        key: "league",
        label: "League",
        options:
          facetsFromServer?.league.map((c) => ({
            value: c.value,
            label: c.value,
            count: c.count,
          })) ?? [],
        selected: leagues,
        onChange: setLeagues,
      },
      {
        key: "status",
        label: "Status",
        options: STATUS_VALUES.map((s) => ({
          value: s,
          label: s,
          count: facetsFromServer?.status.find((x) => x.value === s)?.count,
        })),
        selected: statuses,
        onChange: setStatuses,
      },
    ];
  }, [facetsFromServer, countries, leagues, statuses]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Auto-load next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            query.fetchNextPage();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const columns: Column<ScrapedMatchSummary>[] = [
    { key: "kickoff", header: "Kickoff", render: (m) => formatKickoff(m.startTimeUtc) },
    {
      key: "country",
      header: "Country",
      render: (m) => <span className="text-text-dim">{m.country ?? "—"}</span>,
    },
    {
      key: "league",
      header: "League",
      render: (m) => <span className="text-text-dim">{m.competition ?? "—"}</span>,
    },
    { key: "home", header: "Home", render: (m) => m.homeTeam ?? "—" },
    { key: "away", header: "Away", render: (m) => m.awayTeam ?? "—" },
    {
      key: "status",
      header: "Status",
      render: (m) => <StatusToken kind={statusKind(m.status)} />,
    },
    {
      key: "snapshots",
      header: "Snap",
      align: "right",
      render: (m) => m.oddsSnapshotCount + m.statsSnapshotCount,
    },
    {
      key: "lastFetch",
      header: "Last fetch",
      render: (m) => (
        <span className="text-text-faint">{formatLastFetched(m.lastFetchedAt)}</span>
      ),
    },
  ];

  const showingFrom = rows.length === 0 ? 0 : 1;
  const showingTo = rows.length;

  return (
    <>
      <PageHeader
        kicker="Matches · stored"
        actions={
          <div className="flex items-center gap-3 font-mono text-[11px] text-text-dim">
            <span>
              {showingFrom}–{showingTo}{" "}
              <span className="text-text-faint">/</span>{" "}
              <span className="text-text">{total.toLocaleString(locale)}</span>{" "}
              matches
            </span>
          </div>
        }
      />

      {/* Top control row: search + sort chips */}
      <section className="mb-5 flex flex-wrap items-center gap-3 border-b border-border pb-3">
        <div className="flex flex-1 min-w-[260px] items-center gap-2 border border-border bg-bg px-2 font-mono text-[12px]">
          <span className="text-text-faint">▸</span>
          <input
            data-search-input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search teams, league, event id…"
            className="w-full border-none bg-transparent px-0 py-2 text-text placeholder:text-text-faint focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="border-none px-1 py-0 text-[10px] text-text-faint hover:text-text"
              aria-label="clear"
            >
              esc
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Kicker className="mr-1">Sort</Kicker>
          {(Object.keys(SORT_LABEL) as MatchesSort[]).map((k) => (
            <Chip key={k} selected={sort === k} onClick={() => setSort(k)}>
              {SORT_LABEL[k]}
            </Chip>
          ))}
        </div>
      </section>

      <div className="flex gap-6">
        <Facets facets={facets} />
        <div className="flex-1 overflow-x-auto">
          {query.isError && (
            <div className="mb-3 border border-neg/40 bg-bg px-3 py-2 font-mono text-[12px] text-neg">
              ▸ failed to load: {(query.error as Error)?.message ?? "unknown"}
            </div>
          )}
          <DataTable
            columns={columns}
            rows={rows}
            onRowClick={(m) =>
              router.push(
                `/${locale}/matches/${m.eventId}` as unknown as Parameters<typeof router.push>[0],
              )
            }
            empty={
              query.isLoading
                ? "▸ loading…"
                : debouncedSearch || countries.length || leagues.length || statuses.length
                  ? "▸ no matches for current filters"
                  : "▸ no matches in db"
            }
          />

          {/* Pagination footer: sentinel for auto-load + manual button */}
          <div
            ref={sentinelRef}
            className="mt-3 flex items-center justify-between border-t border-border pt-2 font-mono text-[11px] text-text-dim"
          >
            <span>
              {rows.length.toLocaleString(locale)} of{" "}
              {total.toLocaleString(locale)} shown
            </span>
            {query.hasNextPage ? (
              <button
                type="button"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="border border-border px-3 py-1 text-[11px] hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {query.isFetchingNextPage ? "loading…" : "load more"}
              </button>
            ) : (
              rows.length > 0 && <span className="text-text-faint">▸ end of results</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
