"use client";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLocale } from "@/contexts/LocaleContext";
import { SampleSize, Skeleton, Stat, StatGrid, TextLink } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { useElementWidth } from "@/hooks/useElementWidth";
import { DASH, signTone } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { TodayResponse } from "./types";
import { FRESHNESS_TONE, pipelineFreshness } from "./shared";

/** Below this many settled bets the 30-day P&L is flagged as noise. */
const SMALL_SAMPLE = 30;

// Phones get a 2-column grid: the two short integer tiles share a row and the
// tiles with long values (signed units + sparkline, relative time) span it.
const WIDE_ON_PHONE = "col-span-2 sm:col-span-1";

/**
 * KPI strip. Every tile names its window, and a metric with no data renders
 * as an em dash with the reason, never as 0. On a failed /api/today the tiles
 * stay in place with dashes so the page layout and the other panels survive.
 */
export function TodayKpis({ query }: { query: UseQueryResult<TodayResponse> }) {
  const { t } = useLocale();
  const { data, isLoading, isError } = query;

  if (isLoading || isError || !data) {
    const placeholder = isLoading ? <Skeleton className="h-8 w-24" /> : DASH;
    const sub = isLoading ? <Skeleton className="h-3 w-32" /> : t("today.kpi.unavailable");
    return (
      <section aria-label={t("today.kpi.title")} aria-busy={isLoading || undefined}>
        <StatGrid cols={4} className="grid-cols-2">
          <Stat className={WIDE_ON_PHONE} label={t("today.kpi.pnl")} value={placeholder} sub={sub} />
          <Stat label={t("today.kpi.open")} value={placeholder} sub={sub} />
          <Stat label={t("today.kpi.awaiting")} value={placeholder} sub={sub} />
          <Stat className={WIDE_ON_PHONE} label={t("today.kpi.pipeline")} value={placeholder} sub={sub} />
        </StatGrid>
      </section>
    );
  }

  return (
    <section aria-label={t("today.kpi.title")}>
      <StatGrid cols={4} className="grid-cols-2">
        <PnlStat data={data} />
        <OpenStat data={data} />
        <AwaitingStat data={data} />
        <PipelineStat data={data} />
      </StatGrid>
    </section>
  );
}

function PnlStat({ data }: { data: TodayResponse }) {
  const { t, tp, fmt } = useLocale();
  const { n, pnl, series } = data.pnl30d;

  if (n === 0 || pnl === null) {
    return (
      <Stat
        className={WIDE_ON_PHONE}
        label={t("today.kpi.pnl")}
        value={DASH}
        sub={
          data.last_settled_at
            ? t("today.kpi.pnl.empty", { age: fmt.relative(data.last_settled_at) })
            : t("today.kpi.pnl.never")
        }
      />
    );
  }

  // The window starts flat, so the line begins at zero.
  const points = [0, ...series.map((p) => p.cum_pnl)];
  return (
    <Stat
      className={WIDE_ON_PHONE}
      label={t("today.kpi.pnl")}
      value={fmt.units(pnl)}
      tone={signTone(pnl)}
      // A small sample says so in the caution line (which also dims the value).
      sub={n >= SMALL_SAMPLE ? <SampleSize n={n} min={SMALL_SAMPLE} /> : undefined}
      caution={n < SMALL_SAMPLE ? t("common.smallSample", { n }) : undefined}
    >
      <PnlSparkline points={points} label={tp("today.kpi.pnl.chart", n)} />
    </Stat>
  );
}

/** Cumulative P&L line sized to the tile (mounted only when there is a series). */
function PnlSparkline({ points, label }: { points: number[]; label: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="mt-1 h-7 w-full">
      {width > 0 && <Sparkline points={points} width={width} height={28} ariaLabel={label} />}
    </div>
  );
}

function OpenStat({ data }: { data: TodayResponse }) {
  const { t, tp, fmt } = useLocale();
  return (
    <Stat
      label={t("today.kpi.open")}
      value={fmt.int(data.open72h.count)}
      sub={tp("today.kpi.open.today", data.open72h.today_count)}
    />
  );
}

function AwaitingStat({ data }: { data: TodayResponse }) {
  const { t, tp, fmt } = useLocale();
  const { count, overdue_count, unscheduled_count, oldest_kickoff } = data.pending;
  const status =
    overdue_count > 0
      ? tp("today.kpi.awaiting.overdue", overdue_count, { age: fmt.relative(oldest_kickoff) })
      : count > 0
        ? t("today.kpi.awaiting.onTime")
        : t("today.kpi.awaiting.none");
  return (
    <Stat
      label={t("today.kpi.awaiting")}
      value={fmt.int(count)}
      tone={overdue_count > 0 ? "warn" : "neutral"}
      sub={
        <>
          {status}
          {unscheduled_count > 0 && (
            <span className="block text-warn">{tp("today.kpi.awaiting.unscheduled", unscheduled_count)}</span>
          )}
        </>
      }
    />
  );
}

function PipelineStat({ data }: { data: TodayResponse }) {
  const { t, fmt, locale } = useLocale();
  const last = data.last_recommended_at;
  const freshness = pipelineFreshness(last);
  return (
    <Stat
      className={WIDE_ON_PHONE}
      label={t("today.kpi.pipeline")}
      value={last ? fmt.relative(last) : DASH}
      tone={FRESHNESS_TONE[freshness]}
      sub={last ? t("today.kpi.pipeline.at", { time: fmt.dateTime(last) }) : t("today.kpi.pipeline.never")}
    >
      <TextLink href={routes.ops(locale)} className="w-fit text-meta">
        {t("today.kpi.pipeline.ops")}
      </TextLink>
    </Stat>
  );
}
