"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  fetchStats,
  fetchHistory,
  type StatsRow,
  type HistoryResponse,
} from "@/lib/api-picks";

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ok";
      globalSevenDay: StatsRow | null;
      perModelSevenDay: StatsRow[];
      pendingByModel: StatsRow[];
      today: StatsRow | null;
      history: HistoryResponse;
    }
  | { kind: "error"; message: string };

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400e3).toISOString();
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function HealthTab() {
  const { t, locale } = useLocale();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [global7, perModel7, pendingPerModel, today, history] = await Promise.all([
          fetchStats([], { status: "settled", dateFrom: isoDaysAgo(7) }),
          fetchStats(["model"], { status: "settled", dateFrom: isoDaysAgo(7) }),
          fetchStats(["model"], { status: "pending" }),
          fetchStats([], { status: "all", dateFrom: isoDaysAgo(1) }),
          fetchHistory({ limit: 5 }),
        ]);
        if (cancelled) return;
        setState({
          kind: "ok",
          globalSevenDay: global7.rows[0] ?? null,
          perModelSevenDay: perModel7.rows,
          pendingByModel: pendingPerModel.rows,
          today: today.rows[0] ?? null,
          history,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "load failed",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
        {t("picks.loading")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm">
        {t("picks.error")}: {state.message}
      </div>
    );
  }

  const sevenDay = state.globalSevenDay;
  const today = state.today;
  const totalPending = state.pendingByModel.reduce((acc, r) => acc + (r.n ?? 0), 0);

  const kpis = [
    {
      label: t("picks.kpi.picksToday"),
      value: today?.n != null ? String(today.n) : "0",
    },
    {
      label: t("picks.kpi.hitRate7d"),
      value: fmtPct(sevenDay?.hit_rate ?? null),
    },
    {
      label: t("picks.kpi.pnl7d"),
      value: fmtNum(sevenDay?.pnl_total, 2),
    },
    {
      label: t("picks.kpi.clv7d"),
      value: fmtNum(sevenDay?.mean_clv, 4),
    },
  ];

  // Most-recent timestamps across the recent-history sample, used by
  // the freshness panel. ``history.rows`` is ordered newest-first.
  const latestRecommended = state.history.rows[0]?.recommended_at;
  const latestSettled = state.history.rows.find((r) => r.status === "settled")?.recommended_at;

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4"
          >
            <div className="text-xs text-[color:var(--color-text-muted)]">{k.label}</div>
            <div className="mt-1 text-2xl font-bold text-[color:var(--color-text-high)]">{k.value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.freshness.title")}
        </h2>
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div>
            {t("picks.freshness.recordPicks")}: <b>{fmtRelativeTime(latestRecommended)}</b>
          </div>
          <div>
            {t("picks.freshness.settle")}: <b>{fmtRelativeTime(latestSettled)}</b>
          </div>
          <div>
            {t("picks.freshness.pending")}: <b>{totalPending}</b>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
          {t("picks.snapshot.title")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.filter.model")}</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.roi")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.meanClv")}</th>
            </tr>
          </thead>
          <tbody>
            {state.perModelSevenDay.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-[color:var(--color-text-muted)]" colSpan={5}>
                  —
                </td>
              </tr>
            ) : (
              state.perModelSevenDay.map((row) => (
                <tr key={String(row.model)} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-2 font-semibold text-[color:var(--color-text-high)]">
                    <Link
                      href={
                        `/${locale}/picks/model/${row.model}` as unknown as Parameters<typeof Link>[0]["href"]
                      }
                      className="underline"
                    >
                      {String(row.model)}
                    </Link>
                  </td>
                  <td className="px-2 py-2">{row.n}</td>
                  <td className="px-2 py-2">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2">{fmtPct(row.roi)}</td>
                  <td className="px-2 py-2">{fmtNum(row.mean_clv, 4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
