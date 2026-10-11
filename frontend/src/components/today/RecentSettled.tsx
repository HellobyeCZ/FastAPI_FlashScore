"use client";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLocale } from "@/contexts/LocaleContext";
import { EmptyState, Panel, QueryState, Signed, StateBadge, Table, TextLink, type Column } from "@/components/ui";
import { marketLabel, modelLabel, selectionLabel } from "@/lib/labels";
import { routes } from "@/lib/routes";
import type { TodayResponse, TodaySettled } from "@/hooks/useToday";
import { MatchName } from "./MatchName";

/**
 * The ten most recently settled bets, with how long ago each settled so old
 * results never pass for recent ones, and model + market so two models'
 * bets on the same match don't read as duplicates.
 */
export function RecentSettled({
  query,
  className
}: {
  query: UseQueryResult<TodayResponse>;
  className?: string;
}) {
  const { t, fmt, locale } = useLocale();
  const latest = query.data?.recent_settled[0]?.settled_at;

  const columns: Column<TodaySettled>[] = [
    {
      key: "match",
      header: t("common.event"),
      cell: (r) => (
        <>
          <MatchName pick={r} />
          <span className="block text-meta text-text-dim sm:hidden">
            {selectionLabel(r.selection, t)} @ {fmt.odds(r.price)} · {fmt.relative(r.settled_at)}
          </span>
        </>
      )
    },
    {
      key: "pick",
      header: t("common.selection"),
      hideBelow: "sm",
      cell: (r) => (
        <>
          <span className="whitespace-nowrap">{selectionLabel(r.selection, t)}</span>
          <span className="block text-meta text-text-dim">
            {marketLabel(r.market, t)} · {modelLabel(r.model, t)}
          </span>
        </>
      )
    },
    { key: "price", header: t("common.price"), align: "right", hideBelow: "md", cell: (r) => fmt.odds(r.price) },
    { key: "result", header: t("common.result"), cell: (r) => <StateBadge state={r.state} /> },
    {
      key: "pnl",
      header: t("common.pnl"),
      align: "right",
      cell: (r) => <Signed value={r.pnl} format="units" />
    },
    {
      key: "settled",
      header: t("today.recent.settled"),
      align: "right",
      hideBelow: "sm",
      cell: (r) => (
        <time dateTime={r.settled_at} title={fmt.dateTime(r.settled_at)} className="whitespace-nowrap text-text-dim">
          {fmt.relative(r.settled_at)}
        </time>
      )
    }
  ];

  return (
    <Panel
      className={className}
      title={t("today.recent.title")}
      description={latest ? t("today.recent.latest", { age: fmt.relative(latest) }) : undefined}
      actions={
        <TextLink href={routes.performance(locale)} className="text-meta">
          {t("today.recent.allResults")}
        </TextLink>
      }
      padding="none"
    >
      <div className={query.isError ? "p-4" : undefined}>
        <QueryState
          query={query}
          errorTitle={t("today.recent.error")}
          isEmpty={(d) => d.recent_settled.length === 0}
          empty={
            <EmptyState compact title={t("today.recent.empty")}>
              {t("today.recent.emptyBody")}
            </EmptyState>
          }
          loading={
            <Table
              columns={columns}
              rows={[]}
              rowKey={() => ""}
              caption={t("today.recent.caption")}
              loading
              skeletonRows={5}
            />
          }
        >
          {(d) => (
            <Table
              columns={columns}
              rows={d.recent_settled}
              rowKey={(r) => String(r.id)}
              caption={t("today.recent.caption")}
              rowHref={(r) => routes.match(locale, r.event_id)}
              linkColumn="match"
            />
          )}
        </QueryState>
      </div>
    </Panel>
  );
}
