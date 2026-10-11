"use client";
import { useMemo } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { routes } from "@/lib/routes";
import { modelLabel } from "@/lib/labels";
import { MIN_N } from "@/lib/performance/filters";
import { dropFloatNoise, reconciledRoiInterval, wilson } from "@/lib/performance/stats";
import type { HistoryRow, StatsRow } from "@/lib/performance/types";
import { ModelName, SampleSize, Signed, Table, type Column, type SortState } from "@/components/ui";
import { BestMark } from "./shared";

type Row = StatsRow & { model: string };

/** Rows as displayed: a mean CLV of float noise is the 0 it stands for. */
const cleanRow = (r: Row): Row => ({ ...r, mean_clv: dropFloatNoise(r.mean_clv) });

type Metric = "roi" | "hit_rate" | "mean_clv" | "brier";

/**
 * Best value per metric among models with at least MIN_N bets (lowest Brier,
 * highest otherwise). "Best" needs a comparison: with fewer than two such
 * models nothing is marked.
 */
function bestModels(rows: Row[]): Partial<Record<Metric, string>> {
  const eligible = rows.filter((r) => r.n >= MIN_N);
  if (eligible.length < 2) return {};
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

/** Column keys the leaderboard can be sorted by (validated before reading the URL). */
export const LEADERBOARD_SORT_KEYS: readonly string[] = ["model", ...Object.keys(SORT_VALUE)];

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
  empty,
  loading
}: {
  rows: StatsRow[];
  /** Settled bets behind the rows (null while loading or when truncated). */
  settled: HistoryRow[] | null;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  linkParams: Record<string, string>;
  empty: React.ReactNode;
  loading?: boolean;
}) {
  const { t, fmt, locale } = useLocale();
  const rows = useMemo(
    () => rawRows.filter((r): r is Row => !!r.model).map(cleanRow),
    [rawRows]
  );
  const best = useMemo(() => bestModels(rows), [rows]);
  const roiIntervals = useMemo(() => {
    const out = new Map<string, ReturnType<typeof reconciledRoiInterval>>();
    if (!settled) return out;
    for (const r of rows) out.set(r.model, reconciledRoiInterval(settled.filter((b) => b.model === r.model), r.n));
    return out;
  }, [rows, settled]);

  const range = (low: number, high: number, signed: boolean) =>
    t("performance.leaderboard.interval", { low: fmt.pct(low, 0, signed), high: fmt.pct(high, 0, signed) });
  // Small samples dim their values only; the intervals under them stay readable.
  const dim = (r: Row) => clsx(r.n < MIN_N && "opacity-70");
  const hasBest = Object.values(best).some(Boolean);

  const columns: Column<Row>[] = [
    {
      key: "model",
      header: t("performance.col.model"),
      cell: (r) => (
        <span className="flex flex-col">
          <ModelName name={r.model} />
          {/* The n column is hidden on phones; keep the sample size with the name. */}
          <SampleSize n={r.n} className="sm:hidden" />
        </span>
      ),
      sortValue: (r) => modelLabel(r.model, t),
      firstDir: "asc"
    },
    {
      key: "n",
      header: t("performance.col.n"),
      headerTitle: t("performance.col.nTitle"),
      cell: (r) => <SampleSize n={r.n} className="whitespace-nowrap text-body" />,
      sortValue: SORT_VALUE.n,
      align: "right",
      hideBelow: "sm"
    },
    {
      key: "hit_rate",
      header: t("performance.col.hitRate"),
      cell: (r) => {
        const ci = wilson(r.wins, r.n);
        return (
          <span className="flex flex-col items-end">
            <span className="whitespace-nowrap">
              <span className={dim(r)}>{fmt.pct(r.hit_rate)}</span>
              {best.hit_rate === r.model && <BestMark />}
            </span>
            {ci && <span className="whitespace-nowrap text-meta text-text-faint">{range(ci.low, ci.high, false)}</span>}
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
            <span className="whitespace-nowrap">
              <Signed value={r.roi} format="pct" className={dim(r)} />
              {best.roi === r.model && <BestMark />}
            </span>
            {ci && <span className="whitespace-nowrap text-meta text-text-faint">{range(ci.low, ci.high, true)}</span>}
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
      cell: (r) => <Signed value={r.n > 0 ? r.pnl_total : null} format="units" className={dim(r)} />,
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
          <Signed value={r.mean_clv} format="pct" digits={2} className={dim(r)} />
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
          <span className={dim(r)}>{fmt.num(r.brier, 3)}</span>
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
          <span className={clsx("text-text-dim", dim(r))}>
            {t("performance.unit.units", { value: fmt.num(r.max_drawdown, 2) })}
          </span>
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
      sort={sort ?? DEFAULT_SORT}
      onSortChange={onSortChange}
      loading={loading}
      skeletonRows={4}
      empty={empty}
      footer={
        rows.length > 0
          ? hasBest
            ? t("performance.leaderboard.footer", { min: MIN_N })
            : t("performance.leaderboard.footerNoBest", { min: MIN_N })
          : undefined
      }
    />
  );
}
