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
  /** Short code shown in mono: "1", "X", "2", "1X", "O", "U". */
  code: string | null;
  label: string;
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
  const handicap = (value: number | null) => (value === null ? "" : ` (${lineText(value, fmt, true)})`);
  switch (sel.kind) {
    case "home":
      if (family === "ASIAN_HANDICAP" || family === "EUROPEAN_HANDICAP") return { code: "1", label: `${home}${handicap(line)}` };
      return { code: "1", label: home };
    case "away":
      if (family === "ASIAN_HANDICAP" || family === "EUROPEAN_HANDICAP")
        return { code: "2", label: `${away}${handicap(line === null ? null : -line)}` };
      return { code: "2", label: away };
    case "draw":
      return { code: "X", label: `${t("selection.draw")}${family === "EUROPEAN_HANDICAP" ? handicap(line) : ""}` };
    case "homeOrDraw":
      return { code: "1X", label: t("matches.sel.homeOrDraw", { home }) };
    case "homeOrAway":
      return { code: "12", label: t("matches.sel.homeOrAway") };
    case "drawOrAway":
      return { code: "X2", label: t("matches.sel.drawOrAway", { away }) };
    case "over":
      return { code: null, label: line === null ? t("selection.over") : t("matches.sel.over", { line: lineText(line, fmt) }) };
    case "under":
      return {
        code: null,
        label: line === null ? t("selection.under") : t("matches.sel.under", { line: lineText(line, fmt) })
      };
    case "yes":
      return { code: null, label: t("selection.yes") };
    case "no":
      return { code: null, label: t("selection.no") };
    case "odd":
      return { code: null, label: t("matches.sel.odd") };
    case "even":
      return { code: null, label: t("matches.sel.even") };
    case "score":
    case "htft":
      return { code: sel.text ?? null, label: "" };
    default:
      return { code: null, label: sel.text ?? "—" };
  }
}
