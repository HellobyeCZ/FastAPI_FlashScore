"use client";
import Link from "next/link";
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  ModelName,
  Panel,
  Signed,
  Skeleton,
  StateBadge,
  Table,
  TextLink,
  type Column
} from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import type { Formatters } from "@/lib/format";
import { marketLabel, selectionLabel } from "@/lib/labels";
import { useEventPicks } from "@/lib/matches/queries";
import type { BacktestBetRow, PaperBetRow } from "@/lib/matches/types";
import { routes } from "@/lib/routes";

type T = ReturnType<typeof useLocale>["t"];

/** Settled bets show their result (won/lost/void); open ones their status. */
function betState(status: string, result: number | null): string | number | null {
  if (status === "voided") return "void";
  if (status === "settled" && result !== null) return result;
  return status;
}

/** Backtest labels are "<model>_<ISO timestamp>"; show them as "Run of <local time>". */
function runName(run: { run_id: string; run_label: string | null; model: string }, t: T, fmt: Formatters): string {
  const label = run.run_label ?? "";
  const stamp = label.startsWith(`${run.model}_`) ? label.slice(run.model.length + 1) : null;
  if (stamp && !Number.isNaN(Date.parse(stamp))) return t("matches.bets.runAt", { time: fmt.dateTime(stamp) });
  return label || run.run_id.slice(0, 8);
}

/** Live paper bets and backtest bets placed on this match, linking to their model and run. */
export function BetsPanel({ eventId }: { eventId: string }) {
  const { t, tp, locale } = useLocale();
  const picks = useEventPicks(eventId);
  const live = picks.data?.live ?? [];
  const backtest = picks.data?.backtest ?? [];

  return (
    <Panel id="bets" title={t("matches.bets.title")} description={t("matches.bets.description")}>
      {picks.isLoading ? (
        <Skeleton lines={4} />
      ) : picks.isError ? (
        <Callout
          tone="neg"
          title={t("matches.bets.error")}
          action={
            <Button size="sm" onClick={() => picks.refetch()} loading={picks.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(picks.error)}
        </Callout>
      ) : live.length === 0 && backtest.length === 0 ? (
        <EmptyState
          compact
          title={t("matches.bets.empty")}
          action={
            <ButtonLink href={routes.matches(locale, { bets: ["live", "backtest"] })} size="sm">
              {t("matches.bets.emptyAction")}
            </ButtonLink>
          }
        >
          {t("matches.bets.emptyBody")}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="bets-live" className="flex flex-col gap-2">
            <h3 id="bets-live" className="font-sans text-label uppercase tracking-label text-text-dim">
              {t("matches.bets.live")} · {tp("matches.bets.count", live.length)}
            </h3>
            {live.length === 0 ? (
              <p className="text-body text-text-dim">{t("matches.bets.liveEmpty")}</p>
            ) : (
              <LiveBetsTable rows={live} />
            )}
          </section>
          <section aria-labelledby="bets-backtest" className="flex flex-col gap-2">
            <h3 id="bets-backtest" className="font-sans text-label uppercase tracking-label text-text-dim">
              {t("matches.bets.backtest")} · {tp("matches.bets.count", backtest.length)}
            </h3>
            {backtest.length === 0 ? (
              <p className="text-body text-text-dim">{t("matches.bets.backtestEmpty")}</p>
            ) : (
              <BacktestBets rows={backtest} />
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

function ModelLink({ model }: { model: string }) {
  const { locale } = useLocale();
  return (
    <Link href={routes.model(locale, model)} className="hover:text-accent focus-visible:text-accent">
      <ModelName name={model} />
    </Link>
  );
}

function LiveBetsTable({ rows }: { rows: PaperBetRow[] }) {
  const { t, fmt } = useLocale();
  const columns: Column<PaperBetRow>[] = [
    { key: "model", header: t("common.model"), cell: (b) => <ModelLink model={b.model} /> },
    {
      key: "pick",
      header: t("common.selection"),
      cell: (b) => (
        <span className="flex flex-col leading-tight">
          <span>{selectionLabel(b.selection, t)}</span>
          <span className="text-meta text-text-dim">{marketLabel(b.market, t)}</span>
        </span>
      )
    },
    {
      key: "at",
      header: t("matches.bets.col.recommended"),
      hideBelow: "lg",
      cell: (b) => <span className="whitespace-nowrap text-text-dim">{fmt.dateTime(b.recommended_at)}</span>
    },
    { key: "price", header: t("common.price"), align: "right", cell: (b) => fmt.odds(b.price_at_recommendation) },
    {
      key: "closing",
      header: t("matches.bets.col.closing"),
      align: "right",
      hideBelow: "md",
      cell: (b) => fmt.odds(b.closing_price)
    },
    {
      key: "clv",
      header: t("common.clv"),
      headerTitle: t("matches.bets.col.clvTitle"),
      align: "right",
      hideBelow: "sm",
      cell: (b) => <Signed value={b.clv} format="pct" />
    },
    { key: "pnl", header: t("common.pnl"), align: "right", cell: (b) => <Signed value={b.pnl} format="units" /> },
    {
      key: "status",
      header: t("common.status"),
      cell: (b) => <StateBadge state={betState(b.status, b.result)} />
    }
  ];
  return (
    <Table<PaperBetRow>
      caption={t("matches.bets.live")}
      columns={columns}
      rows={rows}
      rowKey={(b) => String(b.id)}
    />
  );
}

function BacktestBets({ rows }: { rows: BacktestBetRow[] }) {
  const { t, tp, fmt, locale } = useLocale();
  const runs = new Map<string, BacktestBetRow[]>();
  for (const r of rows) runs.set(r.run_id, [...(runs.get(r.run_id) ?? []), r]);

  const columns: Column<BacktestBetRow>[] = [
    {
      key: "pick",
      header: t("common.selection"),
      cell: (b) => (
        <span className="flex flex-col leading-tight">
          <span>{selectionLabel(b.selection, t)}</span>
          <span className="text-meta text-text-dim">{marketLabel(b.market, t)}</span>
        </span>
      )
    },
    {
      key: "at",
      header: t("matches.bets.col.betAt"),
      hideBelow: "lg",
      cell: (b) => <span className="whitespace-nowrap text-text-dim">{fmt.dateTime(b.bet_ts)}</span>
    },
    { key: "price", header: t("common.price"), align: "right", cell: (b) => fmt.odds(b.price_taken) },
    {
      key: "prob",
      header: t("matches.bets.col.modelProb"),
      align: "right",
      hideBelow: "md",
      cell: (b) => fmt.pct(b.model_prob, 1)
    },
    {
      key: "edge",
      header: t("common.edge"),
      headerTitle: t("matches.model.col.edgeTitle"),
      align: "right",
      hideBelow: "md",
      cell: (b) => <Signed value={b.edge} format="pct" />
    },
    { key: "pnl", header: t("common.pnl"), align: "right", cell: (b) => <Signed value={b.pnl} format="units" /> },
    { key: "result", header: t("common.result"), cell: (b) => <StateBadge state={b.result} /> }
  ];

  return (
    <div className="flex flex-col gap-4">
      {Array.from(runs.entries()).map(([runId, bets]) => {
        const run = bets[0];
        const pnl = bets.reduce((sum, b) => sum + (b.pnl ?? 0), 0);
        return (
          <div key={runId} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body">
              <TextLink href={routes.backtest(locale, runId)}>{runName(run, t, fmt)}</TextLink>
              <ModelLink model={run.model} />
              <span className="text-meta text-text-dim">
                {tp("matches.bets.count", bets.length)} · <Signed value={pnl} format="units" />
              </span>
            </div>
            <Table<BacktestBetRow>
              caption={t("matches.bets.runCaption", { run: runName(run, t, fmt) })}
              columns={columns}
              rows={bets}
              rowKey={(b) => `${b.market}|${b.selection}`}
            />
          </div>
        );
      })}
      <p className="text-meta text-text-dim">{t("matches.bets.clvNote")}</p>
    </div>
  );
}
