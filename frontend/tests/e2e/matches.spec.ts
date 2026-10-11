import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { stubJson, stubShell } from "./fixtures/stub";

// Relative times ("5 months ago") and local kick-offs hang off "now", so the
// clock and zone are pinned: 12:00 UTC = 14:00 in Prague.
const NOW = "2026-10-11T12:00:00.000Z";
test.use({ timezoneId: "Europe/Prague" });

const EVENT_ID = "xSeyNx8N";
const HOME_ID = "86rBR4Qi";
const AWAY_ID = "tKtJPre4";

// ---------------------------------------------------------------------------
// Matches list (/api/scraped-matches)
// ---------------------------------------------------------------------------

type ListItem = {
  event_id: string;
  home_team: string | null;
  away_team: string | null;
  event_name: string | null;
  sport: string | null;
  country: string | null;
  competition: string | null;
  start_time_utc: string | null;
  status: "finished" | "live" | "scheduled" | "unconfirmed";
  outcome: string | null;
  score: { home: number; away: number } | null;
  odds_snapshots: number;
  stats_snapshots: number;
  last_fetched_at: string | null;
  live_bets: number;
  backtest_bets: number;
};

function item(
  event_id: string,
  [home_team, away_team]: [string | null, string | null],
  sport: string,
  country: string,
  competition: string,
  start_time_utc: string,
  status: ListItem["status"],
  score: [number, number] | null,
  extra: Partial<ListItem> = {}
): ListItem {
  const outcome = score ? (score[0] > score[1] ? "home_win" : score[0] < score[1] ? "away_win" : "draw") : null;
  return {
    event_id,
    home_team,
    away_team,
    event_name: home_team && away_team ? `${home_team} vs ${away_team}` : null,
    sport,
    country,
    competition,
    start_time_utc,
    status,
    outcome,
    score: score ? { home: score[0], away: score[1] } : null,
    odds_snapshots: 1,
    stats_snapshots: 1,
    last_fetched_at: "2026-05-13T20:34:57.993491+00:00",
    live_bets: 0,
    backtest_bets: 0,
    ...extra
  };
}

const CZ = "CZECH REPUBLIC";
const SPARTA: ListItem = item(EVENT_ID, ["Sparta Prague", "Hradec Kralove"], "football", CZ, "Chance Liga - Championship Group", "2026-05-24T12:00:00Z", "finished", [2, 1], {
  odds_snapshots: 2,
  stats_snapshots: 4,
  last_fetched_at: "2026-10-11T10:11:50.286017+00:00",
  live_bets: 1,
  backtest_bets: 3
});

const LIST_ITEMS: ListItem[] = [
  item("Hk5Lb3eq", ["Slavia Prague", "Plzen"], "football", CZ, "Chance Liga - Championship Group", "2026-10-18T14:30:00Z", "scheduled", null, { stats_snapshots: 0, last_fetched_at: "2026-10-11T06:00:00Z" }),
  SPARTA,
  item("8An7HGVp", ["Jablonec", "Liberec"], "football", CZ, "Chance Liga - Championship Group", "2026-05-24T12:00:00Z", "unconfirmed", null),
  item("xfi4Ju8N", ["Manchester City", "Crystal Palace"], "football", "ENGLAND", "Premier League", "2026-05-24T15:00:00Z", "unconfirmed", null, { live_bets: 2 }),
  item("fmDL2DBG", ["Ostrava", "Teplice"], "football", CZ, "Chance Liga - Relegation Group", "2026-05-17T13:00:00Z", "finished", [3, 0]),
  item("Ny2Ra9pl", ["Colorado Avalanche", "Dallas Stars"], "hockey", "USA", "NHL - Play Offs", "2026-05-16T01:00:00Z", "finished", null, { backtest_bets: 1 }),
  item("Bm4Dt7xq", ["Boston Celtics", "New York Knicks"], "basketball", "USA", "NBA - Play Offs", "2026-05-15T23:30:00Z", "finished", null),
  item("04dTK6BL", [null, null], "hockey", CZ, "Extraliga", "2016-10-15T13:30:00Z", "finished", null)
];

const FACETS = {
  sport: [
    { value: "football", count: 20117 },
    { value: "hockey", count: 16086 },
    { value: "basketball", count: 12275 },
    { value: "american football", count: 3509 }
  ],
  country: [
    { value: "USA", count: 28575 },
    { value: "ENGLAND", count: 8698 },
    { value: CZ, count: 4893 },
    { value: "GERMANY", count: 3088 },
    { value: "SPAIN", count: 4157 },
    { value: "FRANCE", count: 2445 }
  ],
  league: [
    { value: "NHL", count: 12802 },
    { value: "NBA", count: 12275 },
    { value: "Championship", count: 4525 },
    { value: "Premier League", count: 4173 },
    { value: "NFL", count: 3509 },
    { value: "Extraliga", count: 3284 },
    { value: "Bundesliga", count: 3062 },
    { value: "LaLiga", count: 2729 },
    { value: "Ligue 1", count: 2445 },
    { value: "Primera Division", count: 1428 },
    { value: "FORTUNA:LIGA", count: 1138 },
    { value: "Chance Liga", count: 326 }
  ],
  status: [
    { value: "finished", count: 52355 },
    { value: "unconfirmed", count: 18 }
  ],
  bets: [
    { value: "live", count: 10 },
    { value: "backtest", count: 2574 }
  ]
};

function listBody(items: ListItem[], total: number, exact: ListItem | null = null) {
  return { items, total, offset: 0, limit: 50, facets: FACETS, exact };
}

/** Every request the page sends to /api/scraped-matches, for asserting query params. */
async function stubList(page: Page, status = 200): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route(/\/api\/scraped-matches(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    if (status !== 200) {
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "scraped_matches_load_failed", message: "database is locked" } })
      });
    }
    const q = url.searchParams.get("q") ?? "";
    const body =
      q === "zzz"
        ? listBody([], 0)
        : q === EVENT_ID
          ? listBody([SPARTA], 1, SPARTA)
          : listBody(LIST_ITEMS, 52_373);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return seen;
}

// ---------------------------------------------------------------------------
// Match detail (/api/backend/events/*, /predict, /api/snapshots)
// Odds are a trimmed copy of the real stored snapshot of xSeyNx8N, whose
// upstream order is [home, away, draw] for 1X2 and [12, 1X, X2] for double
// chance — the board must not label them by position.
// ---------------------------------------------------------------------------

const EVENT = {
  event_id: EVENT_ID,
  home_team: "Sparta Prague",
  away_team: "Hradec Kralove",
  sport: "football",
  country: CZ,
  competition: "Chance Liga - Championship Group",
  competition_path: "FOOTBALL/CZECH REPUBLIC/CHANCE LIGA - CHAMPIONSHIP GROUP - ROUND 5",
  start_time_utc: "2026-05-24T12:00:00Z",
  status: "finished",
  status_detail: null,
  outcome: "home_win",
  score: { home: 2, away: 1 },
  is_terminal: true,
  latest_odds_fetched_at: "2026-10-11T10:11:49.326043+00:00",
  latest_stats_fetched_at: "2026-10-11T10:11:50.286017+00:00",
  odds_snapshot_count: 2,
  stats_snapshot_count: 4
};
const STORED_BOOKS: [string, string, [string, string, [string, string, number][]][]][] = [
  ["49", "Tipsport.cz", [
    ["HOME_DRAW_AWAY:FIRST_HALF", "1X2 - First Half", [["86rBR4Qi", "86rBR4Qi", 1.59], ["tKtJPre4", "tKtJPre4", 8.83], ["HOME_DRAW_AWAY:FIRST_HALF:2", "Selection", 2.77]]],
    ["HOME_DRAW_AWAY:FULL_TIME", "1X2 - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.23], ["tKtJPre4", "tKtJPre4", 11.2], ["HOME_DRAW_AWAY:FULL_TIME:2", "Selection", 6.1]]],
    ["DRAW_NO_BET:FULL_TIME", "Draw No Bet - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.04], ["tKtJPre4", "tKtJPre4", 9.59]]],
    ["OVER_UNDER:FULL_TIME", "Over/Under - Full Time", [["OVER", "OVER (1.5)", 1.15], ["OVER", "OVER (2.0)", 1.2], ["OVER", "OVER (2.5)", 1.5], ["OVER", "OVER (3.0)", 1.8], ["OVER", "OVER (3.5)", 2.33], ["OVER", "OVER (4.0)", 3.29], ["OVER", "OVER (4.5)", 3.96], ["OVER", "OVER (5.5)", 7.01], ["UNDER", "UNDER (1.5)", 5.38], ["UNDER", "UNDER (2.0)", 4.39], ["UNDER", "UNDER (2.5)", 2.57], ["UNDER", "UNDER (3.0)", 2.01], ["UNDER", "UNDER (3.5)", 1.61], ["UNDER", "UNDER (4.0)", 1.32], ["UNDER", "UNDER (4.5)", 1.24], ["UNDER", "UNDER (5.5)", 1.08]]],
    ["ASIAN_HANDICAP:FULL_TIME", "Asian Handicap - Full Time", [["tKtJPre4", "(1.5)", 2.14], ["86rBR4Qi", "(-1.5)", 1.71], ["tKtJPre4", "(1.75)", 1.9], ["86rBR4Qi", "(-1.75)", 1.9], ["tKtJPre4", "(2.0)", 1.66], ["86rBR4Qi", "(-2.0)", 2.22]]],
    ["DOUBLE_CHANCE:FULL_TIME", "Double Chance - Full Time", [["DOUBLE_CHANCE:FULL_TIME:0", "Selection", 1.13], ["86rBR4Qi", "86rBR4Qi", 1.03], ["tKtJPre4", "tKtJPre4", 3.91]]],
    ["CORRECT_SCORE:FIRST_HALF", "Correct Score - First Half", [["2:3", "2:3", 1.0], ["1:3", "1:3", 1.0], ["0:0", "0:0", 3.85], ["1:0", "1:0", 3.18], ["0:1", "0:1", 11.1]]],
    ["CORRECT_SCORE:FULL_TIME", "Correct Score - Full Time", [["2:3", "2:3", 61.0], ["0:0", "0:0", 17.1], ["1:0", "1:0", 7.54], ["1:1", "1:1", 10.6], ["0:1", "0:1", 29.7], ["2:0", "2:0", 6.31], ["2:1", "2:1", 7.81], ["1:2", "1:2", 29.1], ["3:0", "3:0", 7.44]]],
    ["BOTH_TEAMS_TO_SCORE:FULL_TIME", "Both Teams To Score - Full Time", [["BOTH_TEAMS_TO_SCORE:FULL_TIME:0", "Selection", 1.95], ["BOTH_TEAMS_TO_SCORE:FULL_TIME:1", "Selection", 1.76]]]
  ]],
  ["46", "iFortuna.cz", [
    ["HOME_DRAW_AWAY:FIRST_HALF", "1X2 - First Half", [["86rBR4Qi", "86rBR4Qi", 1.54], ["tKtJPre4", "tKtJPre4", 9.8], ["HOME_DRAW_AWAY:FIRST_HALF:2", "Selection", 2.95]]],
    ["HOME_DRAW_AWAY:FULL_TIME", "1X2 - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.23], ["tKtJPre4", "tKtJPre4", 13.0], ["HOME_DRAW_AWAY:FULL_TIME:2", "Selection", 6.2]]],
    ["DRAW_NO_BET:FULL_TIME", "Draw No Bet - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.05], ["tKtJPre4", "tKtJPre4", 8.4]]],
    ["OVER_UNDER:FULL_TIME", "Over/Under - Full Time", [["OVER", "OVER (1.5)", 1.16], ["OVER", "OVER (2.0)", 1.22], ["OVER", "OVER (2.5)", 1.51], ["OVER", "OVER (3.0)", 1.79], ["OVER", "OVER (3.5)", 2.26], ["OVER", "OVER (4.0)", 3.2], ["OVER", "OVER (4.5)", 3.8], ["OVER", "OVER (5.5)", 7.0], ["UNDER", "UNDER (1.5)", 5.4], ["UNDER", "UNDER (2.0)", 4.4], ["UNDER", "UNDER (2.5)", 2.55], ["UNDER", "UNDER (3.0)", 2.04], ["UNDER", "UNDER (3.5)", 1.65], ["UNDER", "UNDER (4.0)", 1.36], ["UNDER", "UNDER (4.5)", 1.27], ["UNDER", "UNDER (5.5)", 1.1]]],
    ["ASIAN_HANDICAP:FULL_TIME", "Asian Handicap - Full Time", [["tKtJPre4", "(1.5)", 2.21], ["86rBR4Qi", "(-1.5)", 1.62], ["tKtJPre4", "(2.0)", 1.76], ["86rBR4Qi", "(-2.0)", 2.0]]],
    ["DOUBLE_CHANCE:FULL_TIME", "Double Chance - Full Time", [["DOUBLE_CHANCE:FULL_TIME:0", "Selection", 1.13], ["86rBR4Qi", "86rBR4Qi", 1.05], ["tKtJPre4", "tKtJPre4", 3.8]]],
    ["CORRECT_SCORE:FIRST_HALF", "Correct Score - First Half", [["0:0", "0:0", 3.9], ["1:0", "1:0", 3.1], ["0:1", "0:1", 13.0]]],
    ["CORRECT_SCORE:FULL_TIME", "Correct Score - Full Time", [["2:3", "2:3", 100.0], ["0:0", "0:0", 18.0], ["1:0", "1:0", 8.0], ["1:1", "1:1", 11.0], ["0:1", "0:1", 30.0], ["2:0", "2:0", 6.2], ["2:1", "2:1", 9.2], ["1:2", "1:2", 35.0], ["3:0", "3:0", 6.8]]],
    ["BOTH_TEAMS_TO_SCORE:FULL_TIME", "Both Teams To Score - Full Time", [["BOTH_TEAMS_TO_SCORE:FULL_TIME:0", "Selection", 2.06], ["BOTH_TEAMS_TO_SCORE:FULL_TIME:1", "Selection", 1.68]]]
  ]],
  ["657", "Betano.cz", [
    ["HOME_DRAW_AWAY:FIRST_HALF", "1X2 - First Half", [["86rBR4Qi", "86rBR4Qi", 1.65], ["tKtJPre4", "tKtJPre4", 8.75], ["HOME_DRAW_AWAY:FIRST_HALF:2", "Selection", 2.72]]],
    ["HOME_DRAW_AWAY:FULL_TIME", "1X2 - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.24], ["tKtJPre4", "tKtJPre4", 12.5], ["HOME_DRAW_AWAY:FULL_TIME:2", "Selection", 6.6]]],
    ["DRAW_NO_BET:FULL_TIME", "Draw No Bet - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.07], ["tKtJPre4", "tKtJPre4", 7.5]]],
    ["OVER_UNDER:FULL_TIME", "Over/Under - Full Time", [["OVER", "OVER (1.5)", 1.17], ["OVER", "OVER (2.5)", 1.45], ["OVER", "OVER (3.5)", 2.27], ["OVER", "OVER (4.5)", 3.8], ["OVER", "OVER (5.5)", 6.7], ["UNDER", "UNDER (1.5)", 5.1], ["UNDER", "UNDER (2.5)", 2.77], ["UNDER", "UNDER (3.5)", 1.65], ["UNDER", "UNDER (4.5)", 1.27], ["UNDER", "UNDER (5.5)", 1.11]]],
    ["ASIAN_HANDICAP:FULL_TIME", "Asian Handicap - Full Time", [["tKtJPre4", "(1.5)", 2.25], ["86rBR4Qi", "(-1.5)", 1.65], ["tKtJPre4", "(1.75)", 2.02], ["86rBR4Qi", "(-1.75)", 1.8], ["tKtJPre4", "(2.0)", 1.78], ["86rBR4Qi", "(-2.0)", 2.05]]],
    ["DOUBLE_CHANCE:FULL_TIME", "Double Chance - Full Time", [["DOUBLE_CHANCE:FULL_TIME:0", "Selection", 1.12], ["86rBR4Qi", "86rBR4Qi", 1.06], ["tKtJPre4", "tKtJPre4", 4.3]]],
    ["CORRECT_SCORE:FIRST_HALF", "Correct Score - First Half", [["2:3", "2:3", 500.0], ["1:3", "1:3", 450.0], ["0:0", "0:0", 3.55], ["1:0", "1:0", 3.1], ["0:1", "0:1", 10.75]]],
    ["CORRECT_SCORE:FULL_TIME", "Correct Score - Full Time", [["2:3", "2:3", 120.0], ["0:0", "0:0", 12.5], ["1:0", "1:0", 7.3], ["1:1", "1:1", 13.0], ["0:1", "0:1", 24.0], ["2:0", "2:0", 6.8], ["2:1", "2:1", 10.0], ["1:2", "1:2", 37.0], ["3:0", "3:0", 7.7]]],
    ["BOTH_TEAMS_TO_SCORE:FULL_TIME", "Both Teams To Score - Full Time", [["BOTH_TEAMS_TO_SCORE:FULL_TIME:0", "Selection", 2.07], ["BOTH_TEAMS_TO_SCORE:FULL_TIME:1", "Selection", 1.7]]]
  ]],
  ["45", "Chance.cz", [
    ["HOME_DRAW_AWAY:FIRST_HALF", "1X2 - First Half", [["86rBR4Qi", "86rBR4Qi", 1.59], ["tKtJPre4", "tKtJPre4", 8.83], ["HOME_DRAW_AWAY:FIRST_HALF:2", "Selection", 2.77]]],
    ["HOME_DRAW_AWAY:FULL_TIME", "1X2 - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.23], ["tKtJPre4", "tKtJPre4", 11.2], ["HOME_DRAW_AWAY:FULL_TIME:2", "Selection", 6.1]]],
    ["DRAW_NO_BET:FULL_TIME", "Draw No Bet - Full Time", [["86rBR4Qi", "86rBR4Qi", 1.04], ["tKtJPre4", "tKtJPre4", 9.59]]],
    ["OVER_UNDER:FULL_TIME", "Over/Under - Full Time", [["OVER", "OVER (1.5)", 1.15], ["OVER", "OVER (2.0)", 1.2], ["OVER", "OVER (2.5)", 1.5], ["OVER", "OVER (3.0)", 1.8], ["OVER", "OVER (3.5)", 2.33], ["OVER", "OVER (4.0)", 3.29], ["OVER", "OVER (4.5)", 3.96], ["OVER", "OVER (5.5)", 7.01], ["UNDER", "UNDER (1.5)", 5.38], ["UNDER", "UNDER (2.0)", 4.39], ["UNDER", "UNDER (2.5)", 2.57], ["UNDER", "UNDER (3.0)", 2.01], ["UNDER", "UNDER (3.5)", 1.61], ["UNDER", "UNDER (4.0)", 1.32], ["UNDER", "UNDER (4.5)", 1.24], ["UNDER", "UNDER (5.5)", 1.08]]],
    ["ASIAN_HANDICAP:FULL_TIME", "Asian Handicap - Full Time", [["tKtJPre4", "(1.5)", 2.14], ["86rBR4Qi", "(-1.5)", 1.71], ["tKtJPre4", "(1.75)", 1.9], ["86rBR4Qi", "(-1.75)", 1.9], ["tKtJPre4", "(2.0)", 1.66], ["86rBR4Qi", "(-2.0)", 2.22]]],
    ["DOUBLE_CHANCE:FULL_TIME", "Double Chance - Full Time", [["DOUBLE_CHANCE:FULL_TIME:0", "Selection", 1.13], ["86rBR4Qi", "86rBR4Qi", 1.03], ["tKtJPre4", "tKtJPre4", 3.91]]],
    ["CORRECT_SCORE:FIRST_HALF", "Correct Score - First Half", [["2:3", "2:3", 1.0], ["1:3", "1:3", 1.0], ["0:0", "0:0", 3.85], ["1:0", "1:0", 3.18], ["0:1", "0:1", 11.1]]],
    ["CORRECT_SCORE:FULL_TIME", "Correct Score - Full Time", [["2:3", "2:3", 61.0], ["0:0", "0:0", 17.1], ["1:0", "1:0", 7.54], ["1:1", "1:1", 10.6], ["0:1", "0:1", 29.7], ["2:0", "2:0", 6.31], ["2:1", "2:1", 7.81], ["1:2", "1:2", 29.1], ["3:0", "3:0", 7.44]]],
    ["BOTH_TEAMS_TO_SCORE:FULL_TIME", "Both Teams To Score - Full Time", [["BOTH_TEAMS_TO_SCORE:FULL_TIME:0", "Selection", 1.95], ["BOTH_TEAMS_TO_SCORE:FULL_TIME:1", "Selection", 1.76]]]
  ]]
];
function storedOdds() {
  return {
    event: {
      event_id: EVENT_ID,
      event_name: null,
      competition_name: null,
      start_time: null,
      bookmakers: STORED_BOOKS.map(([id, name, markets]) => ({
        id,
        name,
        region: null,
        markets: markets.map(([key, marketName, outcomes]) => ({
          id: key,
          name: marketName,
          key,
          outcomes: outcomes.map(([oid, label, price]) => ({
            id: oid,
            label,
            selection_key: oid,
            odds_decimal: price,
            odds_fractional: null,
            probability: null
          }))
        }))
      }))
    },
    retrieved_at: "2026-10-11T10:11:49.000000+00:00",
    source: "livesport",
    fetched_at: "2026-10-11T10:11:49.326043+00:00",
    served_from: "stored"
  };
}

const stat = (code: string | null, label: string, home: string, away: string) => ({ code, label, home, away });

const STATS = {
  event: {
    event_id: EVENT_ID,
    home_team: "Sparta Prague",
    away_team: "Hradec Kralove",
    sport: "football",
    country: CZ,
    competition: "Chance Liga - Championship Group",
    competition_stage: "Round 5",
    competition_path: EVENT.competition_path,
    start_time_utc: "2026-05-24T12:00:00Z",
    status: "finished",
    status_detail: null,
    outcome: "home_win",
    periods: [
      {
        name: "Match",
        categories: [
          { name: "Score", stats: [stat(null, "Final score", "2", "1")] },
          {
            name: "Top stats",
            stats: [
              stat("432", "Expected goals (xG)", "1.20", "1.09"),
              stat("12", "Ball possession", "77%", "23%"),
              stat("34", "Total shots", "16", "5"),
              stat("13", "Shots on target", "7", "2"),
              stat("459", "Big chances", "2", "2"),
              stat("16", "Corner kicks", "7", "1"),
              stat("342", "Passes", "93% (550/594)", "72% (126/176)"),
              stat("23", "Yellow cards", "0", "3")
            ]
          }
        ]
      },
      {
        name: "1st Half",
        categories: [
          {
            name: "Top stats",
            stats: [
              stat("432", "Expected goals (xG)", "0.67", "0.86"),
              stat("12", "Ball possession", "84%", "16%"),
              stat("34", "Total shots", "9", "2"),
              stat("13", "Shots on target", "4", "2")
            ]
          }
        ]
      }
    ]
  },
  retrieved_at: "2026-10-11T10:11:50.000000+00:00",
  source: "livesport",
  fetched_at: "2026-10-11T10:11:50.286017+00:00"
};

const PICKS = {
  live: [
    {
      id: 17,
      event_id: EVENT_ID,
      model: "logistic",
      market: "1X2_FT",
      selection: "home",
      recommended_at: "2026-05-22T06:23:24Z",
      price_at_recommendation: 1.25,
      closing_price: 1.23,
      model_prob: 0.842,
      devigged_prob: 0.761,
      edge: 0.081,
      kelly_full: 0.21,
      result: 1,
      pnl: 0.0525,
      clv: 0.0161,
      status: "settled",
      settled_at: "2026-05-24T14:10:00Z",
      model_version: "3"
    }
  ],
  backtest: [
    ...[
      ["home", 1.23, 0.81, 0.757, 1, 0.012],
      ["draw", 6.1, 0.19, 0.151, 0, -0.018]
    ].map(([selection, price, p, devig, result, pnl]) => ({
      run_id: "0fe2009fdb43494683fedb86956c2d2a",
      run_label: "logistic_2026-05-18T21:27:18.358543Z",
      model: "logistic",
      event_id: EVENT_ID,
      bet_ts: "2026-05-24T11:55:00Z",
      kickoff_ts: "2026-05-24T12:00:00Z",
      market: "HOME_DRAW_AWAY:FULL_TIME",
      selection,
      price_taken: price,
      closing_price: price,
      model_prob: p,
      implied_prob: 1 / (price as number),
      devigged_prob: devig,
      edge: (p as number) - (devig as number),
      stake_kelly_fraction: 0.25,
      result,
      pnl,
      clv: null
    })),
    {
      run_id: "263ad0a570a54ba6b40a8510d973e0ca",
      run_label: "market_implied_2026-05-14T05:44:09.977074Z",
      model: "market_implied",
      event_id: EVENT_ID,
      bet_ts: "2026-05-24T11:55:00Z",
      kickoff_ts: "2026-05-24T12:00:00Z",
      market: "HOME_DRAW_AWAY:FULL_TIME",
      selection: "away",
      price_taken: 11.2,
      closing_price: 11.2,
      model_prob: 0.093,
      implied_prob: 0.089,
      devigged_prob: 0.084,
      edge: 0.009,
      stake_kelly_fraction: 0.25,
      result: 0,
      pnl: -0.002,
      clv: null
    }
  ]
};

function prediction(model: string, selection: string, p: number, price: number, devig: number) {
  return {
    model,
    market: "1X2_FT",
    selection,
    model_prob: p,
    market_price: price,
    market_implied: 1 / price,
    market_devigged: devig,
    edge: p - devig,
    kelly_full: null,
    notes: {}
  };
}

const PREDICT = {
  event_id: EVENT_ID,
  predictions: [
    prediction("logistic", "home", 0.842, 1.23, 0.761),
    prediction("logistic", "draw", 0.104, 6.1, 0.153),
    prediction("logistic", "away", 0.054, 11.2, 0.086),
    prediction("hgb", "home", 0.733, 1.23, 0.761),
    prediction("hgb", "draw", 0.171, 6.1, 0.153),
    prediction("hgb", "away", 0.096, 11.2, 0.086)
  ],
  available_models: { logistic: true, hgb: true, dixon_coles: false }
};

const NO_MODELS = { event_id: EVENT_ID, predictions: [], available_models: { logistic: false, hgb: false, dixon_coles: false } };

const CAPTURES = ["2026-05-13T20:40:01.605297+00:00", "2026-05-12T06:23:16.406180+00:00"];

/** One live capture: insertion order lists participants home, away, then DRAW. */
function liveRows(fetchedAt: string, drawPrice: number) {
  const rows: { bookmaker: string; market: string; selection_key: string; price: number }[] = [];
  for (const [book, shift] of [
    ["Tipsport.cz", 0],
    ["Betano.cz", 0.05]
  ] as const) {
    rows.push(
      { bookmaker: book, market: "HOME_DRAW_AWAY:FULL_TIME", selection_key: HOME_ID, price: 1.21 + shift },
      { bookmaker: book, market: "HOME_DRAW_AWAY:FULL_TIME", selection_key: AWAY_ID, price: 12.5 + shift },
      { bookmaker: book, market: "HOME_DRAW_AWAY:FULL_TIME", selection_key: "DRAW", price: drawPrice + shift },
      { bookmaker: book, market: "OVER_UNDER:FULL_TIME", selection_key: "OVER@2.5", price: 1.48 + shift },
      { bookmaker: book, market: "OVER_UNDER:FULL_TIME", selection_key: "UNDER@2.5", price: 2.6 + shift }
    );
  }
  return { event_id: EVENT_ID, fetched_at: fetchedAt, rows };
}

type DetailOptions = {
  event?: Record<string, unknown> | null;
  eventStatus?: number;
  predict?: unknown;
  odds?: unknown;
  captures?: string[];
};

async function stubDetail(page: Page, opts: DetailOptions = {}) {
  const id = String(opts.event?.event_id ?? EVENT_ID);
  const base = `**/api/backend/events/${id}`;
  if (opts.eventStatus && opts.eventStatus !== 200) {
    const message = opts.eventStatus === 404 ? `Event ${id} not found` : "Internal Server Error";
    await stubJson(page, base, { detail: message }, opts.eventStatus);
  } else {
    await stubJson(page, base, { ...EVENT, ...(opts.event ?? {}) });
  }
  await stubJson(page, `${base}/odds`, opts.odds ?? storedOdds());
  await stubJson(page, `${base}/stats`, { ...STATS, event: { ...STATS.event, event_id: id } });
  await stubJson(page, `${base}/picks`, PICKS);
  await stubJson(page, `**/api/backend/predict/${id}`, opts.predict ?? PREDICT);
  const captures = opts.captures ?? CAPTURES;
  await stubJson(
    page,
    `**/api/snapshots/${id}`,
    captures.map((fetched_at) => ({ fetched_at, rows: 10, bookmakers: 2, markets: 2 }))
  );
  await page.route(new RegExp(`/api/snapshots/${id}/[^/?]+$`), (route) => {
    const at = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(liveRows(at, at === CAPTURES[0] ? 9.4 : 8.8))
    });
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Pins the clock, fails any un-stubbed /api call loudly, stubs the shell and
 * records every /api request the page makes.
 */
async function setup(page: Page): Promise<string[]> {
  await page.clock.setFixedTime(new Date(NOW));
  const requests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 599,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unstubbed", message: `Unstubbed ${route.request().url()}` } })
    })
  );
  await stubShell(page);
  return requests;
}

const UPSTREAM = /^\/api\/(odds|match-stats)\//;

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

// ---------------------------------------------------------------------------
// Matches list
// ---------------------------------------------------------------------------

test.describe("Matches list", () => {
  test("lists stored matches by team name and opens one", async ({ page }) => {
    await setup(page);
    await stubList(page);
    await stubDetail(page);
    await page.goto("/en/matches");

    await expect(page.getByRole("heading", { level: 1, name: "Matches" })).toBeVisible();
    await expect(page.getByText("52,373 stored matches")).toBeVisible();
    await expect(page.getByText("8 of 52,373").first()).toBeVisible();
    // Never raw ids where teams exist; team-less rows get a neutral label.
    await expect(page.getByRole("link", { name: /Jablonec – Liberec/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Unnamed match/ })).toBeVisible();
    await expect(page.getByRole("table").getByText("04dTK6BL")).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Jablonec – Liberec/ }).getByText("Unconfirmed")).toBeVisible();

    await page.getByRole("link", { name: /Sparta Prague – Hradec Kralove/ }).click();
    await expect(page).toHaveURL(new RegExp(`/en/matches/${EVENT_ID}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Sparta Prague – Hradec Kralove" })).toBeVisible();
  });

  test("search, facets and sort live in the URL", async ({ page }) => {
    await setup(page);
    const seen = await stubList(page);
    await page.goto("/en/matches");
    await expect(page.getByRole("link", { name: /Jablonec – Liberec/ })).toBeVisible();

    await page.getByRole("searchbox", { name: "Search matches" }).fill("sparta");
    await expect(page).toHaveURL(/[?&]q=sparta/);

    if (isMobile(page)) {
      await page.getByRole("button", { name: /^Filters/ }).click();
      const dialog = page.getByRole("dialog", { name: "Filter matches" });
      await dialog.getByRole("checkbox", { name: /Czech Republic/ }).check();
      await expect(page).toHaveURL(/country=CZECH(\+|%20)REPUBLIC/);
      await dialog.getByRole("button", { name: /Show 52,373 matches/ }).click();
      await expect(dialog).toBeHidden();
    } else {
      await page.getByRole("button", { name: /^Country/ }).click();
      await page.getByRole("checkbox", { name: /Czech Republic/ }).check();
      await expect(page).toHaveURL(/country=CZECH(\+|%20)REPUBLIC/);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("checkbox", { name: /Czech Republic/ })).toBeHidden();
    }
    await expect(page.getByRole("button", { name: "Remove filter Country: Czech Republic" })).toBeVisible();

    await page.getByRole("combobox", { name: "Sort" }).selectOption("fetched_desc");
    await expect(page).toHaveURL(/sort=fetched_desc/);

    const last = seen[seen.length - 1];
    expect(last.searchParams.get("q")).toBe("sparta");
    expect(last.searchParams.get("country")).toBe(CZ);
    expect(last.searchParams.get("sort")).toBe("fetched_desc");

    // The URL is the state: a reload restores search, filter chip and sort.
    await page.reload();
    await expect(page.getByRole("searchbox", { name: "Search matches" })).toHaveValue("sparta");
    await expect(page.getByRole("button", { name: "Remove filter Country: Czech Republic" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue("fetched_desc");
  });

  test("an exact event id offers a direct open-match row", async ({ page }) => {
    await setup(page);
    await stubList(page);
    await page.goto(`/en/matches?q=${EVENT_ID}`);
    await expect(page.getByText(`Event id ${EVENT_ID}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open match" })).toHaveAttribute("href", `/en/matches/${EVENT_ID}`);
  });

  test("an empty result names the filters and clears them", async ({ page }) => {
    await setup(page);
    await stubList(page);
    await page.goto("/en/matches?q=zzz&league=NHL");
    await expect(page.getByText("No stored match fits these filters")).toBeVisible();
    await expect(page.getByText("Search “zzz” · 1 filter active")).toBeVisible();
    await page.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(page).toHaveURL(/\/en\/matches$/);
    await expect(page.getByRole("link", { name: /Jablonec – Liberec/ })).toBeVisible();
  });

  test("a failing index shows an error callout and keeps the controls", async ({ page }) => {
    await setup(page);
    await stubList(page, 500);
    await page.goto("/en/matches");
    await expect(page.getByText("Couldn't load stored matches")).toBeVisible();
    await expect(page.getByText("database is locked")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Matches" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search matches" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("renders in Czech", async ({ page }) => {
    await setup(page);
    await stubList(page);
    await page.goto("/cs/matches");
    await expect(page.getByRole("heading", { level: 1, name: "Zápasy" })).toBeVisible();
    await expect(page.getByText(/52\s373 uložených zápasů/)).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Výkop/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Jablonec – Liberec/ }).getByText("Nepotvrzeno")).toBeVisible();
  });

  test("does not overflow a 390px viewport", async ({ page }) => {
    await setup(page);
    await stubList(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/en/matches");
    await expect(page.getByRole("link", { name: /Jablonec – Liberec/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Match detail
// ---------------------------------------------------------------------------

test.describe("Match detail", () => {
  test("renders header, model view, bets, odds and stats from stored data only", async ({ page }) => {
    const requests = await setup(page);
    await stubDetail(page);
    await page.goto(`/en/matches/${EVENT_ID}`);

    await expect(page.getByRole("heading", { level: 1, name: "Sparta Prague – Hradec Kralove" })).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: "Matches" })).toHaveAttribute("href", "/en/matches");
    await expect(crumbs.getByRole("link", { name: "Chance Liga" })).toHaveAttribute("href", "/en/matches?league=Chance+Liga");
    await expect(page.getByLabel("Score 2:1")).toBeVisible();
    await expect(page.getByText(/Stored data · newest snapshot/)).toBeVisible();
    await expect(page.getByText("Final result stored — snapshots are frozen")).toBeVisible();
    // Terminal: no upstream action is offered.
    await expect(page.getByRole("button", { name: /Fetch latest from FlashScore/ })).toHaveCount(0);

    const model = page.locator("#model");
    await expect(model.getByRole("heading", { name: "Model view" })).toBeVisible();
    const logisticHome = model.getByRole("row").filter({ hasText: "Logistic" }).filter({ hasText: "Sparta Prague" });
    await expect(logisticHome).toContainText("84.2%");
    await expect(logisticHome).toContainText("+8.1%");

    const bets = page.locator("#bets");
    await expect(bets.getByRole("link", { name: "Run of May 18, 2026, 11:27 PM" })).toHaveAttribute(
      "href",
      "/en/lab/backtests/0fe2009fdb43494683fedb86956c2d2a"
    );
    await expect(bets.getByText("CLV is not shown for backtests")).toBeVisible();

    // 1X2 full time is the default market. Upstream lists [home, away, draw]:
    // Tipsport's draw is 6.10 and away 11.20, never the other way round.
    const odds = page.locator("#odds");
    await expect(odds.getByRole("tab", { name: "1X2" })).toHaveAttribute("aria-selected", "true");
    await expect(odds.getByText(/Stored snapshot · fetched/)).toBeVisible();
    const tipsport = 1; // column index: selection, Tipsport, iFortuna, Betano, Chance
    await expect(odds.getByRole("row").filter({ hasText: "Draw" }).getByRole("cell").nth(tipsport)).toHaveText("6.10");
    await expect(odds.getByRole("row").filter({ hasText: "Hradec Kralove" }).getByRole("cell").nth(tipsport)).toHaveText("11.20");
    // Betano's 6.60 draw is strictly best; a margin row closes the table.
    await expect(odds.getByRole("row").filter({ hasText: "Draw" }).getByRole("cell").nth(3)).toContainText("best price");
    await expect(odds.getByRole("row").filter({ hasText: "Margin" }).getByRole("cell").nth(tipsport)).toHaveText("6.6%");

    // Double chance: the participant-less outcome is 12, the home id is 1X.
    await odds.getByRole("tab", { name: "Double chance" }).click();
    await expect(page).toHaveURL(/market=DOUBLE_CHANCE/);
    await expect(odds.getByRole("row").filter({ hasText: "1X" }).getByRole("cell").nth(tipsport)).toHaveText("1.03");
    await expect(odds.getByRole("row").filter({ hasText: "12" }).getByRole("cell").nth(tipsport)).toHaveText("1.13");

    // Correct score: sorted by goals, 1.00 placeholders shown as suspended.
    await odds.getByRole("tab", { name: "Correct score" }).click();
    await odds.getByRole("radio", { name: "1st half" }).click();
    await expect(page).toHaveURL(/period=FIRST_HALF/);
    const firstRow = odds.getByRole("row").nth(1);
    await expect(firstRow.getByRole("cell").first()).toHaveText("0:0");
    await expect(odds.getByRole("row").filter({ hasText: "2:3" }).getByRole("cell").nth(tipsport)).toHaveText("—suspended");

    const stats = page.locator("#stats");
    await expect(stats.getByRole("row", { name: /Ball possession/ })).toContainText("77%");
    await stats.getByRole("radio", { name: "1st half" }).click();
    await expect(stats.getByRole("row", { name: /Ball possession/ })).toContainText("84%");

    expect(requests.filter((p) => UPSTREAM.test(p))).toEqual([]);
  });

  test("a live capture swaps the odds board and is kept in the URL", async ({ page }) => {
    await setup(page);
    await stubDetail(page);
    await page.goto(`/en/matches/${EVENT_ID}`);
    const odds = page.locator("#odds");
    await odds.getByRole("radio", { name: /May 13, 2026, 10:40 PM/i }).click();
    await expect(page).toHaveURL(/snap=2026-05-13/);
    await expect(odds.getByText(/Live capture · May 13, 2026, 10:40 PM/)).toBeVisible();
    await expect(odds.getByRole("row").filter({ hasText: "Draw" }).getByRole("cell").nth(1)).toHaveText("9.40");
    await odds.getByRole("radio", { name: /Stored/i }).click();
    await expect(page).not.toHaveURL(/snap=/);
    await expect(odds.getByRole("row").filter({ hasText: "Draw" }).getByRole("cell").nth(1)).toHaveText("6.10");
  });

  test("fetching from FlashScore needs confirmation and only exists before the result", async ({ page }) => {
    const requests = await setup(page);
    await stubDetail(page, {
      event: { is_terminal: false, outcome: null, score: null, status: "scheduled", start_time_utc: "2026-10-18T14:30:00Z" }
    });
    await stubJson(page, `**/api/odds/${EVENT_ID}`, storedOdds());
    await stubJson(page, `**/api/match-stats/${EVENT_ID}`, STATS);
    await page.goto(`/en/matches/${EVENT_ID}`);
    await expect(page.getByText("Scheduled").first()).toBeVisible();

    const fetchButton = page.getByRole("button", { name: /Fetch latest from FlashScore/ });
    await fetchButton.click();
    const dialog = page.getByRole("dialog", { name: "Fetch latest from FlashScore?" });
    await expect(dialog).toContainText("sends live requests to FlashScore");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(requests.filter((p) => UPSTREAM.test(p))).toEqual([]);

    await fetchButton.click();
    await dialog.getByRole("button", { name: "Fetch from FlashScore" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Fetched from FlashScore at/)).toBeVisible();
    expect(requests).toContain(`/api/odds/${EVENT_ID}`);
    expect(requests).toContain(`/api/match-stats/${EVENT_ID}`);
  });

  test("no served model explains itself and links to the registry", async ({ page }) => {
    await setup(page);
    await stubDetail(page, { predict: NO_MODELS });
    await page.goto(`/en/matches/${EVENT_ID}`);
    const model = page.locator("#model");
    await expect(model.getByText("No trained model is being served")).toBeVisible();
    await expect(model.getByRole("link", { name: "Open model registry" })).toHaveAttribute("href", "/en/lab/registry");
    await expect(model.getByText(/This match is finished/)).toBeVisible();
  });

  test("an unknown event shows a not-found state", async ({ page }) => {
    const requests = await setup(page);
    await stubDetail(page, { event: { event_id: "nope1234" }, eventStatus: 404 });
    await page.goto("/en/matches/nope1234");
    await expect(page.getByRole("heading", { level: 1, name: "Match not found" })).toBeVisible();
    await expect(page.getByText("No stored match has the id “nope1234”")).toBeVisible();
    await expect(page.getByRole("link", { name: "Search stored matches" })).toHaveAttribute("href", "/en/matches?q=nope1234");
    expect(requests.filter((p) => UPSTREAM.test(p))).toEqual([]);
  });

  test("a failing event keeps the page chrome and the other panels", async ({ page }) => {
    await setup(page);
    await stubDetail(page, { eventStatus: 500 });
    await page.goto(`/en/matches/${EVENT_ID}`);
    await expect(page.getByText("Couldn't load this match")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Match" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect(page.locator("#odds").getByRole("tab", { name: "1X2" })).toBeVisible();
    await expect(page.locator("#stats").getByRole("row", { name: /Ball possession/ })).toBeVisible();
  });

  test("renders in Czech", async ({ page }) => {
    await setup(page);
    await stubDetail(page);
    await page.goto(`/cs/matches/${EVENT_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Sparta Prague – Hradec Kralove" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pohled modelů" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tipy a sázky" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Kurzy" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Statistiky" })).toBeVisible();
    await expect(page.locator("#odds").getByRole("tab", { name: "Dvojitá šance" })).toBeVisible();
    await expect(page.locator("#odds").getByRole("row").filter({ hasText: "Remíza" }).first()).toBeVisible();
  });

  test("does not overflow a 390px viewport", async ({ page }) => {
    await setup(page);
    await stubDetail(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/en/matches/${EVENT_ID}`);
    await expect(page.locator("#odds").getByRole("tab", { name: "1X2" })).toBeVisible();
    await expect(page.locator("#stats").getByRole("row", { name: /Ball possession/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Visual review only: MATCHES_SHOTS=<dir> npx playwright test matches --project=chromium
// ---------------------------------------------------------------------------

test.describe("Matches screenshots", () => {
  const dir = process.env.MATCHES_SHOTS;
  test.skip(!dir, "set MATCHES_SHOTS=<dir> to capture screenshots");

  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ];

  for (const locale of ["en", "cs"] as const) {
    for (const vp of viewports) {
      test(`list and detail · ${vp.name} · ${locale}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "screenshots come from one project");
        mkdirSync(dir!, { recursive: true });
        await setup(page);
        await stubList(page);
        await stubDetail(page);
        await page.setViewportSize({ width: vp.width, height: vp.height });

        await page.goto(`/${locale}/matches`);
        await expect(page.getByRole("link", { name: /Jablonec – Liberec/ })).toBeVisible();
        await page.screenshot({ path: path.join(dir!, `matches-list-${vp.name}-${locale}.png`), fullPage: true });

        await page.goto(`/${locale}/matches/${EVENT_ID}`);
        await expect(page.locator("#stats").getByRole("row", { name: /Ball possession|Držení míče/ })).toBeVisible();
        await expect(page.locator("#model").getByRole("table")).toBeVisible();
        await page.screenshot({ path: path.join(dir!, `matches-detail-${vp.name}-${locale}.png`), fullPage: true });
      });
    }
  }
});
