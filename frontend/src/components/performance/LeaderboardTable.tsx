"use client";
import { useMemo } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { routes } from "@/lib/routes";
import { modelLabel } from "@/lib/labels";
import { MIN_N } from "@/lib/performance/filters";
import { reconciledRoiInterval, wilson } from "@/lib/performance/stats";
import type { HistoryRow, StatsRow } from "@/lib/performance/types";
import { ModelName, SampleSize, Signed, Table, type Column, type SortState } from "@/components/ui";
import { BestMark } from "./shared";

type Row = StatsRow & { model: string };

type Metric = "roi" | "hit_rate" | "mean_clv" | "brier";

/** Best value per metric among models with at least MIN_N bets (lowest Brier, highest otherwise). */
function bestModels(rows: Row[]): Partial<Record<Metric, string>> {
  const eligible = rows.filter((r) => r.n >= MIN_N);
  const pick = (metric: Metric, lowerIsBetter = false) => {
    let best: Row | undefined;
    for (const r of eligible) {
      const v = r[metric];
      if (v === null || v === undefined) continue;
      const b = best?.[metric];
      if (b === null || b === undefined || (lowerIsBetter ? v < b : v > b)) best = r;
    }
    return best?.model;
  };
  return { roi: pick("roi"), hit_rate: pick("hit_rate"), mean_clv: pick("mean_clv"), brier: pick("brier", true) };
}

export const DEFAULT_SORT: NonNullable<SortState> = { key: "roi", dir: "desc" };

/** Sort keys for the numeric columns (the model column sorts by its label). */
const SORT_VALUE: Record<string, (r: Row) => number | null> = {
  n: (r) => r.n,
  hit_rate: (r) => r.hit_rate,
  roi: (r) => r.roi,
  pnl: (r) => r.pnl_total,
  mean_clv: (r) => r.mean_clv,
  brier: (r) => r.brier,
  max_drawdown: (r) => r.max_drawdown
};

function sortRows(rows: Row[], sort: NonNullable<SortState>, label: (r: Row) => string): Row[] {
  const value = sort.key === "model" ? label : SORT_VALUE[sort.key];
  if (!value) return rows;
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    // Missing values sort last in both directions.
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

/**
 * Live leaderboard, one row per model. Small samples are dimmed and never
 * marked best; hit rate and ROI carry 95% intervals so noise reads as noise.
 */
export function LeaderboardTable({
  rows: rawRows,
  settled,
  sort,
  onSortChange,
  linkParams,
  empty
}: {
  rows: StatsRow[];
  /** Settled bets behind the rows (null while loading or when truncated). */
  settled: HistoryRow[] | null;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  linkParams: Record<string, string>;
  empty: React.ReactNode;
}) {
  const { t, fmt, locale } = useLocale();
  const rows = useMemo(() => rawRows.filter((r): r is Row => !!r.model), [rawRows]);
  const best = useMemo(() => bestModels(rows), [rows]);
  const roiIntervals = useMemo(() => {
    const out = new Map<string, ReturnType<typeof reconciledRoiInterval>>();
    if (!settled) return out;
    for (const r of rows) out.set(r.model, reconciledRoiInterval(settled.filter((b) => b.model === r.model), r.n));
    return out;
  }, [rows, settled]);

  const range = (low: number, high: number, signed: boolean) =>
    t("performance.leaderboard.interval", { low: fmt.pct(low, 0, signed), high: fmt.pct(high, 0, signed) });

  const columns: Column<Row>[] = [
    {
      key: "model",
      header: t("performance.col.model"),
      cell: (r) => <ModelName name={r.model} />,
      sortValue: (r) => modelLabel(r.model, t),
      firstDir: "asc",
      className: "max-w-48 sm:max-w-none"
    },
    {
      key: "n",
      header: t("performance.col.n"),
      headerTitle: t("performance.col.nTitle"),
      cell: (r) => <SampleSize n={r.n} className="text-body" />,
      sortValue: SORT_VALUE.n,
      align: "right"
    },
    {
      key: "hit_rate",
      header: t("performance.col.hitRate"),
      cell: (r) => {
        const ci = wilson(r.wins, r.n);
        return (
          <span className="flex flex-col items-end">
            <span>
              {fmt.pct(r.hit_rate)}
              {best.hit_rate === r.model && <BestMark />}
            </span>
            {ci && <span className="text-meta text-text-faint">{range(ci.low, ci.high, false)}</span>}
          </span>
        );
      },
      sortValue: SORT_VALUE.hit_rate,
      align: "right",
      hideBelow: "md"
    },
    {
      key: "roi",
      header: t("performance.col.roi"),
      cell: (r) => {
        const ci = roiIntervals.get(r.model);
        return (
          <span className="flex flex-col items-end">
            <span>
              <Signed value={r.roi} format="pct" />
              {best.roi === r.model && <BestMark />}
            </span>
            {ci && <span className="text-meta text-text-faint">{range(ci.low, ci.high, true)}</span>}
          </span>
        );
      },
      sortValue: SORT_VALUE.roi,
      align: "right"
    },
    {
      key: "pnl",
      header: t("performance.col.pnl"),
      headerTitle: t("performance.col.pnlTitle"),
      cell: (r) => <Signed value={r.n > 0 ? r.pnl_total : null} format="units" />,
      sortValue: SORT_VALUE.pnl,
      align: "right",
      hideBelow: "sm"
    },
    {
      key: "mean_clv",
      header: t("performance.col.clv"),
      headerTitle: t("performance.col.clvTitle"),
      cell: (r) => (
        <>
          <Signed value={r.mean_clv} format="pct" digits={2} />
          {best.mean_clv === r.model && <BestMark />}
        </>
      ),
      sortValue: SORT_VALUE.mean_clv,
      align: "right",
      hideBelow: "md"
    },
    {
      key: "brier",
      header: t("performance.col.brier"),
      headerTitle: t("performance.col.brierTitle"),
      cell: (r) => (
        <>
          {fmt.num(r.brier, 3)}
          {best.brier === r.model && <BestMark />}
        </>
      ),
      sortValue: SORT_VALUE.brier,
      firstDir: "asc",
      align: "right",
      hideBelow: "lg"
    },
    {
      key: "max_drawdown",
      header: t("performance.col.maxDrawdown"),
      headerTitle: t("performance.col.maxDrawdownTitle"),
      cell: (r) =>
        r.n > 0 && r.max_drawdown !== null ? (
          <span className="text-text-dim">{t("performance.unit.units", { value: fmt.num(r.max_drawdown, 2) })}</span>
        ) : (
          fmt.num(null)
        ),
      sortValue: SORT_VALUE.max_drawdown,
      firstDir: "asc",
      align: "right",
      hideBelow: "lg"
    }
  ];

  const sorted = useMemo(
    () => sortRows(rows, sort ?? DEFAULT_SORT, (r) => modelLabel(r.model, t)),
    [rows, sort, t]
  );

  return (
    <Table
      caption={t("performance.leaderboard.caption")}
      columns={columns}
      rows={sorted}
      rowKey={(r) => r.model}
      rowHref={(r) => routes.model(locale, r.model, linkParams)}
      linkColumn="model"
      rowClassName={(r) => (r.n < MIN_N ? "opacity-70" : undefined)}
      sort={sort ?? DEFAULT_SORT}
      onSortChange={onSortChange}
      empty={empty}
      footer={rows.length > 0 ? t("performance.leaderboard.footer", { min: MIN_N }) : undefined}
    />
  );
}
