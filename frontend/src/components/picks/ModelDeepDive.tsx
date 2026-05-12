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
import { CalibrationPlot } from "@/components/picks/charts/CalibrationPlot";
import {
  WaterfallChart,
  type WaterfallBar,
} from "@/components/picks/charts/WaterfallChart";

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

const SECTION_CLASS =
  "rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4";

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
        <div className={`${SECTION_CLASS} text-sm`}>
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
      <header>
        <h1 className="text-2xl font-semibold text-[color:var(--color-text-high)]">
          {model}
        </h1>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className={SECTION_CLASS}>
          <div className="text-xs uppercase text-[color:var(--color-text-muted)]">
            {t("picks.deepDive.kpi.bets")}
          </div>
          <div className="mt-1 text-xl font-semibold text-[color:var(--color-text-high)]">
            {summary ? summary.n : "—"}
          </div>
        </div>
        <div className={SECTION_CLASS}>
          <div className="text-xs uppercase text-[color:var(--color-text-muted)]">
            {t("picks.deepDive.kpi.hitRate")}
          </div>
          <div className="mt-1 text-xl font-semibold text-[color:var(--color-text-high)]">
            {fmtPct(summary?.hit_rate ?? null)}
          </div>
        </div>
        <div className={SECTION_CLASS}>
          <div className="text-xs uppercase text-[color:var(--color-text-muted)]">
            {t("picks.deepDive.kpi.roi")}
          </div>
          <div className="mt-1 text-xl font-semibold text-[color:var(--color-text-high)]">
            {fmtPct(summary?.roi ?? null)}
          </div>
        </div>
        <div className={SECTION_CLASS}>
          <div className="text-xs uppercase text-[color:var(--color-text-muted)]">
            {t("picks.deepDive.kpi.meanClv")}
          </div>
          <div className="mt-1 text-xl font-semibold text-[color:var(--color-text-high)]">
            {fmtNum(summary?.mean_clv ?? null, 4)}
          </div>
        </div>
        <div className={SECTION_CLASS}>
          <div className="text-xs uppercase text-[color:var(--color-text-muted)]">
            {t("picks.deepDive.brierLabel")}
          </div>
          <div className="mt-1 text-xl font-semibold text-[color:var(--color-text-high)]">
            {fmtNum(summary?.brier ?? null, 4)}
          </div>
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.deepDive.calibration")}
        </h2>
        <CalibrationPlot buckets={calibration} />
      </section>

      <section className={SECTION_CLASS}>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.deepDive.outcomeBreakdown")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.filter.selection")}</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.meanClv")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.roi")}</th>
            </tr>
          </thead>
          <tbody>
            {bySelection.length === 0 ? (
              <tr>
                <td
                  className="px-2 py-3 text-[color:var(--color-text-muted)]"
                  colSpan={5}
                >
                  —
                </td>
              </tr>
            ) : (
              bySelection.map((row, i) => (
                <tr
                  key={`${row.selection}-${i}`}
                  className="border-t border-[color:var(--color-brand-outline)]"
                >
                  <td className="px-2 py-2 font-semibold text-[color:var(--color-text-high)]">
                    {String(row.selection ?? "")}
                  </td>
                  <td className="px-2 py-2">{row.n}</td>
                  <td className="px-2 py-2">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2">{fmtNum(row.mean_clv, 4)}</td>
                  <td className="px-2 py-2">{fmtPct(row.roi)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className={SECTION_CLASS}>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.deepDive.waterfall")}
        </h2>
        <WaterfallChart bars={waterfallBars} />
      </section>

      <section className={SECTION_CLASS}>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.deepDive.bets")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.recent.event")}</th>
              <th className="px-2 py-2">{t("picks.recent.market")}</th>
              <th className="px-2 py-2">{t("picks.recent.selection")}</th>
              <th className="px-2 py-2">{t("picks.recent.price")}</th>
              <th className="px-2 py-2">{t("picks.recent.edge")}</th>
              <th className="px-2 py-2">{t("picks.recent.result")}</th>
              <th className="px-2 py-2">{t("picks.recent.pnl")}</th>
              <th className="px-2 py-2">{t("picks.recent.clv")}</th>
            </tr>
          </thead>
          <tbody>
            {betsToShow.length === 0 ? (
              <tr>
                <td
                  className="px-2 py-3 text-[color:var(--color-text-muted)]"
                  colSpan={8}
                >
                  —
                </td>
              </tr>
            ) : (
              betsToShow.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[color:var(--color-brand-outline)]"
                >
                  <td className="px-2 py-2 font-mono text-xs">
                    {row.event_id}
                  </td>
                  <td className="px-2 py-2">{row.market}</td>
                  <td className="px-2 py-2">{row.selection}</td>
                  <td className="px-2 py-2">
                    {fmtNum(row.price_at_recommendation, 2)}
                  </td>
                  <td className="px-2 py-2">{fmtPct(row.edge)}</td>
                  <td className="px-2 py-2">{fmtNum(row.result, 0)}</td>
                  <td className="px-2 py-2">{fmtNum(row.pnl, 2)}</td>
                  <td className="px-2 py-2">{fmtNum(row.clv, 4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
