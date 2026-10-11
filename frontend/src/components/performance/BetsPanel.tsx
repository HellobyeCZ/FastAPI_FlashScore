"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { marketLabel, selectionLabel } from "@/lib/labels";
import { routes } from "@/lib/routes";
import { useBetsPage, type BetStatus } from "@/lib/performance/api";
import type { PicksQuery } from "@/lib/performance/filters";
import type { HistoryRow } from "@/lib/performance/types";
import type { PerformanceFilterState } from "@/lib/performance/useFilters";
import {
  Button,
  Callout,
  EmptyState,
  ModelName,
  Panel,
  SegmentedControl,
  Signed,
  StateBadge,
  Table,
  type Column
} from "@/components/ui";
import { betState, MatchCell, NoBetsEmpty, Pager, PanelError, panelStatus, usePp } from "./shared";

const PAGE_SIZE = 25;

/** Table scope; "settled" matches the population every chart on the page uses. */
const STATUSES = ["settled", "pending", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

function readStatus(raw: string | null): StatusFilter {
  return (STATUSES as readonly string[]).includes(raw ?? "") ? (raw as StatusFilter) : "settled";
}

/** URL `page` is 1-based for people; the hooks count from 0. */
function readPage(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 1 ? n - 1 : 0;
}

/**
 * Paginated bets for the page's filters, newest first. Server-side paging when
 * the backend supports `offset`; every row links to its match.
 */
export function BetsPanel({
  state,
  q,
  hideModel,
  className
}: {
  state: PerformanceFilterState;
  q: PicksQuery;
  /** The page is already scoped to one model. */
  hideModel?: boolean;
  className?: string;
}) {
  const { t, fmt, locale } = useLocale();
  const pp = usePp();
  const status = readStatus(state.searchParams.get("status"));
  const page = readPage(state.searchParams.get("page"));
  const result = useBetsPage(q, {
    status: status === "all" ? undefined : (status satisfies BetStatus),
    page,
    pageSize: PAGE_SIZE,
    enabled: state.ready
  });
  const pstatus = panelStatus(state.ready, result);
  const setPage = (next: number) => state.setParam({ page: next > 0 ? String(next + 1) : null });

  const columns: Column<HistoryRow>[] = [
    {
      key: "kickoff",
      header: t("performance.col.kickoff"),
      cell: (r) => <span className="whitespace-nowrap text-text-dim">{fmt.dateTime(r.kickoff ?? null)}</span>,
      hideBelow: "md"
    },
    {
      key: "match",
      header: t("performance.col.match"),
      cell: (r) => (
        <MatchCell
          row={r}
          mobileSub={`${selectionLabel(r.selection, t)} · ${marketLabel(r.market, t)}`}
          className="w-32 sm:w-auto sm:max-w-xs"
        />
      )
    },
    {
      key: "market",
      header: t("performance.col.market"),
      cell: (r) => <span className="whitespace-nowrap">{marketLabel(r.market, t)}</span>,
      hideBelow: "lg"
    },
    {
      key: "pick",
      header: t("performance.col.pick"),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="whitespace-nowrap">{selectionLabel(r.selection, t)}</span>
          <span className="whitespace-nowrap text-meta text-text-faint lg:hidden">{marketLabel(r.market, t)}</span>
        </span>
      ),
      hideBelow: "sm"
    },
    {
      key: "price",
      header: t("performance.col.price"),
      cell: (r) => fmt.odds(r.price_at_recommendation),
      align: "right",
      hideBelow: "sm"
    },
    {
      key: "edge",
      header: t("performance.col.edge"),
      headerTitle: t("performance.col.edgeTitle"),
      cell: (r) => <span className="whitespace-nowrap">{pp(r.edge)}</span>,
      align: "right",
      hideBelow: "md"
    },
    ...(hideModel
      ? []
      : [
          {
            key: "model",
            header: t("performance.col.model"),
            cell: (r: HistoryRow) => <ModelName name={r.model} showBaseline={false} />,
            hideBelow: "lg" as const
          }
        ]),
    {
      key: "result",
      header: t("performance.col.result"),
      cell: (r) => <StateBadge state={betState(r)} />
    },
    {
      key: "pnl",
      header: t("performance.col.pnl"),
      headerTitle: t("performance.col.pnlTitle"),
      cell: (r) => <Signed value={r.pnl} format="units" digits={3} />,
      align: "right"
    },
    {
      key: "clv",
      header: t("performance.col.clv"),
      headerTitle: t("performance.col.clvTitle"),
      cell: (r) => <Signed value={r.clv} format="pct" digits={2} />,
      align: "right",
      hideBelow: "sm"
    }
  ];

  const beyondLastPage = !pstatus.loading && result.rows.length === 0 && page > 0;

  return (
    <Panel
      title={t("performance.bets.title")}
      description={t("performance.bets.description")}
      padding="none"
      className={className}
      actions={
        <SegmentedControl
          label={t("performance.bets.statusLabel")}
          size="sm"
          value={status}
          onChange={(s) => state.setParam({ status: s === "settled" ? null : s, page: null })}
          options={STATUSES.map((s) => ({ value: s, label: t(`performance.bets.status.${s}`) }))}
        />
      }
    >
      {result.competitionIgnored && (
        <Callout tone="warn" className="m-4 mb-0">
          {t("performance.chart.legacyCompetition")}
        </Callout>
      )}
      {pstatus.error ? (
        <div className="p-4">
          <PanelError status={pstatus} />
        </div>
      ) : (
        <Table
          caption={t("performance.bets.caption")}
          columns={columns}
          rows={result.rows}
          rowKey={(r) => String(r.id)}
          rowHref={(r) => routes.match(locale, r.event_id)}
          linkColumn="match"
          loading={pstatus.loading}
          className={result.isPlaceholder ? "opacity-60" : undefined}
          empty={
            beyondLastPage ? (
              <EmptyState
                compact
                title={t("performance.pager.beyond")}
                action={
                  <Button size="sm" onClick={() => setPage(0)}>
                    {t("performance.pager.first")}
                  </Button>
                }
              />
            ) : (
              <NoBetsEmpty state={state} compact subject={status === "all" ? "any" : status} />
            )
          }
          footer={
            !pstatus.loading && result.rows.length > 0 ? (
              <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={result.total}
                shown={result.rows.length}
                busy={result.isFetching}
                onPage={setPage}
              />
            ) : undefined
          }
        />
      )}
    </Panel>
  );
}
