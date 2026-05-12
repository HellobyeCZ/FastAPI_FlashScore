"use client";

import { useEffect, useMemo, useState } from "react";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { useLocale } from "@/contexts/LocaleContext";

type Totals = {
  n?: number | null;
  settled?: number | null;
  pending?: number | null;
  voided?: number | null;
  total_pnl?: number | null;
  mean_clv?: number | null;
};

type Breakdown = {
  model?: string;
  market?: string;
  n?: number;
  wins?: number;
  pnl?: number;
  mean_clv?: number | null;
};

type SettledPoint = {
  settled_at?: string;
  pnl?: number | null;
  clv?: number | null;
};

type Summary = {
  totals?: Totals;
  per_model?: Breakdown[];
  per_market?: Breakdown[];
  settled_series?: SettledPoint[];
};

type Bet = {
  id?: number;
  event_id?: string;
  model?: string;
  market?: string;
  selection?: string;
  recommended_at?: string;
  bet_ts?: string;
  price_at_recommendation?: number | null;
  closing_price?: number | null;
  model_prob?: number | null;
  devigged_prob?: number | null;
  edge?: number | null;
  kelly_full?: number | null;
  result?: number | null;
  pnl?: number | null;
  clv?: number | null;
  status?: string;
  // Joined from upcoming_fixtures (may be null when the event aged out
  // of the 14-day window or was never recorded there).
  kickoff?: string | null;
  home_team_raw?: string | null;
  away_team_raw?: string | null;
};

type HistoryResponse = {
  count?: number;
  rows?: Bet[];
};

function formatNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(date);
}

function PnLChart({ points }: { points: SettledPoint[] }) {
  const { t } = useLocale();
  if (!points.length) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
        {t("picks.chart.empty")}
      </div>
    );
  }
  const cumulative: number[] = [];
  let running = 0;
  for (const p of points) {
    running += p.pnl ?? 0;
    cumulative.push(running);
  }
  const width = 720;
  const height = 220;
  const padX = 36;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const minY = Math.min(0, ...cumulative);
  const maxY = Math.max(0, ...cumulative);
  const rangeY = maxY - minY || 1;
  const xFor = (i: number) =>
    padX + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yFor = (v: number) => padY + innerH - ((v - minY) / rangeY) * innerH;
  const polyline = cumulative.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const zeroY = yFor(0);
  return (
    <div className="overflow-hidden rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
        {t("picks.chart.title")}
      </h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="cumulative pnl">
        <line
          x1={padX}
          y1={zeroY}
          x2={width - padX}
          y2={zeroY}
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeDasharray="4 4"
        />
        <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="currentColor" strokeOpacity="0.4" />
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          stroke="currentColor"
          strokeOpacity="0.4"
        />
        <polyline points={polyline} fill="none" stroke="#1f77b4" strokeWidth={2} />
        {cumulative.length > 0 ? (
          <text
            x={width - padX}
            y={yFor(cumulative[cumulative.length - 1]) - 6}
            textAnchor="end"
            fontSize="11"
            fill="currentColor"
          >
            {cumulative[cumulative.length - 1].toFixed(2)}
          </text>
        ) : null}
        <text x={padX - 4} y={yFor(maxY) + 4} textAnchor="end" fontSize="10" fill="currentColor">
          {maxY.toFixed(2)}
        </text>
        <text x={padX - 4} y={yFor(minY) + 4} textAnchor="end" fontSize="10" fill="currentColor">
          {minY.toFixed(2)}
        </text>
      </svg>
    </div>
  );
}

function TotalsCard({ totals }: { totals?: Totals }) {
  const { t } = useLocale();
  const cells = [
    { label: t("picks.totals.bets"), value: String(totals?.n ?? 0) },
    { label: t("picks.totals.settled"), value: String(totals?.settled ?? 0) },
    { label: t("picks.totals.pending"), value: String(totals?.pending ?? 0) },
    { label: t("picks.totals.voided"), value: String(totals?.voided ?? 0) },
    { label: t("picks.totals.pnl"), value: formatNum(totals?.total_pnl, 2) },
    { label: t("picks.totals.clv"), value: formatNum(totals?.mean_clv, 4) }
  ];
  return (
    <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
      <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
        {t("picks.totals.title")}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="rounded-xl bg-[color:var(--color-brand-surface-alt)] p-3">
            <div className="text-xs text-[color:var(--color-text-muted)]">{c.label}</div>
            <div className="text-lg font-semibold text-[color:var(--color-text-high)]">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BreakdownTable({
  title,
  rows,
  keyLabel
}: {
  title: string;
  rows: Breakdown[];
  keyLabel: string;
}) {
  const { t } = useLocale();
  return (
    <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
      <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{title}</h2>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
          <tr>
            <th className="px-2 py-2">{keyLabel}</th>
            <th className="px-2 py-2">{t("picks.breakdown.n")}</th>
            <th className="px-2 py-2">{t("picks.breakdown.winRate")}</th>
            <th className="px-2 py-2">{t("picks.breakdown.pnl")}</th>
            <th className="px-2 py-2">{t("picks.breakdown.clv")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-2 py-3 text-[color:var(--color-text-muted)]" colSpan={5}>
                —
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const winRate = row.n && row.n > 0 ? (row.wins ?? 0) / row.n : null;
              return (
                <tr key={`${row.model ?? row.market}`} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-2 font-semibold text-[color:var(--color-text-high)]">
                    {row.model ?? row.market}
                  </td>
                  <td className="px-2 py-2 text-[color:var(--color-text-high)]">{row.n ?? 0}</td>
                  <td className="px-2 py-2 text-[color:var(--color-text-high)]">{formatPct(winRate)}</td>
                  <td className="px-2 py-2 text-[color:var(--color-text-high)]">{formatNum(row.pnl, 2)}</td>
                  <td className="px-2 py-2 text-[color:var(--color-text-high)]">{formatNum(row.mean_clv, 4)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </section>
  );
}

function RecentBetsTable({ bets }: { bets: Bet[] }) {
  const { t, locale } = useLocale();
  if (!bets.length) {
    return (
      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
        {t("picks.recent.empty")}
      </section>
    );
  }
  return (
    <section className="overflow-x-auto rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-[color:var(--color-brand-primary)] text-[color:var(--color-text-inverse)]">
          <tr>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.event")}</th>
            <th className="px-3 py-2 font-semibold">Match</th>
            <th className="px-3 py-2 font-semibold">Kickoff</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.model")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.market")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.selection")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.price")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.edge")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.status")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.result")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.pnl")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.clv")}</th>
            <th className="px-3 py-2 font-semibold">{t("picks.recent.recommendedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {bets.map((bet, idx) => {
            const statusLabel =
              bet.status === "settled"
                ? t("picks.status.settled")
                : bet.status === "voided"
                  ? t("picks.status.voided")
                  : t("picks.status.pending");
            const resultLabel =
              bet.result === 1 ? "W" : bet.result === 0 ? "L" : "—";
            return (
              <tr
                key={bet.id ?? `${bet.event_id}-${bet.model}-${bet.market}-${bet.selection}-${idx}`}
                className={
                  idx % 2 === 0
                    ? "border-t border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)]"
                    : "border-t border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)]"
                }
              >
                <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-text-high)]">
                  {bet.event_id ? (
                    <a
                      href={`https://www.flashscore.com/match/${bet.event_id}/#/match-summary`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-[color:var(--color-brand-accent)]"
                      title="Open on FlashScore"
                    >
                      {bet.event_id} ↗
                    </a>
                  ) : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-text-high)]">
                  {bet.home_team_raw && bet.away_team_raw
                    ? `${bet.home_team_raw} – ${bet.away_team_raw}`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
                  {formatTime(bet.kickoff ?? undefined, locale)}
                </td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{bet.model}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-muted)]">{bet.market}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{bet.selection}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">
                  {formatNum(bet.price_at_recommendation, 2)}
                </td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{formatPct(bet.edge)}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-muted)]">{statusLabel}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{resultLabel}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{formatNum(bet.pnl, 3)}</td>
                <td className="px-3 py-2 text-[color:var(--color-text-high)]">{formatNum(bet.clv, 4)}</td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
                  {formatTime(bet.recommended_at, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function PicksDashboard() {
  const { t } = useLocale();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch("/api/picks/summary", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/picks/history?limit=100", { cache: "no-store" }).then((r) => r.json())
    ])
      .then(([s, h]) => {
        if (cancelled) return;
        setSummary(s as Summary);
        setHistory(h as HistoryResponse);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "load failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const settledSeries = useMemo(() => summary?.settled_series ?? [], [summary]);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--color-text-high)]">{t("picks.title")}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">{t("picks.description")}</p>
        </div>
        <LocaleSwitcher />
      </header>

      {loading ? (
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
          {t("picks.loading")}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-[color:var(--color-status-error,#a33)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-high)]">
          {t("picks.error")}: {error}
        </div>
      ) : (
        <>
          <TotalsCard totals={summary?.totals} />
          <PnLChart points={settledSeries} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownTable
              title={t("picks.breakdown.byModel")}
              rows={summary?.per_model ?? []}
              keyLabel={t("picks.recent.model")}
            />
            <BreakdownTable
              title={t("picks.breakdown.byMarket")}
              rows={summary?.per_market ?? []}
              keyLabel={t("picks.recent.market")}
            />
          </div>
          <section>
            <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">
              {t("picks.recent.title")}
            </h2>
            <RecentBetsTable bets={history?.rows ?? []} />
          </section>
        </>
      )}
    </main>
  );
}
