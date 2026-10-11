"use client";
import { useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  Button,
  Callout,
  EmptyState,
  Panel,
  SegmentedControl,
  Skeleton,
  Table,
  type Column,
  type SegmentOption
} from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import { familyLabel, lineText, periodLabel, selectionText, type Teams } from "@/lib/matches/labels";
import {
  boardFromLive,
  boardFromStored,
  isQuoted,
  shortBookName,
  splitMarketKey,
  SUSPENDED_MAX,
  type BoardMarket,
  type BoardRow,
  type OddsBoard
} from "@/lib/matches/odds";
import { useLiveSnapshot, useLiveSnapshots, useStoredOdds } from "@/lib/matches/queries";
import { useDetailParams } from "./useDetailParams";

const STORED = "stored";
/** Lines either side of the main line shown before "show all lines". */
const LINE_WINDOW = 2;

type ViewRow =
  | { kind: "sel"; id: string; row: BoardRow; line: number | null; groupStart: boolean }
  | { kind: "margin"; id: string; line: number | null; margin: Record<string, number | null> };

/**
 * Odds by market. One market (family × period) is visible at a time, chosen
 * from a tab index; the snapshot strip swaps the stored snapshot for any live
 * capture. Market, period and capture live in the URL.
 */
export function OddsPanel({
  eventId,
  teams,
  terminal
}: {
  eventId: string;
  teams: Teams;
  terminal: boolean | undefined;
}) {
  const { t, fmt } = useLocale();
  const { get, set } = useDetailParams(eventId);
  const stored = useStoredOdds(eventId);
  const snapshots = useLiveSnapshots(eventId);

  // Without a stored snapshot the newest live capture is the default view.
  const requested = get("snap");
  const fallbackLive = stored.data === null ? (snapshots.data?.[0]?.fetched_at ?? null) : null;
  const snap = requested ?? fallbackLive;
  const live = useLiveSnapshot(eventId, snap);
  const active = snap ? live : stored;

  const board: OddsBoard | null = useMemo(() => {
    if (snap) return live.data ? boardFromLive(live.data.rows) : null;
    return stored.data ? boardFromStored(stored.data) : null;
  }, [snap, live.data, stored.data]);

  const fetchedAt = snap ? (live.data?.fetched_at ?? snap) : (stored.data?.fetched_at ?? null);

  const stripOptions: SegmentOption<string>[] = [
    ...(stored.data
      ? [{ value: STORED, label: t("matches.odds.storedChip", { time: fmt.dateTime(stored.data.fetched_at) }) }]
      : []),
    ...(snapshots.data ?? []).map((s) => ({ value: s.fetched_at, label: fmt.dateTime(s.fetched_at) }))
  ];

  const provenance =
    fetchedAt &&
    t(snap ? "matches.odds.provenance.live" : "matches.odds.provenance.stored", {
      time: fmt.dateTime(fetchedAt),
      age: fmt.relative(fetchedAt)
    });

  return (
    <Panel
      id="odds"
      title={t("matches.odds.title")}
      description={provenance || t("matches.odds.description")}
      padding="none"
    >
      {stripOptions.length > 1 && (
        <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
          <span aria-hidden className="font-sans text-label uppercase tracking-label text-text-dim">
            {t("matches.odds.snapshots")}
          </span>
          <div className="overflow-x-auto pb-1">
            <SegmentedControl
              label={t("matches.odds.snapshots")}
              size="sm"
              value={snap ?? STORED}
              options={stripOptions}
              onChange={(v) => set({ snap: v === STORED ? null : v })}
              className="min-w-max"
            />
          </div>
        </div>
      )}
      {snapshots.isError && (
        <Callout
          tone="warn"
          className="m-4"
          title={t("matches.odds.snapshotsError")}
          action={
            <Button size="sm" onClick={() => snapshots.refetch()} loading={snapshots.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(snapshots.error)}
        </Callout>
      )}
      {active.isLoading || (stored.data === null && snapshots.isLoading) ? (
        <Skeleton lines={8} className="p-4" />
      ) : active.isError ? (
        <Callout
          tone="neg"
          className="m-4"
          title={t("matches.odds.error")}
          action={
            <Button size="sm" onClick={() => active.refetch()} loading={active.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(active.error)}
        </Callout>
      ) : !board || board.markets.length === 0 ? (
        <EmptyState compact title={t("matches.odds.empty")}>
          {terminal === false ? t("matches.odds.emptyFetch") : t("matches.odds.emptyArchived")}
        </EmptyState>
      ) : (
        <MarketView
          key={snap ?? STORED}
          board={board}
          teams={teams}
          family={get("market")}
          period={get("period")}
          onSelect={(market, period) => set({ market, period })}
        />
      )}
    </Panel>
  );
}

function MarketView({
  board,
  teams,
  family: requestedFamily,
  period: requestedPeriod,
  onSelect
}: {
  board: OddsBoard;
  teams: Teams;
  family: string | null;
  period: string | null;
  onSelect: (family: string, period: string | null) => void;
}) {
  const { t, fmt } = useLocale();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const families = Array.from(new Set(board.markets.map((m) => m.family)));
  const family =
    requestedFamily && families.includes(requestedFamily)
      ? requestedFamily
      : families.includes("HOME_DRAW_AWAY")
        ? "HOME_DRAW_AWAY"
        : families[0];
  const inFamily = board.markets.filter((m) => m.family === family);
  const periods = inFamily.map((m) => m.period);
  const period =
    requestedPeriod && periods.includes(requestedPeriod)
      ? requestedPeriod
      : periods.includes("FULL_TIME")
        ? "FULL_TIME"
        : periods[0];
  const market = inFamily.find((m) => m.period === period) ?? inFamily[0];

  function onTabKey(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + families.length) % families.length;
    onSelect(families[next], null);
    tabRefs.current[next]?.focus();
  }

  const omitted = board.omitted.map((key) => {
    const { family: f, period: p } = splitMarketKey(key);
    return `${familyLabel(f, t)} (${periodLabel(p, t)})`;
  });

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto border-b border-border px-2">
        <div role="tablist" aria-label={t("matches.odds.markets")} className="flex min-w-max items-stretch gap-1">
          {families.map((f, i) => {
            const selected = f === family;
            return (
              <button
                key={f}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`odds-tab-${f}`}
                aria-selected={selected}
                aria-controls="odds-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(f, null)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={clsx(
                  "-mb-px inline-flex h-9 items-center border-b-2 px-3 font-sans text-label uppercase tracking-label transition-colors",
                  selected
                    ? "border-accent text-text"
                    : "border-transparent text-text-dim hover:border-border-strong hover:text-text"
                )}
              >
                {familyLabel(f, t)}
              </button>
            );
          })}
        </div>
      </div>
      <div id="odds-tabpanel" role="tabpanel" aria-labelledby={`odds-tab-${family}`} className="flex flex-col">
        {periods.length > 1 && (
          <div className="overflow-x-auto px-4 pt-3">
            <SegmentedControl
              label={t("matches.odds.period")}
              size="sm"
              value={period}
              options={periods.map((p) => ({ value: p, label: periodLabel(p, t) }))}
              onChange={(p) => onSelect(family, p)}
              className="min-w-max"
            />
          </div>
        )}
        {market && <MarketTable key={market.key} market={market} books={board.books} teams={teams} />}
        <div className="flex flex-col gap-1 border-t border-border px-4 py-2 text-meta text-text-dim">
          <ul aria-label={t("matches.odds.legend")} className="flex flex-wrap gap-x-4 gap-y-1">
            <li>
              <span aria-hidden className="text-accent">
                ▲
              </span>{" "}
              {t("matches.odds.legend.best")}
            </li>
            <li>
              <span aria-hidden>—</span> {t("matches.odds.legend.suspended", { max: fmt.odds(SUSPENDED_MAX) })}
            </li>
            <li>
              <span aria-hidden className="text-text-faint">
                ·
              </span>{" "}
              {t("matches.odds.legend.notOffered")}
            </li>
          </ul>
          {omitted.length > 0 && <p>{t("matches.odds.omitted", { markets: omitted.join(", ") })}</p>}
        </div>
      </div>
    </div>
  );
}

function MarketTable({ market, books, teams }: { market: BoardMarket; books: string[]; teams: Teams }) {
  const { t, fmt } = useLocale();
  const [allLines, setAllLines] = useState(false);

  // Books that quote anything in this market, in board order.
  const marketBooks = books.filter((b) => market.lines.some((l) => l.rows.some((r) => b in r.prices)));

  const mainIdx = Math.max(
    0,
    market.lines.findIndex((l) => l.line === market.mainLine)
  );
  const windowed =
    market.lineBased && !allLines && market.lines.length > LINE_WINDOW * 2 + 1
      ? market.lines.slice(Math.max(0, mainIdx - LINE_WINDOW), mainIdx + LINE_WINDOW + 1)
      : market.lines;
  const hidden = market.lines.length - windowed.length;

  const rows: ViewRow[] = windowed.flatMap((l, li) => {
    const sel: ViewRow[] = l.rows.map((row, i) => ({
      kind: "sel",
      id: `${l.line ?? ""}|${row.id}`,
      row,
      line: l.line,
      groupStart: li > 0 && i === 0
    }));
    return l.margin ? [...sel, { kind: "margin", id: `${l.line ?? ""}|margin`, line: l.line, margin: l.margin }] : sel;
  });

  const columns: Column<ViewRow>[] = [
    {
      key: "selection",
      header: t("matches.odds.col.selection"),
      cell: (r) => {
        if (r.kind === "margin") {
          return (
            <span className="text-meta text-text-dim" title={t("matches.odds.marginTitle")}>
              {t("matches.odds.margin")}
            </span>
          );
        }
        const s = selectionText(r.row.selection, market.family, r.line, teams, t, fmt);
        return (
          <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
            {s.code && <span className="shrink-0 font-mono text-text">{s.code}</span>}
            {/* Phones get the compact form so more bookmaker columns fit. */}
            {s.short && <span className="text-text-dim sm:hidden">{s.short}</span>}
            {s.label && (
              <span className="hidden min-w-0 max-w-[16rem] truncate font-sans text-text-dim sm:inline">{s.label}</span>
            )}
          </span>
        );
      }
    },
    ...marketBooks.map<Column<ViewRow>>((book) => ({
      key: `book:${book}`,
      header: shortBookName(book),
      headerTitle: book,
      align: "right",
      cell: (r) => {
        if (r.kind === "margin") {
          const m = r.margin[book];
          return <span className="text-meta text-text-dim">{m === undefined ? "" : fmt.pct(m, 1)}</span>;
        }
        return <PriceCell price={r.row.prices[book]} best={r.row.best?.book === book} />;
      }
    })),
    {
      key: "implied",
      header: t("matches.odds.col.implied"),
      headerTitle: t("matches.odds.col.impliedTitle"),
      align: "right",
      hideBelow: "sm",
      cell: (r) =>
        r.kind === "sel" && r.row.top ? <span className="text-text-dim">{fmt.pct(1 / r.row.top.price, 1)}</span> : null
    }
  ];

  return (
    <div className="flex flex-col">
      {marketBooks.length > 3 && (
        <p className="px-4 pt-2 text-meta text-text-faint sm:hidden">{t("matches.odds.scrollHint")}</p>
      )}
      <Table<ViewRow>
        caption={t("matches.odds.caption", {
          market: `${familyLabel(market.family, t)} · ${periodLabel(market.period, t)}`
        })}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(r) =>
          clsx(
            r.kind === "margin" && "bg-surface-2/40",
            r.kind === "sel" && r.groupStart && "border-t border-border-strong"
          )
        }
        className="mt-2"
      />
      {market.lineBased && market.lines.length > LINE_WINDOW * 2 + 1 && (
        <div className="px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setAllLines((v) => !v)} aria-expanded={allLines}>
            {allLines
              ? t("matches.odds.lessLines", {
                  line: market.mainLine === null ? "—" : lineText(market.mainLine, fmt, market.family !== "OVER_UNDER")
                })
              : t("matches.odds.allLines", { count: fmt.int(market.lines.length), hidden: fmt.int(hidden) })}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One price. Best = strictly highest with ≥ 2 books quoting; ≤ 1.01 = suspended placeholder. */
function PriceCell({ price, best }: { price: number | null | undefined; best: boolean }) {
  const { t, fmt } = useLocale();
  if (price === undefined || price === null) {
    return (
      <span className="text-text-faint">
        <span aria-hidden>·</span>
        <span className="sr-only">{t("matches.odds.notOffered")}</span>
      </span>
    );
  }
  if (!isQuoted(price)) {
    return (
      <span className="text-text-dim" title={t("matches.odds.suspendedTitle", { price: fmt.odds(price) })}>
        <span aria-hidden>—</span>
        <span className="sr-only">{t("matches.odds.suspended")}</span>
      </span>
    );
  }
  if (best) {
    return (
      <span className="inline-flex items-center gap-1 bg-accent/15 px-1 font-medium text-accent">
        <span aria-hidden className="text-label">
          ▲
        </span>
        {fmt.odds(price)}
        <span className="sr-only">{t("matches.odds.bestSr")}</span>
      </span>
    );
  }
  return <span className="text-text">{fmt.odds(price)}</span>;
}
