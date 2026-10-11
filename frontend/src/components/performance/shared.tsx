"use client";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { useElementWidth } from "@/hooks/useElementWidth";
import { errorMessage } from "@/lib/api/http";
import { competitionRoot } from "@/lib/competition";
import { DASH } from "@/lib/format";
import { marketLabel, modelLabel, selectionLabel, type StateKey } from "@/lib/labels";
import { routes } from "@/lib/routes";
import type { MessageKey } from "@/lib/i18n";
import { activeFilterCount, MIN_N } from "@/lib/performance/filters";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import type { RowsResult } from "@/lib/performance/api";
import type { HistoryRow } from "@/lib/performance/types";
import { Button, ButtonLink, Callout, EmptyState, LinkTabs, Panel, Skeleton } from "@/components/ui";

// ---------------------------------------------------------------------------
// Window + filter wording

/** "last 90 days", "all time", "1 May 2026 – today". */
export function useWindowText(state: Pick<PerformanceFilterState, "window" | "range">): string {
  const { t, fmt } = useLocale();
  if (state.window === "custom") {
    return t("performance.window.desc.custom", {
      from: state.range.from ? fmt.date(state.range.from) : t("performance.window.start"),
      to: state.range.to ? fmt.date(state.range.to) : t("performance.window.today")
    });
  }
  return t(`performance.window.desc.${state.window}` as MessageKey);
}

/** Decimals a typed bound needs (2.5 → 1, 5 → 0), capped at `max`. */
const decimals = (v: number, max: number) => Math.min(max, (String(v).split(".")[1] ?? "").length);

/** Human list of the active filters, e.g. "1X2 · full time · Chance Liga". */
export function useFilterSummary(state: PerformanceFilterState): string | null {
  const { t, fmt } = useLocale();
  const f = state.filters;
  const parts: string[] = [];
  const has = (k: (typeof state.keys)[number]) => state.keys.includes(k) && f[k] !== null;
  const edge = (v: number | null) => (v === null ? "…" : fmt.num(v, decimals(v, 2)));
  const price = (v: number | null) => (v === null ? "…" : fmt.odds(v));
  if (has("model")) parts.push(modelLabel(f.model!, t));
  if (has("market")) parts.push(marketLabel(f.market!, t));
  if (has("competition")) parts.push(f.competition!);
  if (has("selection")) parts.push(selectionLabel(f.selection!, t));
  if (has("edgeMin") || has("edgeMax")) {
    parts.push(t("performance.filter.edgeRange", { min: edge(f.edgeMin), max: edge(f.edgeMax) }));
  }
  if (has("priceMin") || has("priceMax")) {
    parts.push(t("performance.filter.priceRange", { min: price(f.priceMin), max: price(f.priceMax) }));
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Signed probability difference in percentage points: +7.4 pp. */
export function usePp() {
  const { t, fmt } = useLocale();
  return (v: number | null | undefined, digits = 1) =>
    v === null || v === undefined || !Number.isFinite(v) ? DASH : t("performance.unit.pp", { value: fmt.signed(v * 100, digits) });
}

// ---------------------------------------------------------------------------
// Page chrome

export function PerformanceTabs({ active, params }: { active: "leaderboard" | "explore"; params: Record<string, string> }) {
  const { t, locale } = useLocale();
  return (
    <LinkTabs
      label={t("performance.tabs.label")}
      items={[
        { href: routes.performance(locale, params), label: t("nav.performance.overview"), active: active === "leaderboard" },
        { href: routes.explore(locale, params), label: t("nav.performance.explore"), active: active === "explore" }
      ]}
    />
  );
}

/** Shown when the default window fell back to all time because live data is old. */
export function StaleWindowCallout({ since }: { since: string }) {
  const { t, fmt } = useLocale();
  return (
    <Callout tone="warn" className="mb-5" title={t("performance.stale.title", { date: fmt.date(since) })}>
      <CalloutBody action={<OpsLink />}>{t("performance.stale.body", { age: fmt.relative(since) })}</CalloutBody>
    </Callout>
  );
}

/** Link to Data ops, where the pipeline and MLflow status live. */
export function OpsLink() {
  const { t, locale } = useLocale();
  return (
    <ButtonLink href={routes.ops(locale)} size="sm">
      {t("performance.stale.action")}
    </ButtonLink>
  );
}

/**
 * Callout text with its action underneath. Long explanations keep the full
 * width on phones instead of sharing the row with Callout's side action.
 */
export function CalloutBody({ action, children }: { action: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <p>{children}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>
    </>
  );
}

const EMPTY_TITLE = {
  settled: "performance.empty.settledTitle",
  pending: "performance.empty.pendingTitle",
  any: "performance.empty.anyTitle"
} as const satisfies Record<string, MessageKey>;

/**
 * Empty result for the current window/filters: says which window and filters
 * produced it and offers the action that widens the view.
 */
export function NoBetsEmpty({
  state,
  compact,
  subject = "settled"
}: {
  state: PerformanceFilterState;
  compact?: boolean;
  subject?: "settled" | "pending" | "any";
}) {
  const { t, locale } = useLocale();
  const windowText = useWindowText(state);
  const filterText = useFilterSummary(state);
  const filtered = activeFilterCount(state.filters, state.keys) > 0;
  const title = t(EMPTY_TITLE[subject], { window: windowText });
  return (
    <EmptyState
      compact={compact}
      title={title}
      action={
        <>
          {state.window !== "all" && (
            <Button size="sm" variant="primary" onClick={() => state.update({ window: "all", from: null, to: null })}>
              {t("performance.empty.showAll")}
            </Button>
          )}
          {filtered && (
            <Button size="sm" onClick={state.clearFilters}>
              {t("performance.filter.clear")}
            </Button>
          )}
          {state.window === "all" && !filtered && (
            <ButtonLink href={routes.ops(locale)} size="sm">
              {t("performance.stale.action")}
            </ButtonLink>
          )}
        </>
      }
    >
      {filterText
        ? t("performance.empty.withFilters", { filters: filterText })
        : state.window === "all"
          ? t("performance.empty.noneEver")
          : t("performance.empty.outsideWindow")}
    </EmptyState>
  );
}

/**
 * Empty chart over bets that do exist: the window has settled bets, but none
 * carries what the chart needs (a closing price, a competition, a stake). Says
 * so instead of claiming there are no bets, and points at the pipeline.
 */
export function MissingDataEmpty({
  state,
  title,
  body
}: {
  state: PerformanceFilterState;
  title: string;
  body: string;
}) {
  const { t } = useLocale();
  return (
    <EmptyState
      compact
      title={title}
      action={
        <>
          {state.window !== "all" && (
            <Button size="sm" onClick={() => state.update({ window: "all", from: null, to: null })}>
              {t("performance.empty.showAll")}
            </Button>
          )}
          <OpsLink />
        </>
      }
    >
      {body}
    </EmptyState>
  );
}

/** Panel footnotes joined into one line; falsy entries are skipped. */
export function joinNotes(...notes: (string | false | null | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => !!n);
  return kept.length ? kept.join(" ") : undefined;
}

/** Caveats for panels built from individual bets (row cap, unapplied filter). */
export function useRowsNote(rows: Pick<RowsResult, "truncated" | "competitionIgnored">): string | undefined {
  const { t } = useLocale();
  return joinNotes(
    rows.truncated && t("performance.chart.truncated"),
    rows.competitionIgnored && t("performance.chart.legacyCompetition")
  );
}

// ---------------------------------------------------------------------------
// Panels

type QueryLike = {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
};

export type PanelStatus = {
  loading: boolean;
  error: unknown;
  retry: () => void;
  retrying: boolean;
  /** The error is the filter options', which the active competition filter needs. */
  blocked?: boolean;
};

/** Filter readiness a panel waits on (`true` for panels that ignore the filters). */
export type PanelGate = true | Pick<PerformanceFilterState, "ready" | "blocker">;

/**
 * Merges query states for one panel. A failed filter dependency (`blocker`)
 * reads as this panel's error; otherwise `ready` false (filters resolving)
 * reads as loading.
 */
export function panelStatus(gate: PanelGate, ...queries: QueryLike[]): PanelStatus {
  if (gate !== true && gate.blocker) {
    const blocker = gate.blocker;
    return {
      loading: false,
      error: blocker.error,
      retry: () => void blocker.refetch(),
      retrying: blocker.isFetching,
      blocked: true
    };
  }
  const failed = queries.filter((q) => q.isError);
  return {
    loading: (gate !== true && !gate.ready) || queries.some((q) => q.isLoading),
    error: failed[0]?.error ?? null,
    retry: () => failed.forEach((q) => void q.refetch()),
    retrying: failed.some((q) => q.isFetching)
  };
}

export function PanelError({ status }: { status: PanelStatus }) {
  const { t } = useLocale();
  return (
    <Callout
      tone="neg"
      title={status.blocked ? t("performance.error.blockedTitle") : t("performance.error.title")}
      action={
        <Button size="sm" onClick={status.retry} loading={status.retrying}>
          {t("common.retry")}
        </Button>
      }
    >
      {status.blocked
        ? t("performance.error.blockedBody", { error: errorMessage(status.error) })
        : errorMessage(status.error)}
    </Callout>
  );
}

/**
 * Panel for a chart: loading skeleton, scoped error with retry, an empty state,
 * and a "data table" toggle so the numbers behind the picture are readable
 * (and reachable by screen readers).
 */
export function ChartPanel({
  title,
  description,
  status,
  isEmpty,
  empty,
  table,
  footer,
  children,
  className,
  skeletonClass = "h-60"
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  status: PanelStatus;
  isEmpty?: boolean;
  empty?: React.ReactNode;
  table?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  skeletonClass?: string;
}) {
  const { t } = useLocale();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const ok = !status.loading && !status.error && !isEmpty;
  return (
    <Panel
      title={title}
      description={description}
      className={className}
      footer={ok ? footer : undefined}
      actions={
        ok && table ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? t("performance.chart.hideData") : t("performance.chart.showData")}
          </Button>
        ) : undefined
      }
    >
      {status.loading ? (
        <Skeleton className={skeletonClass} />
      ) : status.error ? (
        <PanelError status={status} />
      ) : isEmpty ? (
        empty
      ) : (
        <>
          {children}
          {table && (
            <div id={tableId} hidden={!showTable} className="mt-4">
              {table}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Gives fixed-width charts their container's width (they otherwise default to
 * 480–720px and overflow phones). Reserves `height` until measured.
 */
export function Measured({
  height,
  max,
  children
}: {
  height: number;
  max?: number;
  children: (width: number) => React.ReactNode;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(0);
  return (
    <div ref={ref} className="w-full min-w-0">
      {width > 0 ? children(max ? Math.min(max, width) : width) : <div style={{ height }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cells

/**
 * "Home – Away" over the competition; falls back to the event id only when no
 * names exist. `mobileSub` replaces the competition line below `sm`, where the
 * table drops columns.
 */
export function MatchCell({
  row,
  mobileSub,
  className
}: {
  row: HistoryRow;
  mobileSub?: React.ReactNode;
  className?: string;
}) {
  const { t } = useLocale();
  const home = row.home_team ?? row.home_team_raw;
  const away = row.away_team ?? row.away_team_raw;
  const comp = competitionRoot(row.competition ?? null);
  return (
    <span className={clsx("flex min-w-0 flex-col", className)}>
      {home && away ? (
        <span className="break-words sm:truncate">
          {home} – {away}
        </span>
      ) : (
        <span className="truncate text-text-dim">{t("performance.bets.unknownMatch", { id: row.event_id })}</span>
      )}
      {comp && (
        <span className={clsx("truncate text-meta text-text-faint", mobileSub !== undefined && "hidden sm:block")}>
          {comp}
        </span>
      )}
      {mobileSub !== undefined && <span className="truncate text-meta text-text-dim sm:hidden">{mobileSub}</span>}
    </span>
  );
}

/** Bet outcome from status + result (won/lost come from `result`, never from the P&L sign). */
export function betState(row: HistoryRow): StateKey | null {
  const status = row.status.toLowerCase();
  if (status === "pending") return "pending";
  if (status === "voided" || status === "void") return "void";
  if (row.result === 1) return "won";
  if (row.result === 0) return "lost";
  return null;
}

/** Marks the best value among models with enough bets to be ranked. */
export function BestMark() {
  const { t } = useLocale();
  return (
    <span className="ml-1.5 text-info" title={t("performance.leaderboard.bestTitle", { min: MIN_N })}>
      <span aria-hidden>◆</span>
      <span className="sr-only">{t("performance.leaderboard.best")}</span>
    </span>
  );
}

/** "51–100 of 1,234" + previous/next. */
export function Pager({
  page,
  pageSize,
  total,
  shown,
  busy,
  onPage
}: {
  page: number;
  pageSize: number;
  total: number | null;
  shown: number;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  const { t, fmt } = useLocale();
  const start = shown === 0 ? 0 : page * pageSize + 1;
  const end = page * pageSize + shown;
  const lastPage = total !== null ? Math.max(0, Math.ceil(total / pageSize) - 1) : null;
  const hasNext = lastPage !== null ? page < lastPage : shown === pageSize;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={clsx("tabular-nums", busy && "text-text-faint")} aria-live="polite">
        {total !== null
          ? t("performance.pager.rangeOf", { start: fmt.int(start), end: fmt.int(end), total: fmt.int(total) })
          : t("performance.pager.range", { start: fmt.int(start), end: fmt.int(end) })}
      </span>
      {(page > 0 || hasNext) && (
        <span className="flex items-center gap-2">
          <Button size="sm" onClick={() => onPage(page - 1)} disabled={page === 0 || busy}>
            {t("performance.pager.prev")}
          </Button>
          <Button size="sm" onClick={() => onPage(page + 1)} disabled={!hasNext || busy}>
            {t("performance.pager.next")}
          </Button>
        </span>
      )}
    </div>
  );
}
