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

/** Stats period names come from FlashScore in English ("Match", "1st Half", "1st Quarter"). */
export function statsPeriodLabel(name: string, t: T): string {
  const known: Record<string, MessageKey> = {
    match: "matches.stats.period.match",
    "1st half": "matches.stats.period.firstHalf",
    "2nd half": "matches.stats.period.secondHalf",
    "1st period": "matches.stats.period.firstPeriod",
    "2nd period": "matches.stats.period.secondPeriod",
    "3rd period": "matches.stats.period.thirdPeriod",
    "1st quarter": "matches.stats.period.firstQuarter",
    "2nd quarter": "matches.stats.period.secondQuarter",
    "3rd quarter": "matches.stats.period.thirdQuarter",
    "4th quarter": "matches.stats.period.fourthQuarter",
    overtime: "matches.stats.period.overtime",
    "extra time": "matches.stats.period.extraTime",
    penalties: "matches.stats.period.shootout"
  };
  const key = known[name.trim().toLowerCase()];
  return key ? t(key) : name;
}

const STAT_CATEGORIES: Record<string, MessageKey> = {
  score: "matches.stats.cat.score",
  "top stats": "matches.stats.cat.topStats",
  shots: "matches.stats.cat.shots",
  attack: "matches.stats.cat.attack",
  passes: "matches.stats.cat.passes",
  defense: "matches.stats.cat.defense",
  goalkeeping: "matches.stats.cat.goalkeeping",
  "period scoring": "matches.stats.cat.periodScoring",
  "match stats": "matches.stats.cat.matchStats",
  scoring: "matches.stats.cat.scoring",
  rebounds: "matches.stats.cat.rebounds",
  other: "matches.stats.cat.other"
};

/**
 * Stats category caption. FlashScore names them in English; "Top players
 * (MIN vs VGK)" keeps its team abbreviations. Unknown names pass through.
 */
export function statCategoryLabel(name: string, t: T): string {
  const players = /^top players\b\s*(.*)$/i.exec(name.trim());
  if (players) return [t("matches.stats.cat.topPlayers"), players[1]].filter(Boolean).join(" ");
  const key = STAT_CATEGORIES[name.trim().toLowerCase()];
  return key ? t(key) : name;
}

/** Upstream statistic names (lower-cased) for every sport in the archive. */
const STAT_LABELS: Record<string, MessageKey> = {
  "final score": "matches.stat.finalScore",
  "current score": "matches.stat.currentScore",
  "period score": "matches.stat.periodScore",
  "period 1": "matches.stat.period1",
  "period 2": "matches.stat.period2",
  "period 3": "matches.stat.period3",
  "period 4": "matches.stat.period4",
  "period 5": "matches.stat.period5",
  "expected goals (xg)": "matches.stat.xg",
  "ball possession": "matches.stat.possession",
  "total shots": "matches.stat.totalShots",
  "shots on target": "matches.stat.shotsOnTarget",
  "shots off target": "matches.stat.shotsOffTarget",
  "blocked shots": "matches.stat.blockedShots",
  "big chances": "matches.stat.bigChances",
  "corner kicks": "matches.stat.corners",
  "passes": "matches.stat.passes",
  "yellow cards": "matches.stat.yellowCards",
  "red cards": "matches.stat.redCards",
  "free kicks": "matches.stat.freeKicks",
  "offsides": "matches.stat.offsides",
  "throw ins": "matches.stat.throwIns",
  "goalkeeper saves": "matches.stat.keeperSaves",
  "fouls": "matches.stat.fouls",
  "crosses": "matches.stat.crosses",
  "interceptions": "matches.stat.interceptions",
  "hit the woodwork": "matches.stat.woodwork",
  "shots inside the box": "matches.stat.shotsInsideBox",
  "shots outside the box": "matches.stat.shotsOutsideBox",
  "passes in final third": "matches.stat.finalThirdPasses",
  "touches in opposition box": "matches.stat.boxTouches",
  "tackles": "matches.stat.tackles",
  "clearances": "matches.stat.clearances",
  "xg on target (xgot)": "matches.stat.xgot",
  "xgot faced": "matches.stat.xgotFaced",
  "expected assists (xa)": "matches.stat.xa",
  "errors leading to shot": "matches.stat.errorsToShot",
  "errors leading to goal": "matches.stat.errorsToGoal",
  "goals prevented": "matches.stat.goalsPrevented",
  "duels won": "matches.stat.duelsWon",
  "long passes": "matches.stat.longPasses",
  "accurate through passes": "matches.stat.throughPasses",
  "headed goals": "matches.stat.headedGoals",
  "shots on goal": "matches.stat.shotsOnGoal",
  "empty net goals": "matches.stat.emptyNetGoals",
  "power-play goals": "matches.stat.powerPlayGoals",
  "shorthanded goals": "matches.stat.shorthandedGoals",
  "power-play pct": "matches.stat.powerPlayPct",
  "pen. killing pct": "matches.stat.penaltyKillPct",
  "saves pct": "matches.stat.savePct",
  "shooting pct": "matches.stat.shootingPct",
  "faceoffs": "matches.stat.faceoffs",
  "faceoffs won": "matches.stat.faceoffsWon",
  "faceoffs %": "matches.stat.faceoffsPct",
  "hits": "matches.stat.hits",
  "pim": "matches.stat.penaltyMinutes",
  "penalties in minutes": "matches.stat.penaltyMinutes",
  "penalties": "matches.stat.penalties",
  "giveaways": "matches.stat.giveaways",
  "takeaways": "matches.stat.takeaways",
  "goals": "matches.stat.goals",
  "points": "matches.stat.points",
  "+/- points": "matches.stat.plusMinus",
  "time on ice": "matches.stat.timeOnIce",
  "field goals %": "matches.stat.fgPct",
  "field goals attempts": "matches.stat.fgAttempts",
  "field goals attempted": "matches.stat.fgAttempts",
  "field goals made": "matches.stat.fgMade",
  "2-point field goals %": "matches.stat.twoPct",
  "2-point field goals attempts": "matches.stat.twoAttempts",
  "2-point field goals attempted": "matches.stat.twoAttempts",
  "2-point field goals made": "matches.stat.twoMade",
  "3-point field goals %": "matches.stat.threePct",
  "3-point field goals attempts": "matches.stat.threeAttempts",
  "3-point field goals attempted": "matches.stat.threeAttempts",
  "3-point field goals made": "matches.stat.threeMade",
  "free throws %": "matches.stat.ftPct",
  "free throws attempts": "matches.stat.ftAttempts",
  "free throws attempted": "matches.stat.ftAttempts",
  "free throws made": "matches.stat.ftMade",
  "offensive rebounds": "matches.stat.offRebounds",
  "defensive rebounds": "matches.stat.defRebounds",
  "total rebounds": "matches.stat.totalRebounds",
  "assists": "matches.stat.assists",
  "blocks": "matches.stat.blocks",
  "steals": "matches.stat.steals",
  "turnovers": "matches.stat.turnovers",
  "personal fouls": "matches.stat.personalFouls",
  "technical fouls": "matches.stat.technicalFouls",
  "minutes played": "matches.stat.minutesPlayed",
  "1st downs": "matches.stat.firstDowns",
  "2-point conversions": "matches.stat.twoPointConversions",
  "field goals succeeded": "matches.stat.fieldGoalsMade",
  "fumbles lost": "matches.stat.fumblesLost",
  "interception thrown": "matches.stat.interceptionsThrown",
  "passing touchdowns": "matches.stat.passingTouchdowns",
  "passing yards": "matches.stat.passingYards",
  "penalties yards": "matches.stat.penaltyYards",
  "punts": "matches.stat.punts",
  "rushing touchdowns": "matches.stat.rushingTouchdowns",
  "rushing yards": "matches.stat.rushingYards",
  "sacks allowed": "matches.stat.sacksAllowed",
  "safeties": "matches.stat.safeties",
  "total yards": "matches.stat.totalYards",
  "touchdowns": "matches.stat.touchdowns",
  "turnover touchdowns": "matches.stat.turnoverTouchdowns"
};

/** Names whose meaning depends on the sport (kicked field goals in American football). */
const SPORT_STAT_LABELS: Record<string, Record<string, MessageKey>> = {
  "american football": { "field goals attempts": "matches.stat.fieldGoalAttemptsKicked" }
};

/**
 * Statistic name. Player rows ("Top Points") sit under a "Top players"
 * caption, so the prefix is dropped. Names not in the catalog are shown as
 * FlashScore publishes them.
 */
export function statLabel(label: string, sport: string | null | undefined, t: T): string {
  const name = label.trim().replace(/^top\s+/i, "");
  const lower = name.toLowerCase();
  const key = SPORT_STAT_LABELS[sport?.toLowerCase() ?? ""]?.[lower] ?? STAT_LABELS[lower];
  return key ? t(key) : name;
}

/**
 * Locale-formats the leading number of a stat value, keeping its decimals and
 * any detail after it: "1.20" → "1,20", "6.45% (2/31)" → "6,45 % (2/31)",
 * "-1 (Dorofeyev P.)" → "−1 (Dorofeyev P.)". Anything else ("12:58", text)
 * passes through.
 */
export function statValue(value: string, fmt: Formatters): string {
  const m = /^(-?\d+(?:\.(\d+))?)(%?)(\s+\(.*\))?$/.exec(value.trim());
  if (!m) return value;
  const n = Number(m[1]);
  const digits = m[2]?.length ?? 0;
  const head = m[3] ? fmt.pct(n / 100, digits) : fmt.num(n, digits);
  return head + (m[4] ?? "");
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
