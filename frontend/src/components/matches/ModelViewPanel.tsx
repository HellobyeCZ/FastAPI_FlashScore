"use client";
import { Button, ButtonLink, Callout, EmptyState, Panel, Signed, Skeleton, Table, type Column } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import { marketLabel, modelLabel, selectionLabel } from "@/lib/labels";
import type { Teams } from "@/lib/matches/labels";
import { findRow, marketRef, selectionKind, shortBookName, type OddsBoard } from "@/lib/matches/odds";
import { usePrediction, useReferenceBoard } from "@/lib/matches/queries";
import type { Prediction } from "@/lib/matches/types";
import { routes } from "@/lib/routes";
import { ModelLink } from "./ModelLink";

const SELECTION_ORDER = ["home", "draw", "away", "over", "under", "yes", "no"];

type Row = Prediction & { best: { price: number; book: string } | null };

function bestPrice(board: OddsBoard | null, p: Prediction): Row["best"] {
  if (!board) return null;
  const ref = marketRef(p.market);
  const kind = selectionKind(p.selection);
  if (!ref || !kind) return null;
  return findRow(board, ref, kind)?.top ?? null;
}

/**
 * What each served model thinks of this match: model vs de-vigged market
 * probability, edge, fair odds and the best price currently stored.
 */
export function ModelViewPanel({ eventId, teams, finished }: { eventId: string; teams: Teams; finished: boolean }) {
  const { t, fmt, locale } = useLocale();
  const prediction = usePrediction(eventId);
  const reference = useReferenceBoard(eventId);

  const served = Object.entries(prediction.data?.available_models ?? {})
    .filter(([, loaded]) => loaded)
    .map(([name]) => name);
  const predictions = prediction.data?.predictions ?? [];
  const rows: Row[] = predictions
    .map((p) => ({ ...p, best: bestPrice(reference.board, p) }))
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.market.localeCompare(b.market) ||
        SELECTION_ORDER.indexOf(a.selection.toLowerCase()) - SELECTION_ORDER.indexOf(b.selection.toLowerCase())
    );

  const team = (selection: string) =>
    selection.toLowerCase() === "home" ? teams.home : selection.toLowerCase() === "away" ? teams.away : null;

  const columns: Column<Row>[] = [
    {
      key: "model",
      header: t("common.model"),
      hideBelow: "sm",
      cell: (r) => <ModelLink model={r.model} />
    },
    {
      key: "pick",
      header: t("common.selection"),
      cell: (r) => (
        <span className="flex flex-col gap-0.5 leading-tight">
          {/* The model column is hidden on phones; name the model here instead. */}
          <ModelLink model={r.model} className="sm:hidden" wrap />
          <span>
            {selectionLabel(r.selection, t)}
            {team(r.selection) && <span className="text-text-dim"> · {team(r.selection)}</span>}
          </span>
          <span className="whitespace-nowrap text-meta text-text-dim">{marketLabel(r.market, t)}</span>
        </span>
      )
    },
    {
      key: "model_prob",
      header: t("matches.model.col.modelProb"),
      align: "right",
      cell: (r) => fmt.pct(r.model_prob, 1)
    },
    {
      key: "market_prob",
      header: t("matches.model.col.marketProb"),
      headerTitle: t("matches.model.col.marketProbTitle"),
      align: "right",
      hideBelow: "sm",
      cell: (r) => <span className="text-text-dim">{fmt.pct(r.market_devigged, 1)}</span>
    },
    {
      key: "edge",
      header: t("common.edge"),
      headerTitle: t("matches.model.col.edgeTitle"),
      align: "right",
      cell: (r) => <Signed value={r.edge} format="pct" />
    },
    {
      key: "fair",
      header: t("matches.model.col.fair"),
      headerTitle: t("matches.model.col.fairTitle"),
      align: "right",
      hideBelow: "md",
      cell: (r) => fmt.odds(r.model_prob && r.model_prob > 0 ? 1 / r.model_prob : null)
    },
    {
      key: "best",
      header: t("matches.model.col.best"),
      headerTitle: t("matches.model.col.bestTitle"),
      align: "right",
      hideBelow: "sm",
      cell: (r) =>
        r.best ? (
          <span className="flex flex-col items-end leading-tight">
            <span>{fmt.odds(r.best.price)}</span>
            <span className="text-meta text-text-dim">{shortBookName(r.best.book)}</span>
          </span>
        ) : (
          "—"
        )
    },
    {
      key: "ev",
      header: t("matches.model.col.ev"),
      headerTitle: t("matches.model.col.evTitle"),
      align: "right",
      hideBelow: "lg",
      cell: (r) => (
        <Signed value={r.best && r.model_prob !== null ? r.model_prob * r.best.price - 1 : null} format="pct" />
      )
    }
  ];

  const sourceNote = reference.source
    ? t(reference.source.kind === "stored" ? "matches.model.bestFromStored" : "matches.model.bestFromLive", {
        time: fmt.dateTime(reference.source.fetchedAt)
      })
    : null;

  return (
    <Panel
      id="model"
      title={t("matches.model.title")}
      description={t("matches.model.description")}
      footer={
        rows.length > 0 ? (
          <>
            {t("matches.model.served", { models: served.map((m) => modelLabel(m, t)).join(", ") })}
            {sourceNote && <> · {sourceNote}</>}
          </>
        ) : undefined
      }
      padding={rows.length > 0 ? "none" : "md"}
    >
      {prediction.isLoading ? (
        <Skeleton lines={4} />
      ) : prediction.isError ? (
        <Callout
          tone="neg"
          title={t("matches.model.error")}
          action={
            <Button size="sm" onClick={() => prediction.refetch()} loading={prediction.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(prediction.error)}
        </Callout>
      ) : rows.length === 0 ? (
        <div className="flex flex-col gap-3">
          {served.length === 0 ? (
            <EmptyState
              compact
              title={t("matches.model.noModels")}
              action={
                <ButtonLink href={routes.registry(locale)} size="sm">
                  {t("matches.model.openRegistry")}
                </ButtonLink>
              }
            >
              {t("matches.model.noModelsBody")}
            </EmptyState>
          ) : (
            <EmptyState compact title={t("matches.model.empty")}>
              {t("matches.model.emptyBody", { models: served.map((m) => modelLabel(m, t)).join(", ") })}
            </EmptyState>
          )}
          {finished && <Callout tone="info">{t("matches.model.finishedNote")}</Callout>}
        </div>
      ) : (
        <Table<Row>
          caption={t("matches.model.caption")}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.model}|${r.market}|${r.selection}`}
        />
      )}
    </Panel>
  );
}
