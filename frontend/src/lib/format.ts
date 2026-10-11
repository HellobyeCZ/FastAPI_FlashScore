import type { Locale } from "@/lib/i18n";

/**
 * Locale-aware number/date formatting. Every number shown to a human goes
 * through one of these so decimals, signs, separators and "n/a" are consistent
 * across pages. Missing values (null/undefined/NaN) render as an em dash.
 */
export const DASH = "—";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type Formatters = ReturnType<typeof makeFormatters>;

export function makeFormatters(locale: Locale) {
  const nf = (opts: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, opts);
  const cache = new Map<string, Intl.NumberFormat>();
  const get = (key: string, opts: Intl.NumberFormatOptions) => {
    let f = cache.get(key);
    if (!f) {
      f = nf(opts);
      cache.set(key, f);
    }
    return f;
  };

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  return {
    /** Plain number. */
    num(v: number | null | undefined, digits = 2): string {
      if (!isNum(v)) return DASH;
      return get(`n${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    },
    /** Integer with grouping. */
    int(v: number | null | undefined): string {
      if (!isNum(v)) return DASH;
      return get("i", { maximumFractionDigits: 0 }).format(v);
    },
    /** Compact integer: 52 373 → 52K. */
    compact(v: number | null | undefined): string {
      if (!isNum(v)) return DASH;
      return get("c", { notation: "compact", maximumFractionDigits: 1 }).format(v);
    },
    /** Fraction → percent. signed=true prefixes "+" on positives. */
    pct(v: number | null | undefined, digits = 1, signed = false): string {
      if (!isNum(v)) return DASH;
      return get(`p${digits}${signed}`, {
        style: "percent",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: signed ? "exceptZero" : "auto"
      }).format(v);
    },
    /** Betting units, always signed: +0.26u. */
    units(v: number | null | undefined, digits = 2): string {
      if (!isNum(v)) return DASH;
      const s = get(`u${digits}`, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: "exceptZero"
      }).format(v);
      return `${s}u`;
    },
    /** Signed decimal (e.g. Sharpe, CLV). */
    signed(v: number | null | undefined, digits = 3): string {
      if (!isNum(v)) return DASH;
      return get(`s${digits}`, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: "exceptZero"
      }).format(v);
    },
    /** Decimal odds: 2 decimals. */
    odds(v: number | null | undefined): string {
      if (!isNum(v) || v <= 0) return DASH;
      return get("o", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    },
    bytes(v: number | null | undefined): string {
      if (!isNum(v)) return DASH;
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      let x = v;
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
      }
      return `${get("b", { maximumFractionDigits: 1 }).format(x)} ${units[i]}`;
    },
    /** Date + time in the viewer's local time zone. */
    dateTime(iso: string | null | undefined): string {
      const d = parseDate(iso);
      if (!d) return DASH;
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(d);
    },
    date(iso: string | null | undefined): string {
      const d = parseDate(iso);
      if (!d) return DASH;
      return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(d);
    },
    time(iso: string | null | undefined): string {
      const d = parseDate(iso);
      if (!d) return DASH;
      return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
    },
    /** "3 hours ago", "in 2 days", "před 5 měsíci". */
    relative(iso: string | null | undefined, now: Date = new Date()): string {
      const d = parseDate(iso);
      if (!d) return DASH;
      const diffSec = (d.getTime() - now.getTime()) / 1000;
      const abs = Math.abs(diffSec);
      const table: [number, Intl.RelativeTimeFormatUnit, number][] = [
        [60, "second", 1],
        [3600, "minute", 60],
        [86400, "hour", 3600],
        [86400 * 30, "day", 86400],
        [86400 * 365, "month", 86400 * 30],
        [Infinity, "year", 86400 * 365]
      ];
      for (const [limit, unit, div] of table) {
        if (abs < limit) return rtf.format(Math.round(diffSec / div), unit);
      }
      return DASH;
    }
  };
}

/** Accepts ISO strings with or without a zone; bare strings are treated as UTC. */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Age in hours of an ISO timestamp (Infinity when missing). */
export function ageHours(iso: string | null | undefined, now: Date = new Date()): number {
  const d = parseDate(iso);
  return d ? (now.getTime() - d.getTime()) / 3_600_000 : Infinity;
}

/** Tone for a signed metric: positive → pos, negative → neg. */
export function signTone(v: number | null | undefined): "pos" | "neg" | "neutral" {
  if (!isNum(v) || v === 0) return "neutral";
  return v > 0 ? "pos" : "neg";
}
