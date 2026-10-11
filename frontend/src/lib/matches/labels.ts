import type { MessageKey } from "@/lib/i18n";
import type { Formatters } from "@/lib/format";
import { FAMILY_ORDER, PERIOD_ORDER, type BoardSelection } from "./odds";

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

export type Teams = { home: string | null; away: string | null };

function humanize(key: string): string {
  const s = key.replace(/[_:]+/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Market family tab label: "1X2", "Over/Under", "Asian handicap"… */
export function familyLabel(family: string, t: T): string {
  return (FAMILY_ORDER as readonly string[]).includes(family)
    ? t(`matches.family.${family}` as MessageKey)
    : humanize(family);
}

/** Market period label: "Full time", "1st half", "Incl. overtime"… */
export function periodLabel(period: string, t: T): string {
  return (PERIOD_ORDER as readonly string[]).includes(period)
    ? t(`matches.period.${period}` as MessageKey)
    : humanize(period);
}

/** Stats period names come from FlashScore in English ("Match", "1st Half"). */
export function statsPeriodLabel(name: string, t: T): string {
  const known: Record<string, MessageKey> = {
    match: "matches.stats.period.match",
    "1st half": "matches.stats.period.firstHalf",
    "2nd half": "matches.stats.period.secondHalf",
    "1st period": "matches.stats.period.firstPeriod",
    "2nd period": "matches.stats.period.secondPeriod",
    "3rd period": "matches.stats.period.thirdPeriod",
    overtime: "matches.stats.period.overtime"
  };
  const key = known[name.trim().toLowerCase()];
  return key ? t(key) : name;
}

/** Totals and handicaps: 2.5 → "2.5", 3 → "3.0", −0.75 → "−0.75" (signed for handicaps). */
export function lineText(line: number, fmt: Formatters, signed = false): string {
  const digits = Number.isInteger(line * 2) ? 1 : 2;
  return signed ? fmt.signed(line, digits) : fmt.num(line, digits);
}

export type SelectionText = {
  /** Short code shown in mono: "1", "X", "2", "1X", "2:1", "1/X". */
  code: string | null;
  label: string;
  /** Compact label for phones, shown next to the code instead of `label`. */
  short: string;
};

/**
 * Human label for one odds-board row. Home/away rows use the team names;
 * handicaps are shown from that team's own perspective (the board keys lines
 * from the home side).
 */
export function selectionText(
  sel: BoardSelection,
  family: string,
  line: number | null,
  teams: Teams,
  t: T,
  fmt: Formatters
): SelectionText {
  const home = teams.home || t("selection.home");
  const away = teams.away || t("selection.away");
  const handicapped = family === "ASIAN_HANDICAP" || family === "EUROPEAN_HANDICAP";
  const hcp = (value: number | null) => (value === null ? "" : lineText(value, fmt, true));
  const withHcp = (name: string, value: number | null) => (value === null ? name : `${name} (${hcp(value)})`);
  const plain = (label: string): SelectionText => ({ code: null, label, short: label });
  switch (sel.kind) {
    case "home":
      return handicapped
        ? { code: "1", label: withHcp(home, line), short: hcp(line) }
        : { code: "1", label: home, short: "" };
    case "away": {
      const own = line === null ? null : -line;
      return handicapped
        ? { code: "2", label: withHcp(away, own), short: hcp(own) }
        : { code: "2", label: away, short: "" };
    }
    case "draw":
      return family === "EUROPEAN_HANDICAP"
        ? { code: "X", label: withHcp(t("selection.draw"), line), short: hcp(line) }
        : { code: "X", label: t("selection.draw"), short: "" };
    case "homeOrDraw":
      return { code: "1X", label: t("matches.sel.homeOrDraw", { home }), short: "" };
    case "homeOrAway":
      return { code: "12", label: t("matches.sel.homeOrAway"), short: "" };
    case "drawOrAway":
      return { code: "X2", label: t("matches.sel.drawOrAway", { away }), short: "" };
    case "over":
      return line === null
        ? plain(t("selection.over"))
        : {
            code: null,
            label: t("matches.sel.over", { line: lineText(line, fmt) }),
            short: t("matches.sel.overShort", { line: lineText(line, fmt) })
          };
    case "under":
      return line === null
        ? plain(t("selection.under"))
        : {
            code: null,
            label: t("matches.sel.under", { line: lineText(line, fmt) }),
            short: t("matches.sel.underShort", { line: lineText(line, fmt) })
          };
    case "yes":
      return plain(t("selection.yes"));
    case "no":
      return plain(t("selection.no"));
    case "odd":
      return plain(t("matches.sel.odd"));
    case "even":
      return plain(t("matches.sel.even"));
    case "score":
    case "htft":
      return { code: sel.text ?? null, label: "", short: "" };
    default:
      return plain(sel.text ?? "—");
  }
}
