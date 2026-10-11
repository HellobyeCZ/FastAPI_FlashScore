import type { LiveOddsRow, OddsResponse } from "@/types/odds";

/**
 * Odds board: one canonical shape for stored snapshots (OddsResponse) and
 * live captures (live_odds_snapshots rows), so labelling, best price and
 * margin are computed once.
 *
 * Labelling rules (verified against the archive):
 * - Upstream lists participant markets as [home, away, (draw)], so the first
 *   participant id of 1X2 (or Home/Away, DNB, To qualify) is the home team.
 *   Checked on 2,997 finished football events: Brier 0.39 with first = home
 *   vs 0.70 with first = away; live captures keep the archive order.
 * - The draw / "12" outcome carries no participant (stored as
 *   "<MARKET_KEY>:<n>" or the live key "DRAW").
 * - Double chance: home id = 1X, away id = X2, the participant-less row = 12.
 * - Handicaps are quoted from each side's own perspective; lines are keyed
 *   from the home side (home h, draw h, away −h).
 * - BTTS is positional: 0 = yes, 1 = no.
 */

export type SelectionKind =
  | "home"
  | "draw"
  | "away"
  | "homeOrDraw"
  | "homeOrAway"
  | "drawOrAway"
  | "over"
  | "under"
  | "yes"
  | "no"
  | "odd"
  | "even"
  | "score"
  | "htft"
  | "other";

export type BoardSelection = {
  kind: SelectionKind;
  /** Score "2:1", HT/FT "1/X" or a raw upstream label for `other`. */
  text?: string;
};

export type BoardRow = {
  id: string;
  selection: BoardSelection;
  /** Book name → price; null when the book does not quote this selection. */
  prices: Record<string, number | null>;
  /** Highest quoted price (any number of books) — basis of the implied column. */
  top: { price: number; book: string } | null;
  /** Highest price only when ≥ 2 books quote and it is strictly the best. */
  best: { price: number; book: string } | null;
};

export type BoardLine = {
  /** Total (O/U) or home-perspective handicap; null for line-less markets. */
  line: number | null;
  rows: BoardRow[];
  /**
   * Book → overround (Σ 1/price − 1). null for a book with a missing or
   * suspended selection; the whole map is null when the market is not an
   * exhaustive, mutually exclusive set (double chance, correct score).
   */
  margin: Record<string, number | null> | null;
};

export type BoardMarket = {
  key: string;
  family: string;
  period: string;
  lineBased: boolean;
  lines: BoardLine[];
  /** Line shown first: most books quoting, then the most balanced prices. */
  mainLine: number | null;
};

export type OddsBoard = {
  books: string[];
  markets: BoardMarket[];
  /** Market keys whose selections could not be identified (not shown). */
  omitted: string[];
};

/** Prices at or below this are upstream placeholders for suspended selections. */
export const SUSPENDED_MAX = 1.01;

export function isQuoted(price: number | null | undefined): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > SUSPENDED_MAX;
}

export const FAMILY_ORDER = [
  "HOME_DRAW_AWAY",
  "HOME_AWAY",
  "DOUBLE_CHANCE",
  "DRAW_NO_BET",
  "OVER_UNDER",
  "BOTH_TEAMS_TO_SCORE",
  "ASIAN_HANDICAP",
  "EUROPEAN_HANDICAP",
  "CORRECT_SCORE",
  "HALF_FULL_TIME",
  "ODD_OR_EVEN",
  "TO_QUALIFY"
] as const;

export const PERIOD_ORDER = [
  "FULL_TIME",
  "FULL_TIME_OVER_TIME",
  "FIRST_HALF",
  "SECOND_HALF",
  "FIRST_PERIOD",
  "SECOND_PERIOD",
  "THIRD_PERIOD"
] as const;

const LINE_FAMILIES = new Set(["OVER_UNDER", "ASIAN_HANDICAP", "EUROPEAN_HANDICAP"]);
const PARTICIPANT_FAMILIES = ["HOME_DRAW_AWAY", "HOME_AWAY", "DRAW_NO_BET", "TO_QUALIFY"];

/** Selections per line for families whose outcomes are exhaustive and exclusive. */
const EXHAUSTIVE: Record<string, number> = {
  HOME_DRAW_AWAY: 3,
  HOME_AWAY: 2,
  DRAW_NO_BET: 2,
  TO_QUALIFY: 2,
  BOTH_TEAMS_TO_SCORE: 2,
  ODD_OR_EVEN: 2,
  OVER_UNDER: 2,
  ASIAN_HANDICAP: 2,
  EUROPEAN_HANDICAP: 3,
  HALF_FULL_TIME: 9
};

const KIND_ORDER: SelectionKind[] = [
  "home",
  "homeOrDraw",
  "draw",
  "homeOrAway",
  "drawOrAway",
  "away",
  "over",
  "under",
  "yes",
  "no",
  "odd",
  "even"
];

const HTFT_ORDER = ["1/1", "1/X", "1/2", "X/1", "X/X", "X/2", "2/1", "2/X", "2/2"];

type Quote = {
  book: string;
  key: string;
  line: number | null;
  selection: BoardSelection;
  price: number | null;
};

type Participants = { home: string; away: string } | null;

export function splitMarketKey(key: string): { family: string; period: string } {
  const idx = key.indexOf(":");
  return idx < 0 ? { family: key, period: "" } : { family: key.slice(0, idx), period: key.slice(idx + 1) };
}

function parseLine(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** "OVER (2.5)" / "(-0.75)" → 2.5 / −0.75 */
function lineFromLabel(label: string | null | undefined): number | null {
  const m = label?.match(/\(\s*([-+]?\d+(?:\.\d+)?)\s*\)/);
  return m ? parseLine(m[1]) : null;
}

function selectionId(sel: BoardSelection): string {
  return sel.text ? `${sel.kind}:${sel.text}` : sel.kind;
}

// ---------------------------------------------------------------------------
// Stored snapshots (OddsResponse)
// ---------------------------------------------------------------------------

function storedParticipants(resp: OddsResponse): Participants {
  for (const family of PARTICIPANT_FAMILIES) {
    for (const period of PERIOD_ORDER) {
      const key = `${family}:${period}`;
      for (const book of resp.event.bookmakers ?? []) {
        const market = book.markets?.find((m) => (m.key ?? m.id) === key);
        if (!market) continue;
        const ids = market.outcomes
          .map((o) => o.id ?? o.selection_key ?? "")
          .filter((id) => id && !id.startsWith(`${key}:`));
        if (ids.length >= 2 && ids[0] !== ids[1]) return { home: ids[0], away: ids[1] };
      }
    }
  }
  return null;
}

function resolveStored(
  family: string,
  key: string,
  id: string,
  label: string | null,
  participants: Participants
): { selection: BoardSelection; line: number | null } | null {
  const positional = id.startsWith(`${key}:`) ? Number(id.slice(key.length + 1)) : null;
  const side = participants && id === participants.home ? "home" : participants && id === participants.away ? "away" : null;
  const handicap = lineFromLabel(label);
  const upper = id.toUpperCase();
  switch (family) {
    case "HOME_DRAW_AWAY":
      if (positional !== null) return { selection: { kind: "draw" }, line: null };
      return side ? { selection: { kind: side }, line: null } : null;
    case "HOME_AWAY":
    case "DRAW_NO_BET":
    case "TO_QUALIFY":
      return side ? { selection: { kind: side }, line: null } : null;
    case "DOUBLE_CHANCE":
      if (positional !== null) return { selection: { kind: "homeOrAway" }, line: null };
      if (side === "home") return { selection: { kind: "homeOrDraw" }, line: null };
      if (side === "away") return { selection: { kind: "drawOrAway" }, line: null };
      return null;
    case "OVER_UNDER":
      if ((upper === "OVER" || upper === "UNDER") && handicap !== null)
        return { selection: { kind: upper === "OVER" ? "over" : "under" }, line: handicap };
      return null;
    case "ASIAN_HANDICAP":
      if (!side || handicap === null) return null;
      return { selection: { kind: side }, line: side === "home" ? handicap : -handicap };
    case "EUROPEAN_HANDICAP":
      if (handicap === null) return null;
      if (positional !== null) return { selection: { kind: "draw" }, line: handicap };
      if (!side) return null;
      return { selection: { kind: side }, line: side === "home" ? handicap : -handicap };
    case "BOTH_TEAMS_TO_SCORE":
      if (upper === "YES" || positional === 0) return { selection: { kind: "yes" }, line: null };
      if (upper === "NO" || positional === 1) return { selection: { kind: "no" }, line: null };
      return null;
    case "ODD_OR_EVEN":
      if (upper === "ODD" || upper === "EVEN") return { selection: { kind: upper === "ODD" ? "odd" : "even" }, line: null };
      return null;
    case "CORRECT_SCORE": {
      const m = label?.match(/^(\d+)\s*:\s*(\d+)$/);
      return m ? { selection: { kind: "score", text: `${m[1]}:${m[2]}` }, line: null } : null;
    }
    case "HALF_FULL_TIME":
      return label && /^[12X]\/[12X]$/.test(label) ? { selection: { kind: "htft", text: label }, line: null } : null;
    default:
      // Unknown family: only trust a human label, never an opaque id.
      if (label && label !== id && label !== "Selection") return { selection: { kind: "other", text: label }, line: handicap };
      return null;
  }
}

export function boardFromStored(resp: OddsResponse): OddsBoard {
  const participants = storedParticipants(resp);
  const quotes: Quote[] = [];
  const unresolved = new Set<string>();
  for (const book of resp.event.bookmakers ?? []) {
    const bookName = book.name ?? book.id ?? "?";
    for (const market of book.markets ?? []) {
      const key = market.key ?? market.id;
      if (!key) continue;
      const { family } = splitMarketKey(key);
      for (const outcome of market.outcomes ?? []) {
        const id = outcome.id ?? outcome.selection_key ?? "";
        const resolved = resolveStored(family, key, id, outcome.label, participants);
        if (!resolved) {
          unresolved.add(key);
          continue;
        }
        quotes.push({ book: bookName, key, line: resolved.line, selection: resolved.selection, price: outcome.odds_decimal });
      }
    }
  }
  return buildBoard(quotes, unresolved);
}

// ---------------------------------------------------------------------------
// Live captures (live_odds_snapshots rows, in insertion order)
// ---------------------------------------------------------------------------

function liveParticipants(rows: LiveOddsRow[]): Participants {
  for (const family of PARTICIPANT_FAMILIES) {
    for (const period of PERIOD_ORDER) {
      const key = `${family}:${period}`;
      const ids: string[] = [];
      for (const r of rows) {
        if (r.market !== key) continue;
        const base = r.selection_key.split("@")[0];
        if (base === "DRAW" || ids.includes(base)) continue;
        ids.push(base);
        if (ids.length === 2) return { home: ids[0], away: ids[1] };
      }
    }
  }
  return null;
}

export function boardFromLive(rows: LiveOddsRow[]): OddsBoard {
  const participants = liveParticipants(rows);
  const quotes: Quote[] = [];
  const unresolved = new Set<string>();
  // Older captures collapsed positional selections (BTTS, correct score,
  // HT/FT) into one "DRAW" key; recover BTTS from insertion order only.
  const positions = new Map<string, number>();
  for (const r of rows) {
    const { family } = splitMarketKey(r.market);
    const [base, rawLine] = r.selection_key.split("@");
    const upper = base.toUpperCase();
    const handicap = parseLine(rawLine);
    const side = participants && base === participants.home ? "home" : participants && base === participants.away ? "away" : upper === "HOME" ? "home" : upper === "AWAY" ? "away" : null;
    let resolved: { selection: BoardSelection; line: number | null } | null = null;
    switch (family) {
      case "HOME_DRAW_AWAY":
        resolved = upper === "DRAW" ? { selection: { kind: "draw" }, line: null } : side ? { selection: { kind: side }, line: null } : null;
        break;
      case "HOME_AWAY":
      case "DRAW_NO_BET":
      case "TO_QUALIFY":
        resolved = side ? { selection: { kind: side }, line: null } : null;
        break;
      case "DOUBLE_CHANCE":
        resolved =
          upper === "DRAW"
            ? { selection: { kind: "homeOrAway" }, line: null }
            : side === "home"
              ? { selection: { kind: "homeOrDraw" }, line: null }
              : side === "away"
                ? { selection: { kind: "drawOrAway" }, line: null }
                : null;
        break;
      case "OVER_UNDER":
        resolved =
          (upper === "OVER" || upper === "UNDER") && handicap !== null
            ? { selection: { kind: upper === "OVER" ? "over" : "under" }, line: handicap }
            : null;
        break;
      case "ASIAN_HANDICAP":
        resolved = side && handicap !== null ? { selection: { kind: side }, line: side === "home" ? handicap : -handicap } : null;
        break;
      case "EUROPEAN_HANDICAP":
        if (handicap !== null) {
          if (upper === "DRAW") resolved = { selection: { kind: "draw" }, line: handicap };
          else if (side) resolved = { selection: { kind: side }, line: side === "home" ? handicap : -handicap };
        }
        break;
      case "BOTH_TEAMS_TO_SCORE": {
        if (upper === "YES" || upper === "NO") {
          resolved = { selection: { kind: upper === "YES" ? "yes" : "no" }, line: null };
        } else {
          const posKey = `${r.bookmaker}|${r.market}`;
          const pos = positions.get(posKey) ?? 0;
          positions.set(posKey, pos + 1);
          resolved = pos === 0 ? { selection: { kind: "yes" }, line: null } : pos === 1 ? { selection: { kind: "no" }, line: null } : null;
        }
        break;
      }
      case "ODD_OR_EVEN":
        resolved = upper === "ODD" || upper === "EVEN" ? { selection: { kind: upper === "ODD" ? "odd" : "even" }, line: null } : null;
        break;
      default:
        resolved = null;
    }
    if (!resolved) {
      unresolved.add(r.market);
      continue;
    }
    quotes.push({ book: r.bookmaker ?? "?", key: r.market, line: resolved.line, selection: resolved.selection, price: r.price });
  }
  return buildBoard(quotes, unresolved);
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

function compareSelections(a: BoardSelection, b: BoardSelection): number {
  if (a.kind === "score" && b.kind === "score") {
    const [ah, aa] = (a.text ?? "0:0").split(":").map(Number);
    const [bh, ba] = (b.text ?? "0:0").split(":").map(Number);
    // By total goals, then home goals first: 0:0, 1:0, 0:1, 2:0, 1:1, 0:2…
    return ah + aa - (bh + ba) || bh - ah;
  }
  if (a.kind === "htft" && b.kind === "htft") {
    return HTFT_ORDER.indexOf(a.text ?? "") - HTFT_ORDER.indexOf(b.text ?? "");
  }
  const ia = KIND_ORDER.indexOf(a.kind);
  const ib = KIND_ORDER.indexOf(b.kind);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

function orderIndex(list: readonly string[], value: string): number {
  const i = list.indexOf(value);
  return i < 0 ? list.length : i;
}

function rowPrices(row: BoardRow): { price: number; book: string }[] {
  return Object.entries(row.prices)
    .filter((e): e is [string, number] => isQuoted(e[1]))
    .map(([book, price]) => ({ book, price }))
    .sort((a, b) => b.price - a.price);
}

function finishRow(row: BoardRow): BoardRow {
  const quoted = rowPrices(row);
  const top = quoted[0] ?? null;
  const best = quoted.length >= 2 && quoted[0].price > quoted[1].price ? quoted[0] : null;
  return { ...row, top, best };
}

function lineMargin(family: string, rows: BoardRow[], books: string[]): Record<string, number | null> | null {
  const expected = EXHAUSTIVE[family];
  if (!expected || rows.length !== expected) return null;
  const out: Record<string, number | null> = {};
  for (const book of books) {
    const prices = rows.map((r) => r.prices[book]);
    if (prices.every((p) => p === null || p === undefined)) continue;
    out[book] = prices.every(isQuoted) ? prices.reduce((s, p) => s + 1 / p, 0) - 1 : null;
  }
  return out;
}

function mainLine(lines: BoardLine[]): number | null {
  let bestLine: number | null = null;
  let bestScore: [number, number] = [-1, Infinity];
  for (const l of lines) {
    if (l.line === null) continue;
    const books = new Set<string>();
    for (const r of l.rows) for (const [b, p] of Object.entries(r.prices)) if (isQuoted(p)) books.add(b);
    const tops = l.rows.map((r) => r.top?.price).filter((p): p is number => typeof p === "number");
    const balance = tops.length >= 2 ? Math.abs(Math.log(tops[0] / tops[tops.length - 1])) : Infinity;
    const score: [number, number] = [books.size, balance];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
      bestScore = score;
      bestLine = l.line;
    }
  }
  return bestLine;
}

function buildBoard(quotes: Quote[], unresolved: Set<string>): OddsBoard {
  const books: string[] = [];
  // key → line → selection id → row
  const markets = new Map<string, Map<string, Map<string, BoardRow>>>();
  for (const q of quotes) {
    if (!books.includes(q.book)) books.push(q.book);
    const lines = markets.get(q.key) ?? new Map<string, Map<string, BoardRow>>();
    markets.set(q.key, lines);
    const lineKey = q.line === null ? "" : String(q.line);
    const rows = lines.get(lineKey) ?? new Map<string, BoardRow>();
    lines.set(lineKey, rows);
    const id = selectionId(q.selection);
    const row = rows.get(id) ?? { id, selection: q.selection, prices: {}, top: null, best: null };
    rows.set(id, row);
    // First quote wins if a book lists the same selection twice.
    if (!(q.book in row.prices)) row.prices[q.book] = q.price;
  }

  const out: BoardMarket[] = [];
  for (const [key, lineMap] of Array.from(markets.entries())) {
    const { family, period } = splitMarketKey(key);
    const lines: BoardLine[] = Array.from(lineMap.entries())
      .map(([lineKey, rowMap]) => {
        const rows = Array.from(rowMap.values())
          .map(finishRow)
          .sort((a, b) => compareSelections(a.selection, b.selection));
        return { line: lineKey === "" ? null : Number(lineKey), rows, margin: lineMargin(family, rows, books) };
      })
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    out.push({ key, family, period, lineBased: LINE_FAMILIES.has(family), lines, mainLine: mainLine(lines) });
  }
  out.sort(
    (a, b) =>
      orderIndex(FAMILY_ORDER, a.family) - orderIndex(FAMILY_ORDER, b.family) ||
      a.family.localeCompare(b.family) ||
      orderIndex(PERIOD_ORDER, a.period) - orderIndex(PERIOD_ORDER, b.period) ||
      a.period.localeCompare(b.period)
  );
  const shown = new Set(out.map((m) => m.key));
  return {
    books,
    markets: out,
    omitted: Array.from(unresolved).filter((k) => !shown.has(k)).sort()
  };
}

// ---------------------------------------------------------------------------
// Lookups used by the model view and bet tables
// ---------------------------------------------------------------------------

export type MarketRef = { family: string; period: string; line: number | null };

/**
 * Map model/bet market vocabularies onto board keys:
 * "1X2_FT", "OVER_UNDER_2.5_FT", "BTTS_FT" (live) and
 * "HOME_DRAW_AWAY:FULL_TIME" (archive / backtests).
 */
export function marketRef(market: string): MarketRef | null {
  const m = market.toUpperCase();
  if (m.includes(":")) {
    const { family, period } = splitMarketKey(m);
    return { family, period, line: null };
  }
  const period = m.endsWith("_HT") || m.endsWith("_1H") ? "FIRST_HALF" : "FULL_TIME";
  if (m.startsWith("1X2")) return { family: "HOME_DRAW_AWAY", period, line: null };
  if (m.startsWith("BTTS")) return { family: "BOTH_TEAMS_TO_SCORE", period, line: null };
  const ou = m.match(/^OVER_UNDER_(\d+(?:\.\d+)?)/);
  if (ou) return { family: "OVER_UNDER", period, line: Number(ou[1]) };
  return null;
}

/** Board selection kind for a model/bet selection ("home", "over", "yes"…). */
export function selectionKind(selection: string): SelectionKind | null {
  const s = selection.toLowerCase();
  const known: SelectionKind[] = ["home", "draw", "away", "over", "under", "yes", "no", "odd", "even"];
  return (known as string[]).includes(s) ? (s as SelectionKind) : null;
}

export function findRow(board: OddsBoard, ref: MarketRef, kind: SelectionKind): BoardRow | null {
  const market = board.markets.find((m) => m.family === ref.family && m.period === ref.period);
  const line = market?.lines.find((l) => l.line === ref.line);
  return line?.rows.find((r) => r.selection.kind === kind) ?? null;
}

/** "Tipsport.cz" → "Tipsport" for narrow column headers. */
export function shortBookName(name: string): string {
  return name.replace(/\.(cz|sk|pl|de|com|co\.uk|uk|bet)$/i, "");
}
