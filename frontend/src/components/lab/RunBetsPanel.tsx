"use client";
import { useCallback } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout, EmptyState, Panel, Signed, StateBadge, Table, type Column } from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import { marketLabel, selectionLabel } from "@/lib/labels";
import { asRoute, buildQuery, routes } from "@/lib/routes";
import { useRunBets, type BacktestRunDetail, type RunBet } from "@/lib/lab/backtests";
import { competitionName } from "@/lib/lab/format";
import { useSearchState } from "@/lib/lab/hooks";

const PAGE_SIZE = 50;

/** Paginated bets of one run (page number lives in the URL as ?page=). */
export function RunBetsPanel({ run }: { run: BacktestRunDetail }) {
  const { t, tp, fmt, locale } = useLocale();
  const build = useCallback(
    (q: Record<string, string>) => asRoute(`${routes.backtest(locale, run.id)}${buildQuery(q)}`),
    [locale, run.id]
  );
  const { params, set } = useSearchState(build);
  const hasBets = (run.total_bets ?? 0) > 0;
  const requested = Number.parseInt(params.get("page") ?? "1", 10);
  const knownTotal = run.total_bets ?? 0;
  const lastPage = Math.max(1, Math.ceil(knownTotal / PAGE_SIZE));
  const page = Number.isFinite(requested) ? Math.min(Math.max(1, requested), lastPage) : 1;
  const bets = useRunBets(run.id, page, PAGE_SIZE, run.status === "completed" && hasBets);
  const total = bets.data?.total ?? knownTotal;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  const columns: Column<RunBet>[] = [
    {
      key: "match",
      header: t("common.event"),
      cell: (b) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          {b.home_team && b.away_team ? (
            <span className="text-text">
              {b.home_team} – {b.away_team}
            </span>
          ) : (
            <span className="font-mono text-text-dim" title={t("lab.bets.noTeams")}>
              {b.event_id}
            </span>
          )}
          <span className="text-meta text-text-faint">
            {[competitionName(b.competition), fmt.dateTime(b.kickoff ?? b.bet_ts)].filter(Boolean).join(" · ")}
          </span>
        </span>
      )
    },
    {
      key: "pick",
      header: t("common.selection"),
      cell: (b) => (
        <span className="flex flex-col gap-0.5">
          <span>{selectionLabel(b.selection, t)}</span>
          <span className="hidden whitespace-nowrap text-meta text-text-faint sm:block">{marketLabel(b.market, t)}</span>
        </span>
      )
    },
    { key: "price", header: t("common.odds"), align: "right", hideBelow: "sm", cell: (b) => fmt.odds(b.price) },
    {
      key: "prob",
      header: t("lab.bets.col.modelProb"),
      headerTitle: t("lab.bets.col.modelProb.title"),
      align: "right",
      hideBelow: "md",
      cell: (b) => fmt.pct(b.model_prob)
    },
    {
      key: "edge",
      header: t("common.edge"),
      align: "right",
      hideBelow: "md",
      cell: (b) => <Signed value={b.edge} format="pct" />
    },
    { key: "result", header: t("common.result"), hideBelow: "sm", cell: (b) => <StateBadge state={b.result} /> },
    { key: "pnl", header: t("common.pnl"), align: "right", cell: (b) => <Signed value={b.pnl} format="units" digits={3} /> }
  ];

  return (
    <Panel
      title={t("lab.bets.title")}
      description={t("lab.bets.description")}
      padding="none"
      actions={hasBets ? <span className="text-meta text-text-dim">{tp("lab.bets", total, { n: fmt.int(total) })}</span> : undefined}
    >
      {!hasBets ? (
        <EmptyState compact title={t("lab.bets.empty")} />
      ) : bets.isError ? (
        <div className="p-4">
          <Callout
            tone="neg"
            title={t("lab.bets.error")}
            action={
              <Button size="sm" onClick={() => bets.refetch()} loading={bets.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(bets.error)}
          </Callout>
        </div>
      ) : (
        <Table
          caption={t("lab.bets.caption")}
          columns={columns}
          rows={bets.data?.rows ?? []}
          rowKey={(b) => b.key}
          rowHref={(b) => routes.match(locale, b.event_id)}
          linkColumn="match"
          loading={bets.isLoading}
          skeletonRows={8}
          className={bets.isFetching && !bets.isLoading ? "opacity-60" : undefined}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="tabular-nums">{t("lab.bets.range", { from: fmt.int(from), to: fmt.int(to), total: fmt.int(total) })}</span>
              <span className="flex items-center gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => set({ page: page - 1 > 1 ? String(page - 1) : null })}>
                  {t("lab.bets.prev")}
                </Button>
                <span className="tabular-nums text-text-faint">{t("lab.bets.page", { page, pages })}</span>
                <Button size="sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
                  {t("lab.bets.next")}
                </Button>
              </span>
            </div>
          }
        />
      )}
      <p className="border-t border-border px-4 py-2 text-meta text-text-faint">{t("lab.bets.clvNote")}</p>
    </Panel>
  );
}
