import { competitionRoot } from "@/lib/competition";
import type { HistoryRow, StatsRow } from "./types";

/**
 * Small-sample statistics for the Performance pages. Everything returns null
 * when the quantity is undefined, so the UI renders "—" instead of a fake 0.
 */

const Z95 = 1.959964;

export type Interval = { low: number; high: number };

/** Wilson 95% score interval for a hit rate; well-behaved at small n and at 0 % / 100 %. */
export function wilson(wins: number | null | undefined, n: number | null | undefined): Interval | null {
  if (!n || n <= 0 || wins === null || wins === undefined) return null;
  const p = wins / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * 95% interval for a stake-weighted ROI (Σ pnl / Σ stake), delta method for
 * a ratio estimator. Needs the individual bets; null below two bets. The lower
 * bound is clipped at −100 %, the most a bettor can lose.
 */
export function roiInterval(bets: { pnl: number; stake: number }[]): Interval | null {
  const n = bets.length;
  if (n < 2) return null;
  const stake = bets.reduce((a, b) => a + b.stake, 0);
  if (stake <= 0) return null;
  const roi = bets.reduce((a, b) => a + b.pnl, 0) / stake;
  const ss = bets.reduce((a, b) => a + (b.pnl - roi * b.stake) ** 2, 0);
  const se = Math.sqrt(ss / (n - 1) / n) / (stake / n);
  return { low: Math.max(-1, roi - Z95 * se), high: roi + Z95 * se };
}

/** Live stake and P&L as the backend aggregates them (stake = full-Kelly fraction). */
export function stakeAndPnl(row: HistoryRow): { pnl: number; stake: number } {
  return { pnl: row.pnl ?? 0, stake: row.kelly_full ?? 0 };
}

/**
 * ROI interval for a set of settled rows, but only when those rows are exactly
 * the population behind the aggregate (`expectedN`). A truncated or partial
 * list would give an interval for a different sample.
 */
export function reconciledRoiInterval(rows: HistoryRow[], expectedN: number | null | undefined): Interval | null {
  if (!expectedN || rows.length !== expectedN) return null;
  return roiInterval(rows.map(stakeAndPnl));
}

/** Return of a 1-unit flat stake: won → price − 1, lost → −1, void → 0. */
export function flatReturn(row: HistoryRow): number | null {
  const price = row.price_at_recommendation;
  if (row.result === null || price === null) return null;
  if (row.result === 1) return price - 1;
  if (row.result === 0) return -1;
  return 0;
}

function meanInterval(values: number[]): { mean: number; ci: Interval | null } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, ci: null };
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = (Z95 * sd) / Math.sqrt(n);
  return { mean, ci: { low: mean - half, high: mean + half } };
}

export type EdgeBin = {
  /** Edge range of the bin (fractions). */
  lo: number;
  hi: number;
  /** Median edge, used as the bin label. */
  mid: number;
  n: number;
  /** Realised flat-stake ROI and its 95% interval. */
  roi: number;
  ci: Interval | null;
  /** ROI the model expected: mean(model_prob × price − 1). */
  expected: number | null;
};

/**
 * Splits settled bets into equal-count edge groups (deciles when there are
 * enough bets, fewer otherwise so each group keeps `minPerBin` bets).
 */
export function edgeQuantileBins(rows: HistoryRow[], maxBins = 10, minPerBin = 5): EdgeBin[] {
  const bets = rows
    .map((r) => {
      const ret = flatReturn(r);
      const price = r.price_at_recommendation;
      if (r.edge === null || ret === null) return null;
      const ev = r.model_prob !== null && price !== null ? r.model_prob * price - 1 : null;
      return { edge: r.edge, ret, ev };
    })
    .filter((b): b is { edge: number; ret: number; ev: number | null } => b !== null)
    .sort((a, b) => a.edge - b.edge);
  const n = bets.length;
  if (n === 0) return [];
  const k = Math.min(maxBins, Math.max(1, Math.floor(n / minPerBin)));
  const bins: EdgeBin[] = [];
  for (let i = 0; i < k; i++) {
    const slice = bets.slice(Math.floor((i * n) / k), Math.floor(((i + 1) * n) / k));
    if (slice.length === 0) continue;
    const { mean, ci } = meanInterval(slice.map((b) => b.ret));
    const evs = slice.map((b) => b.ev).filter((v): v is number => v !== null);
    bins.push({
      lo: slice[0].edge,
      hi: slice[slice.length - 1].edge,
      mid: slice[Math.floor(slice.length / 2)].edge,
      n: slice.length,
      roi: mean,
      ci,
      expected: evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null
    });
  }
  return bins;
}

/** Price buckets matching the backend's `price_bucket` grouping (upper bounds inclusive). */
export const PRICE_EDGES = [1.5, 2, 3, 5] as const;

export type PriceBucket = {
  /** Bucket bounds; `lo` null = from the lowest price, `hi` null = no upper bound. */
  lo: number | null;
  hi: number | null;
  n: number;
  wins: number;
  hitRate: number | null;
  ci: Interval | null;
  /** Mean of 1 / price: the hit rate at which the bucket breaks even. */
  breakEven: number | null;
};

/** Hit rate per price bucket over settled won/lost bets (voids excluded). */
export function priceBuckets(rows: HistoryRow[]): PriceBucket[] {
  const bounds: [number | null, number | null][] = [
    [null, PRICE_EDGES[0]],
    ...PRICE_EDGES.slice(1).map((hi, i): [number, number] => [PRICE_EDGES[i], hi]),
    [PRICE_EDGES[PRICE_EDGES.length - 1], null]
  ];
  return bounds
    .map(([lo, hi]) => {
      const bets = rows.filter((r) => {
        const p = r.price_at_recommendation;
        if (p === null || (r.result !== 0 && r.result !== 1)) return false;
        return (lo === null || p > lo) && (hi === null || p <= hi);
      });
      const n = bets.length;
      const wins = bets.filter((r) => r.result === 1).length;
      const inv = bets.reduce((a, r) => a + 1 / (r.price_at_recommendation as number), 0);
      return {
        lo,
        hi,
        n,
        wins,
        hitRate: n > 0 ? wins / n : null,
        ci: wilson(wins, n),
        breakEven: n > 0 ? inv / n : null
      };
    })
    .filter((b) => b.n > 0);
}

// ---------------------------------------------------------------------------
// Folding aggregate rows (competition stage variants → one root)

export type Folded = {
  key: string;
  n: number;
  wins: number;
  stake: number;
  pnl: number;
  /** Σ stake-weighted P&L / Σ stake; null when nothing was staked. */
  roi: number | null;
  /** n-weighted mean of the groups' mean CLV; null when no group has CLV. */
  meanClv: number | null;
};

/** Sums aggregate rows that share `keyOf(row)` (null keys are dropped). */
export function foldStats(rows: StatsRow[], keyOf: (r: StatsRow) => string | null | undefined): Folded[] {
  const acc = new Map<string, { n: number; wins: number; stake: number; pnl: number; clvSum: number; clvN: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const a = acc.get(k) ?? { n: 0, wins: 0, stake: 0, pnl: 0, clvSum: 0, clvN: 0 };
    a.n += r.n;
    a.wins += r.wins ?? 0;
    a.stake += r.stake_total ?? 0;
    a.pnl += r.pnl_total ?? 0;
    if (r.mean_clv !== null && r.n > 0) {
      a.clvSum += r.mean_clv * r.n;
      a.clvN += r.n;
    }
    acc.set(k, a);
  }
  return [...acc.entries()].map(([k, a]) => ({
    key: k,
    n: a.n,
    wins: a.wins,
    stake: a.stake,
    pnl: a.pnl,
    roi: a.stake > 0 ? a.pnl / a.stake : null,
    meanClv: a.clvN > 0 ? a.clvSum / a.clvN : null
  }));
}

export const competitionKey = (r: StatsRow) => competitionRoot(r.competition ?? null) ?? null;

// ---------------------------------------------------------------------------
// Cumulative P&L over time

export type PnlPoint = { day: string; daily: number; cumulative: number; n: number };
export type PnlSeries = { model: string; points: PnlPoint[] };

/** Per-model running P&L from `group_by=model,day` rows, oldest day first. */
export function cumulativeByModel(rows: StatsRow[]): { firstDay: string | null; lastDay: string | null; series: PnlSeries[] } {
  const sorted = rows
    .filter((r) => r.model && r.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const byModel = new Map<string, PnlPoint[]>();
  for (const r of sorted) {
    const points = byModel.get(r.model!) ?? [];
    const prev = points.length ? points[points.length - 1].cumulative : 0;
    const daily = r.pnl_total ?? 0;
    points.push({ day: r.day!, daily, cumulative: prev + daily, n: r.n });
    byModel.set(r.model!, points);
  }
  return {
    firstDay: sorted[0]?.day ?? null,
    lastDay: sorted[sorted.length - 1]?.day ?? null,
    series: [...byModel.entries()].map(([model, points]) => ({ model, points }))
  };
}

/** YYYY-MM-DD shifted by `days` calendar days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings. */
export function dayOffset(from: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
