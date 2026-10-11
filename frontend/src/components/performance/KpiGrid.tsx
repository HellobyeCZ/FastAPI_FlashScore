"use client";
import { useLocale } from "@/contexts/LocaleContext";
import type { RowsResult } from "@/lib/performance/api";
import { reconciledRoiInterval, wilson, type Interval } from "@/lib/performance/stats";
import type { StatsRow } from "@/lib/performance/types";
import { SampleSize, Signed, Skeleton, Stat, StatGrid } from "@/components/ui";
import { PanelError, type PanelStatus } from "./shared";

/**
 * Headline numbers for the current window/filters. Every tile names its
 * window and n; undefined metrics (no settled bets, nothing staked) are "—".
 */
export function KpiGrid({
  status,
  overall,
  rows,
  windowText
}: {
  status: PanelStatus;
  overall: StatsRow | undefined;
  /** The settled bets behind `overall`, for intervals and CLV coverage. */
  rows: RowsResult;
  windowText: string;
}) {
  const { t, tp, fmt } = useLocale();

  if (status.error) return <div className="mb-5"><PanelError status={status} /></div>;

  if (status.loading) {
    return (
      <StatGrid cols={5} className="mb-5 grid-cols-2">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={i === 0 ? "col-span-2 px-4 py-3 sm:col-span-1" : "px-4 py-3"}>
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </StatGrid>
    );
  }

  const n = overall?.n ?? 0;
  const hit = wilson(overall?.wins, n);
  const roiCi = rows.isLoading || rows.truncated ? null : reconciledRoiInterval(rows.rows, n);
  const clvRows = !rows.isLoading && !rows.truncated && rows.rows.length === n ? rows.rows.filter((r) => r.clv !== null) : null;
  const ci = (i: Interval | null, signed: boolean) =>
    i ? t("performance.kpi.ci", { low: fmt.pct(i.low, 0, signed), high: fmt.pct(i.high, 0, signed) }) : null;

  const sub = (extra: string | null) => (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <SampleSize n={n} />
      {extra && <span>{extra}</span>}
    </span>
  );

  return (
    <StatGrid cols={5} className="mb-5 grid-cols-2">
      <Stat
        className="col-span-2 sm:col-span-1"
        label={t("performance.kpi.settled")}
        value={fmt.int(n)}
        sub={windowText}
      />
      <Stat
        label={t("performance.kpi.pnl")}
        value={<Signed value={n > 0 ? overall?.pnl_total : null} format="units" />}
        sub={sub(null)}
      />
      <Stat
        label={t("performance.kpi.roi")}
        value={<Signed value={overall?.roi} format="pct" />}
        sub={sub(ci(roiCi, true))}
      />
      <Stat
        label={t("performance.kpi.hitRate")}
        value={fmt.pct(overall?.hit_rate)}
        sub={sub(ci(hit, false))}
      />
      <Stat
        label={t("performance.kpi.clv")}
        value={<Signed value={overall?.mean_clv} format="pct" digits={2} />}
        sub={sub(clvRows ? tp("performance.kpi.clvCoverage", clvRows.length, { count: fmt.int(clvRows.length) }) : null)}
      />
    </StatGrid>
  );
}
