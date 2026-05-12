"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  fetchStats,
  fetchCalibration,
  fetchHistory,
  type StatsRow,
  type CalibrationBucket,
  type HistoryRow,
} from "@/lib/api-picks";
import { CalibrationPlot } from "@/components/terminal/charts/CalibrationPlot";
import {
  WaterfallChart,
  type WaterfallBar,
} from "@/components/terminal/charts/WaterfallChart";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Kicker } from "@/components/terminal/Kicker";
import { Stat } from "@/components/terminal/Stat";

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

const SECTION_CLASS = "border border-border p-4";

export function ModelDeepDive({ model }: { model: string }) {
  const { t } = useLocale();

  const [summary, setSummary] = useState<StatsRow | null>(null);
  const [bySelection, setBySelection] = useState<StatsRow[]>([]);
  const [byCompetition, setByCompetition] = useState<StatsRow[]>([]);
  const [calibration, setCalibration] = useState<CalibrationBucket[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, sel, comp, calib, hist] = await Promise.all([
          fetchStats([], { model: [model], status: "settled" }),
          fetchStats(["selection"], { model: [model], status: "settled" }),
          fetchStats(["competition"], { model: [model], status: "settled" }),
          fetchCalibration(model),
          fetchHistory({ status: "settled", limit: 500 }),
        ]);
        if (cancelled) return;
        setSummary(s.rows[0] ?? null);
        setBySelection(sel.rows);
        setByCompetition(comp.rows);
        setCalibration(calib.buckets);
        // fetchHistory does not support model filter; filter client-side.
        setHistory(hist.rows.filter((r) => r.model === model));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [model]);

  if (error) {
    return (
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8">
        <PageHeader kicker={`Picks · model · ${model}`} />
        <div className={`${SECTION_CLASS} font-mono text-[12px] text-text`}>
          {t("picks.error")}: {error}
        </div>
      </main>
    );
  }

  const waterfallBars: WaterfallBar[] = byCompetition
    .map((r) => ({
      label: String(r.competition ?? ""),
      value: Number(r.pnl_total ?? 0),
    }))
    .filter((b) => b.label);

  const betsToShow = history.slice(0, 100);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8">
      <PageHeader kicker={`Picks · model · ${model}`} />

      <section className="grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-5">
        <div className="bg-bg">
          <Stat label={t("picks.deepDive.kpi.bets")} value={summary ? String(summary.n) : "—"} />
        </div>
        <div className="bg-bg">
          <Stat label={t("picks.deepDive.kpi.hitRate")} value={fmtPct(summary?.hit_rate ?? null)} />
        </div>
        <div className="bg-bg">
          <Stat label={t("picks.deepDive.kpi.roi")} value={fmtPct(summary?.roi ?? null)} />
        </div>
        <div className="bg-bg">
          <Stat label={t("picks.deepDive.kpi.meanClv")} value={fmtNum(summary?.mean_clv ?? null, 4)} />
        </div>
        <div className="bg-bg">
          <Stat label={t("picks.deepDive.brierLabel")} value={fmtNum(summary?.brier ?? null, 4)} />
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <Kicker className="mb-3 block">{t("picks.deepDive.calibration")}</Kicker>
        <CalibrationPlot buckets={calibration} />
      </section>

      <section className={SECTION_CLASS}>
        <Kicker className="mb-3 block">{t("picks.deepDive.outcomeBreakdown")}</Kicker>
        <table className="w-full border-collapse text-left font-mono text-[12px]">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.filter.selection")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>n</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.deepDive.kpi.meanClv")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.deepDive.kpi.roi")}</th>
            </tr>
          </thead>
          <tbody>
            {bySelection.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-text-dim" colSpan={5}>
                  —
                </td>
              </tr>
            ) : (
              bySelection.map((row, i) => (
                <tr key={`${row.selection}-${i}`} className="border-b border-border/60">
                  <td className="px-2 py-2 text-text">{String(row.selection ?? "")}</td>
                  <td className="px-2 py-2 tabular-nums">{row.n}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.mean_clv, 4)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtPct(row.roi)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className={SECTION_CLASS}>
        <Kicker className="mb-3 block">{t("picks.deepDive.waterfall")}</Kicker>
        <WaterfallChart bars={waterfallBars} />
      </section>

      <section className={SECTION_CLASS}>
        <Kicker className="mb-3 block">{t("picks.deepDive.bets")}</Kicker>
        <table className="w-full border-collapse text-left font-mono text-[12px]">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.event")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.market")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.selection")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.price")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.edge")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.result")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.pnl")}</th>
              <th className="px-2 py-2 font-sans text-[10px] uppercase text-text-dim" style={{ letterSpacing: "var(--track-wide)" }}>{t("picks.recent.clv")}</th>
            </tr>
          </thead>
          <tbody>
            {betsToShow.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-text-dim" colSpan={8}>
                  —
                </td>
              </tr>
            ) : (
              betsToShow.map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="px-2 py-2 text-[11px] text-text-dim">{row.event_id}</td>
                  <td className="px-2 py-2">{row.market}</td>
                  <td className="px-2 py-2">{row.selection}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.price_at_recommendation, 2)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtPct(row.edge)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.result, 0)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.pnl, 2)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.clv, 4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
