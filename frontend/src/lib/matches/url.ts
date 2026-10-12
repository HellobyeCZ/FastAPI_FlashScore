import {
  MATCHES_SORTS,
  MATCH_BETS_KINDS,
  MATCH_STATUS_KINDS,
  type MatchBetsKind,
  type MatchStatusKind,
  type MatchesSort
} from "@/types/scraped-matches";

/** Matches-list state, mirrored 1:1 in the URL (?q=&sport=&country=&league=&status=&bets=&sort=). */
export type MatchesUrlState = {
  q: string;
  sport: string[];
  country: string[];
  league: string[];
  status: MatchStatusKind[];
  bets: MatchBetsKind[];
  sort: MatchesSort;
};

export const FACET_KEYS = ["sport", "country", "league", "status", "bets"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export const DEFAULT_SORT: MatchesSort = "kickoff_desc";

type Readable = { get(name: string): string | null };

function list(params: Readable, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    )
  );
}

function oneOf<V extends string>(values: string[], allowed: readonly V[]): V[] {
  return values.filter((v): v is V => (allowed as readonly string[]).includes(v));
}

/**
 * `?id=<eventId>` (links from older pages and tools) is read as a search; the
 * exact-id lookup then offers the match. The next update rewrites the URL
 * with `q`, which drops `id`.
 */
export function parseMatchesUrl(params: Readable): MatchesUrlState {
  const sort = params.get("sort") ?? "";
  return {
    q: (params.get("q") ?? params.get("id") ?? "").trim(),
    sport: list(params, "sport"),
    country: list(params, "country"),
    league: list(params, "league"),
    status: oneOf(list(params, "status"), MATCH_STATUS_KINDS),
    bets: oneOf(list(params, "bets"), MATCH_BETS_KINDS),
    sort: (MATCHES_SORTS as readonly string[]).includes(sort) ? (sort as MatchesSort) : DEFAULT_SORT
  };
}

/** Query object for routes.matches(): defaults and empty lists are omitted. */
export function matchesQuery(s: MatchesUrlState) {
  return {
    q: s.q || undefined,
    sport: s.sport,
    country: s.country,
    league: s.league,
    status: s.status,
    bets: s.bets,
    sort: s.sort === DEFAULT_SORT ? undefined : s.sort
  };
}

export function activeFilterCount(s: MatchesUrlState): number {
  return FACET_KEYS.reduce((n, k) => n + s[k].length, 0);
}
