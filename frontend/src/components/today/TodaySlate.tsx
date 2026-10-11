"use client";
import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Button,
  ButtonLink,
  EmptyState,
  Label,
  ModelName,
  Panel,
  QueryState,
  SegmentedControl,
  Signed,
  StateBadge,
  Table,
  type Column
} from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { competitionRoot } from "@/lib/competition";
import { DASH, parseDate } from "@/lib/format";
import { marketLabel, modelLabel, selectionLabel } from "@/lib/labels";
import { asRoute, routes } from "@/lib/routes";
import type { TodayPick, TodayResponse } from "./types";
import { MatchName } from "./MatchName";
import { EDGE_PRESETS, pipelineFreshness, passesEdge, snapEdge, type EdgePreset } from "./shared";

const HOUR_MS = 3_600_000;

type Mode = "today" | "next72h";

/**
 * Today's picks (viewer's local day), falling back to the next 72 hours when
 * nothing kicks off today. The edge threshold lives in `?edge=` so the view
 * can be shared; without it the saved Settings default applies.
 */
export function TodaySlate({ query }: { query: UseQueryResult<TodayResponse> }) {
  const { t, tp, fmt, locale } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const { settings } = useSettings();
  const edge: EdgePreset = snapEdge(params.get("edge")) ?? snapEdge(settings.minEdge) ?? 0;

  function setEdge(next: EdgePreset) {
    const q = new URLSearchParams(params.toString());
    // Written even for "All": a missing param means "use the saved default".
    q.set("edge", String(next));
    router.replace(asRoute(`${routes.today(locale)}?${q.toString()}`), { scroll: false });
  }

  const data = query.data;
  // The fallback is decided on the unfiltered window: a day whose picks are
  // all below the threshold says so instead of jumping to the next 72 hours.
  const mode: Mode = data && data.slate.length === 0 && data.upcoming72h.length > 0 ? "next72h" : "today";
  const rows = useMemo(() => (data ? (mode === "today" ? data.slate : data.upcoming72h) : []), [data, mode]);
  const shown = useMemo(() => rows.filter((r) => passesEdge(r.edge, edge)), [rows, edge]);
  const hidden = rows.length - shown.length;

  const columns: Column<TodayPick>[] = [
    {
      key: "kickoff",
      header: t("common.kickoff"),
      hideBelow: "sm",
      cell: (r) => (
        <time dateTime={r.kickoff ?? undefined} className="whitespace-nowrap">
          {fmt.time(r.kickoff)}
          {mode === "next72h" && <span className="block text-meta text-text-faint">{fmt.date(r.kickoff)}</span>}
        </time>
      )
    },
    {
      key: "league",
      header: t("common.league"),
      hideBelow: "md",
      cell: (r) => <span className="text-text-dim">{competitionRoot(r.competition) ?? DASH}</span>
    },
    {
      key: "match",
      header: t("common.event"),
      cell: (r) => {
        const league = competitionRoot(r.competition);
        return (
          <>
            <MatchName pick={r} />
            {/* Columns hidden on narrow screens fold into a second line. */}
            <span className="block text-meta text-text-dim lg:hidden">
              <span className="sm:hidden">
                {mode === "today" ? fmt.time(r.kickoff) : fmt.dateTime(r.kickoff)} ·{" "}
              </span>
              {league && <span className="md:hidden">{league} · </span>}
              {marketLabel(r.market, t)} · {modelLabel(r.model, t)}
            </span>
          </>
        );
      }
    },
    {
      key: "market",
      header: t("common.market"),
      hideBelow: "lg",
      cell: (r) => <span className="text-text-dim">{marketLabel(r.market, t)}</span>
    },
    {
      key: "pick",
      header: t("common.selection"),
      cell: (r) => (
        <>
          <span className="whitespace-nowrap">{selectionLabel(r.selection, t)}</span>
          <span className="block whitespace-nowrap text-meta text-text-dim sm:hidden">@ {fmt.odds(r.price)}</span>
          <StateBadge state={r.state} className="mt-1 sm:hidden" />
        </>
      )
    },
    { key: "price", header: t("common.price"), align: "right", hideBelow: "sm", cell: (r) => fmt.odds(r.price) },
    {
      key: "edge",
      header: t("common.edge"),
      headerTitle: t("today.slate.edgeTitle"),
      align: "right",
      cell: (r) => <Signed value={r.edge} format="pct" digits={1} />
    },
    { key: "model", header: t("common.model"), hideBelow: "lg", cell: (r) => <ModelName name={r.model} /> },
    { key: "status", header: t("common.status"), hideBelow: "sm", cell: (r) => <StateBadge state={r.state} /> }
  ];

  const edgeLabel = t("today.slate.edge");
  const filter = (
    <div className="flex flex-wrap items-center gap-2">
      <Label as="span" className="whitespace-nowrap">
        {edgeLabel}
      </Label>
      <SegmentedControl<string>
        label={edgeLabel}
        size="sm"
        value={String(edge)}
        onChange={(v) => setEdge(Number(v) as EdgePreset)}
        options={EDGE_PRESETS.map((p) => ({
          value: String(p),
          label: p === 0 ? t("common.all") : t("today.slate.edgeAtLeast", { value: fmt.pct(p, 0) })
        }))}
      />
    </div>
  );

  return (
    <Panel
      title={mode === "today" ? t("today.slate.title") : t("today.slate.title72h")}
      description={data ? windowText(data, mode) : undefined}
      actions={filter}
      padding="none"
      footer={
        data && !query.isError && shown.length > 0 ? (
          <>
            {tp("today.slate.count", shown.length)}
            {hidden > 0 && <> · {tp("today.slate.hidden", hidden)}</>}
          </>
        ) : undefined
      }
    >
      <div className={query.isError ? "p-4" : undefined}>
        <QueryState
          query={query}
          errorTitle={t("today.slate.error")}
          loading={<Table columns={columns} rows={[]} rowKey={() => ""} caption={t("today.slate.caption")} loading />}
        >
          {(d) =>
            shown.length > 0 ? (
              <Table
                columns={columns}
                rows={shown}
                rowKey={(r) => String(r.id)}
                caption={t("today.slate.caption")}
                rowHref={(r) => routes.match(locale, r.event_id)}
                linkColumn="match"
              />
            ) : (
              <SlateEmpty data={d} rows={rows} hidden={hidden} edge={edge} onShowAll={() => setEdge(0)} />
            )
          }
        </QueryState>
      </div>
    </Panel>
  );

  function windowText(d: TodayResponse, m: Mode): string {
    if (m === "today") return t("today.slate.window", { date: fmt.date(d.window.today_start), tz: d.window.tz });
    const generated = parseDate(d.generated_at);
    const end = generated ? new Date(generated.getTime() + 72 * HOUR_MS).toISOString() : null;
    return t("today.slate.window72h", { end: fmt.dateTime(end), tz: d.window.tz });
  }
}

/**
 * Why the slate is empty, and the action that fixes it: the edge filter hid
 * everything (show all), or there are no picks at all, which is explained by
 * pipeline freshness (never ran / stale → Data ops, fresh → nothing to bet).
 */
function SlateEmpty({
  data,
  rows,
  hidden,
  edge,
  onShowAll
}: {
  data: TodayResponse;
  rows: TodayPick[];
  hidden: number;
  edge: EdgePreset;
  onShowAll: () => void;
}) {
  const { t, tp, fmt, locale } = useLocale();

  if (rows.length > 0) {
    return (
      <EmptyState
        compact
        title={t("today.slate.empty.filtered", { edge: fmt.pct(edge, 0) })}
        action={
          <Button size="sm" onClick={onShowAll}>
            {t("today.slate.empty.showAll")}
          </Button>
        }
      >
        {tp("today.slate.empty.filteredBody", hidden)}
      </EmptyState>
    );
  }

  const freshness = pipelineFreshness(data.last_recommended_at);
  const age = fmt.relative(data.last_recommended_at);
  const opsLink = (
    <ButtonLink href={routes.ops(locale)} size="sm" variant="primary">
      {t("today.slate.openOps")}
    </ButtonLink>
  );

  if (freshness === "never") {
    return (
      <EmptyState compact title={t("today.slate.empty.never")} action={opsLink}>
        {t("today.slate.empty.neverBody")}
      </EmptyState>
    );
  }
  if (freshness !== "fresh") {
    return (
      <EmptyState compact title={t("today.slate.empty.stale")} action={opsLink}>
        {t("today.slate.empty.staleBody", { age })}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      compact
      title={t("today.slate.empty.none")}
      action={
        <ButtonLink href={routes.matches(locale)} size="sm">
          {t("today.slate.openMatches")}
        </ButtonLink>
      }
    >
      {t("today.slate.empty.noneBody", { age })}
    </EmptyState>
  );
}
