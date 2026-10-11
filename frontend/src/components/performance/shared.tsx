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

/** Human list of the active filters, e.g. "1X2 · full time · Chance Liga". */
export function useFilterSummary(state: PerformanceFilterState): string | null {
  const { t } = useLocale();
  const f = state.filters;
  const parts: string[] = [];
  const has = (k: (typeof state.keys)[number]) => state.keys.includes(k) && f[k] !== null;
  if (has("model")) parts.push(modelLabel(f.model!, t));
  if (has("market")) parts.push(marketLabel(f.market!, t));
  if (has("competition")) parts.push(f.competition!);
  if (has("selection")) parts.push(selectionLabel(f.selection!, t));
  if (has("edgeMin") || has("edgeMax")) {
    parts.push(t("performance.filter.edgeRange", { min: f.edgeMin ?? "…", max: f.edgeMax ?? "…" }));
  }
  if (has("priceMin") || has("priceMax")) {
    parts.push(t("performance.filter.priceRange", { min: f.priceMin ?? "…", max: f.priceMax ?? "…" }));
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
  const { t, fmt, locale } = useLocale();
  return (
    <Callout
      tone="warn"
      className="mb-5"
      title={t("performance.stale.title", { date: fmt.date(since) })}
      action={
        <ButtonLink href={routes.ops(locale)} size="sm">
          {t("performance.stale.action")}
        </ButtonLink>
      }
    >
      {t("performance.stale.body", { age: fmt.relative(since) })}
    </Callout>
  );
}

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
  subject?: "settled" | "any";
}) {
  const { t, locale } = useLocale();
  const windowText = useWindowText(state);
  const filterText = useFilterSummary(state);
  const filtered = activeFilterCount(state.filters, state.keys) > 0;
  const title = t(subject === "settled" ? "performance.empty.settledTitle" : "performance.empty.anyTitle", {
    window: windowText
  });
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

// ---------------------------------------------------------------------------
// Panels

type QueryLike = {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
};

export type PanelStatus = { loading: boolean; error: unknown; retry: () => void; retrying: boolean };

/** Merges query states for one panel; `ready` false (filters resolving) reads as loading. */
export function panelStatus(ready: boolean, ...queries: QueryLike[]): PanelStatus {
  const failed = queries.filter((q) => q.isError);
  return {
    loading: !ready || queries.some((q) => q.isLoading),
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
      title={t("performance.error.title")}
      action={
        <Button size="sm" onClick={status.retry} loading={status.retrying}>
          {t("common.retry")}
        </Button>
      }
    >
      {errorMessage(status.error)}
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

export function MatchCell({ row }: { row: HistoryRow }) {
  const { t } = useLocale();
  const home = row.home_team ?? row.home_team_raw;
  const away = row.away_team ?? row.away_team_raw;
  const comp = competitionRoot(row.competition ?? null);
  return (
    <span className="flex min-w-0 flex-col">
      {home && away ? (
        <span className="truncate">
          {home} – {away}
        </span>
      ) : (
        <span className="truncate text-text-dim">{t("performance.bets.unknownMatch", { id: row.event_id })}</span>
      )}
      {comp && <span className="truncate text-meta text-text-faint">{comp}</span>}
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
