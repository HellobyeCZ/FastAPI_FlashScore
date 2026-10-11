import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { stubJson, stubShell } from "./fixtures/stub";

/**
 * Performance section: leaderboard, bet explorer and model page. Every /api
 * request is stubbed (a catch-all records anything unexpected), the clock is
 * pinned so the data-anchored default window is deterministic.
 */

const NOW = new Date("2026-10-11T12:00:00Z");

// Custom windows are local calendar days; pin the zone so their bounds (and
// which fixture bets fall inside them) don't depend on the machine.
test.use({ timezoneId: "UTC" });

// ---------------------------------------------------------------------------
// Fixtures (shapes of FastAPI /picks/*, /backtest/runs, /mlflow/registry)

type Bet = {
  id: number;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  recommended_at: string;
  bet_ts: string;
  price_at_recommendation: number;
  closing_price: number | null;
  model_prob: number;
  devigged_prob: number;
  edge: number;
  kelly_full: number;
  result: number | null;
  pnl: number | null;
  clv: number | null;
  status: "settled" | "pending";
  settled_at: string | null;
  kickoff: string;
  home_team: string;
  away_team: string;
  /** null when the match archive has no entry for the event. */
  competition: string | null;
  country: string;
  home_team_raw: string;
  away_team_raw: string;
  competition_path: string;
};

const MATCHES: [string, string, string, string][] = [
  ["Sparta Prague", "Slavia Prague", "Chance Liga - Championship Group", "CZECH REPUBLIC"],
  ["Jablonec", "Plzeň", "Chance Liga - Championship Group", "CZECH REPUBLIC"],
  ["Teplice", "Dukla Prague", "Chance Liga - Relegation Group", "CZECH REPUBLIC"],
  ["Real Betis", "Sevilla", "LaLiga", "SPAIN"],
  ["Girona", "Valencia", "LaLiga", "SPAIN"],
  ["Brentford", "Fulham", "Premier League", "ENGLAND"]
];

type ModelCounts = [model: string, n: number, wins: number, prices: number[]][];

/**
 * Settled bets per model. logistic is the only model with n ≥ 30, so no value
 * is marked best (there is nothing to compare it with); hgb ends up with the
 * highest ROI on 10 bets, so its values are dimmed.
 */
const MODEL_COUNTS: ModelCounts = [
  ["logistic", 42, 18, [1.85, 2.1, 2.4, 2.9, 3.4]],
  ["dixon_coles", 12, 3, [1.85, 2.4, 3.3]],
  ["hgb", 10, 3, [3.3, 4.6, 6.2]]
];

/** Same fixture with Dixon–Coles above the threshold too: two rankable models. */
const TWO_RANKABLE: ModelCounts = [
  ["logistic", 42, 18, [1.85, 2.1, 2.4, 2.9, 3.4]],
  ["dixon_coles", 36, 14, [1.85, 2.4, 3.3]],
  ["hgb", 10, 3, [3.3, 4.6, 6.2]]
];

function buildBets(counts: ModelCounts = MODEL_COUNTS): Bet[] {
  const bets: Bet[] = [];
  let id = 1;
  for (const [model, n, wins, prices] of counts) {
    for (let i = 0; i < n; i++) {
      const [home, away, competition, country] = MATCHES[(i + id) % MATCHES.length];
      const ou = i % 3 === 0;
      const price = prices[i % prices.length];
      const edge = 0.01 + ((i * 7) % 13) / 100;
      const stake = 0.02 + (i % 4) * 0.015;
      // Spread exactly `wins` wins evenly over the model's bets.
      const won = Math.floor(((i + 1) * wins) / n) > Math.floor((i * wins) / n);
      const day = 1 + (i % 9);
      const kickoff = `2026-10-${String(day).padStart(2, "0")}T18:30:00+00:00`;
      bets.push({
        id,
        event_id: `ev${String(id).padStart(5, "0")}`,
        model,
        market: ou ? "OVER_UNDER_2.5_FT" : "1X2_FT",
        selection: ou ? (i % 2 ? "over" : "under") : ["home", "draw", "away"][i % 3],
        recommended_at: `2026-10-${String(day).padStart(2, "0")}T06:00:00+00:00`,
        bet_ts: `2026-10-${String(day).padStart(2, "0")}T05:59:58+00:00`,
        price_at_recommendation: price,
        closing_price: i % 6 === 5 ? null : price * (1 - ((i % 5) - 2) / 100),
        model_prob: 1 / price + edge,
        devigged_prob: 1 / price,
        edge,
        kelly_full: stake,
        result: won ? 1 : 0,
        pnl: won ? stake * (price - 1) : -stake,
        clv: i % 6 === 5 ? null : ((i % 5) - 2) / 100,
        status: "settled",
        settled_at: `2026-10-${String(day).padStart(2, "0")}T21:00:00+00:00`,
        kickoff,
        home_team: home,
        away_team: away,
        competition,
        country,
        home_team_raw: home,
        away_team_raw: away,
        competition_path: `football/${country.toLowerCase().replace(" ", "-")}/x`
      });
      id++;
    }
  }
  for (let i = 0; i < 3; i++) {
    const [home, away, competition, country] = MATCHES[i];
    bets.push({
      ...bets[i],
      id: id++,
      event_id: `evp${i}`,
      result: null,
      pnl: null,
      clv: null,
      closing_price: null,
      status: "pending",
      settled_at: null,
      kickoff: "2026-10-12T18:30:00+00:00",
      home_team: home,
      away_team: away,
      competition,
      country
    });
  }
  return bets;
}

const BETS = buildBets();
const SETTLED = BETS.filter((b) => b.status === "settled");

const FACETS = {
  models: ["dixon_coles", "hgb", "logistic"],
  markets: ["1X2_FT", "OVER_UNDER_2.5_FT"],
  sports: ["football"],
  countries: ["CZECH REPUBLIC", "ENGLAND", "SPAIN"],
  competitions: [
    "Chance Liga - Championship Group",
    "Chance Liga - Relegation Group",
    "LaLiga",
    "Premier League"
  ],
  selections: ["away", "draw", "home", "over", "under"]
};

function summary(lastSettled: string | null) {
  return {
    totals: { n: 67, settled: 64, pending: 3, voided: 0, total_pnl: 0.31, mean_clv: 0.0042 },
    per_model: [],
    per_market: [],
    settled_series: lastSettled ? [{ settled_at: lastSettled, pnl: 0.12, clv: 0.01 }] : [],
    last_recommended_at: lastSettled,
    last_settled_at: lastSettled,
    oldest_pending_kickoff: "2026-10-12T18:30:00+00:00"
  };
}

/** Bets matching the /picks/stats and /picks/history filter params. */
function filterBets(bets: Bet[], url: URL, defaultStatus: string | null): Bet[] {
  const status = url.searchParams.get("status") ?? defaultStatus;
  const list = (name: string) => (url.searchParams.get(name) ?? "").split(",").filter(Boolean);
  const num = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : null);
  const [models, markets, comps, selections] = ["model", "market", "competition", "selection"].map(list);
  const [edgeMin, edgeMax, priceMin, priceMax] = ["edge_min", "edge_max", "price_min", "price_max"].map(num);
  const from = url.searchParams.get("date_from");
  const to = url.searchParams.get("date_to");
  return bets.filter((b) => {
    const t = b.settled_at ?? b.recommended_at;
    return (
      (!status || status === "all" || b.status === status) &&
      (!from || Date.parse(t) >= Date.parse(from)) &&
      (!to || Date.parse(t) <= Date.parse(to)) &&
      (!models.length || models.includes(b.model)) &&
      (!markets.length || markets.includes(b.market)) &&
      (!comps.length || (b.competition !== null && comps.includes(b.competition))) &&
      (!selections.length || selections.includes(b.selection)) &&
      (edgeMin === null || b.edge >= edgeMin) &&
      (edgeMax === null || b.edge <= edgeMax) &&
      (priceMin === null || b.price_at_recommendation >= priceMin) &&
      (priceMax === null || b.price_at_recommendation <= priceMax)
    );
  });
}

/** Same metrics as app/ml/paper_trade_stats.aggregate (null when undefined). */
function metrics(bets: Bet[]) {
  const n = bets.length;
  const wins = bets.filter((b) => b.result === 1).length;
  const stake = bets.reduce((a, b) => a + b.kelly_full, 0);
  const pnl = bets.reduce((a, b) => a + (b.pnl ?? 0), 0);
  const clvs = bets.map((b) => b.clv).filter((c): c is number => c !== null);
  let running = 0;
  let peak = 0;
  let maxDd = 0;
  for (const b of [...bets].sort((x, y) => (x.settled_at ?? "").localeCompare(y.settled_at ?? ""))) {
    running += b.pnl ?? 0;
    peak = Math.max(peak, running);
    maxDd = Math.max(maxDd, peak - running);
  }
  return {
    n,
    wins,
    stake_total: stake,
    pnl_total: pnl,
    mean_clv: clvs.length ? clvs.reduce((a, c) => a + c, 0) / clvs.length : null,
    brier: n ? bets.reduce((a, b) => a + (b.model_prob - (b.result ?? 0)) ** 2, 0) / n : null,
    hit_rate: n ? wins / n : null,
    roi: stake > 0 ? pnl / stake : null,
    max_drawdown: maxDd
  };
}

const GROUP_KEY: Record<string, (b: Bet) => string | null> = {
  model: (b) => b.model,
  market: (b) => b.market,
  competition: (b) => b.competition,
  selection: (b) => b.selection,
  day: (b) => (b.settled_at ?? b.recommended_at).slice(0, 10)
};

/** /picks/stats body: one overall row without group_by, else one row per group (null keys included). */
function statsBody(all: Bet[], url: URL) {
  const groupBy = (url.searchParams.get("group_by") ?? "").split(",").filter(Boolean);
  const bets = filterBets(all, url, "settled");
  if (!groupBy.length) return { group_by: [], filters: {}, rows: [metrics(bets)] };
  const groups = new Map<string, Bet[]>();
  for (const b of bets) {
    const key = JSON.stringify(groupBy.map((g) => GROUP_KEY[g](b)));
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const rows = [...groups.entries()].map(([key, list]) => ({
    ...Object.fromEntries((JSON.parse(key) as (string | null)[]).map((v, i) => [groupBy[i], v])),
    ...metrics(list)
  }));
  return { group_by: groupBy, filters: {}, rows };
}

const CALIBRATION: Record<string, { lower: number; upper: number; n: number; mean_pred: number; hit_rate: number }[]> = {
  logistic: [
    { lower: 0.2, upper: 0.3, n: 9, mean_pred: 0.27, hit_rate: 0.22 },
    { lower: 0.3, upper: 0.4, n: 12, mean_pred: 0.35, hit_rate: 0.33 },
    { lower: 0.4, upper: 0.5, n: 11, mean_pred: 0.46, hit_rate: 0.45 },
    { lower: 0.5, upper: 0.6, n: 6, mean_pred: 0.55, hit_rate: 0.5 },
    { lower: 0.6, upper: 0.7, n: 4, mean_pred: 0.64, hit_rate: 0.75 }
  ],
  dixon_coles: [
    { lower: 0.2, upper: 0.3, n: 3, mean_pred: 0.27, hit_rate: 0.33 },
    { lower: 0.3, upper: 0.4, n: 5, mean_pred: 0.33, hit_rate: 0.4 },
    { lower: 0.4, upper: 0.5, n: 4, mean_pred: 0.46, hit_rate: 0.5 }
  ]
};

const RUN_BASE = {
  test_until: null,
  started_at: "2026-05-18T21:27:20Z",
  finished_at: "2026-05-18T21:41:02Z",
  error: null,
  stage: null,
  market_spec: "football_1x2_ft",
  log_loss: 0.5688,
  max_drawdown: 6.22,
  mean_clv: null,
  mlflow_run_id: null,
  mlflow_ui_url: null
};

const BACKTEST_RUNS = {
  items: [
    {
      ...RUN_BASE,
      id: "0fe2009f-6d0c-4a43-9a3e-3f3f0f1b2c11",
      label: "logistic_2026-05-18T21:27:18Z",
      model: "logistic",
      status: "completed",
      created_at: "2026-05-18T21:27:18Z",
      train_until: "2024-08-01T00:00:00Z",
      test_events: 2686,
      total_bets: 2756,
      hit_rate: 0.298,
      roi: -0.0932,
      brier: 0.1919,
      sharpe_adjusted: -0.03,
      mlflow_run_id: "69106395b400429da2d05176533eed0e",
      mlflow_ui_url: "http://127.0.0.1:5050/#/experiments/2/runs/69106395b400429da2d05176533eed0e"
    },
    {
      ...RUN_BASE,
      id: "a1aeda64-0000-4000-8000-000000000001",
      label: "logistic_2026-05-17T09:02:41Z",
      model: "logistic",
      status: "completed",
      created_at: "2026-05-17T09:02:41Z",
      train_until: "2025-08-01T00:00:00Z",
      test_events: 0,
      total_bets: 0,
      hit_rate: 0,
      roi: 0,
      brier: 0,
      sharpe_adjusted: null
    },
    {
      ...RUN_BASE,
      id: "2e4d319e-0000-4000-8000-000000000002",
      label: "dixon_coles_2026-05-16T10:00:00Z",
      model: "dixon_coles",
      status: "completed",
      created_at: "2026-05-16T10:00:00Z",
      train_until: "2024-08-01T00:00:00Z",
      test_events: 306,
      total_bets: 306,
      hit_rate: 0.33,
      roi: -0.3146,
      brier: 0.222,
      sharpe_adjusted: -0.2
    }
  ]
};

const MLFLOW_STATUS = {
  enabled: true,
  reachable: true,
  tracking_uri: "http://127.0.0.1:5050",
  ui_url: "http://127.0.0.1:5050",
  experiment_name: "picks",
  experiment_id: "2",
  error: null,
  checked_at: "2026-10-11T12:00:00Z"
};

const version = (v: string, aliases: string[], roi: number, n: number) => ({
  version: v,
  run_id: `run${v}`,
  created_at: `2026-10-0${v}T10:00:00Z`,
  aliases,
  status: "READY",
  description: null,
  metrics: { roi, sharpe_adjusted: roi / 3, n_bets: n, brier: 0.19 + Number(v) / 100 },
  purpose: "walk_forward_backtest",
  train_until: "2024-08-01T00:00:00Z",
  ui_url: `http://127.0.0.1:5050/#/models/picks-logistic/versions/${v}`
});

const REGISTRY = {
  status: MLFLOW_STATUS,
  models: [
    {
      name: "picks-logistic",
      model_name: "logistic",
      aliases: { champion: "3", challenger: "4" },
      versions: [version("2", [], -0.12, 1856), version("3", ["champion"], -0.0932, 2756), version("4", ["challenger"], -0.041, 2810)],
      servable: true,
      ui_url: "http://127.0.0.1:5050/#/models/picks-logistic"
    }
  ]
};

// ---------------------------------------------------------------------------
// Stubs

type Options = {
  lastSettled?: string | null;
  empty?: boolean;
  failStats?: string;
  /** /picks/facets answers 500 this many times before it recovers. */
  failFacets?: number;
  registry?: unknown;
  counts?: ModelCounts;
  /** Edits each fixture bet (e.g. drop its CLV or competition). */
  mutate?: (b: Bet) => Bet;
  /** /picks/history as before spec §4.3: status + limit only, no joined columns. */
  legacy?: boolean;
};

/** History stub with the new contract: filters, offset, count = total, newest first. */
function historyBody(bets: Bet[], url: URL) {
  const rows = filterBets(bets, url, null).sort(
    (a, b) => b.recommended_at.localeCompare(a.recommended_at) || b.id - a.id
  );
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  return { count: rows.length, rows: rows.slice(offset, offset + limit) };
}

/**
 * The pre-§4.3 /picks/history: honours status and limit only (no other
 * filter, no offset), orders by id, has no home_team/away_team/competition
 * columns and reports count = rows returned.
 */
function legacyHistoryBody(bets: Bet[], url: URL) {
  const status = url.searchParams.get("status");
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const rows = bets
    .filter((b) => !status || b.status === status)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map((b) => {
      const row: Partial<Bet> = { ...b };
      for (const k of ["home_team", "away_team", "competition", "country"] as const) delete row[k];
      return row;
    });
  return { count: rows.length, rows };
}

async function stubPerformance(page: Page, opts: Options = {}) {
  const {
    lastSettled = "2026-10-09T21:00:00Z",
    empty = false,
    failStats,
    failFacets = 0,
    registry = REGISTRY,
    counts,
    mutate = (b: Bet) => b,
    legacy = false
  } = opts;
  const bets = (counts ? buildBets(counts) : BETS).map(mutate);
  let facetFailures = failFacets;
  const unstubbed: string[] = [];
  const requests: URL[] = [];

  // Registered first = lowest precedence: anything not stubbed below fails loudly.
  await page.route("**/api/**", (route: Route) => {
    unstubbed.push(route.request().url());
    return route.fulfill({ status: 599, contentType: "application/json", body: '{"detail":"unstubbed"}' });
  });
  await stubShell(page);
  await page.route("**/api/backend/picks/facets*", (route) => {
    if (facetFailures > 0) {
      facetFailures--;
      return route.fulfill({ status: 500, json: { detail: "facets query failed" } });
    }
    return route.fulfill({ json: empty ? { ...FACETS, models: [], competitions: [] } : FACETS });
  });
  await stubJson(page, "**/api/backend/picks/summary", empty ? summary(null) : summary(lastSettled));
  await stubJson(page, "**/api/backend/backtest/runs", BACKTEST_RUNS);
  await stubJson(page, "**/api/backend/mlflow/registry", registry);
  await page.route("**/api/backend/picks/stats/calibration*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const buckets = empty ? [] : CALIBRATION[url.searchParams.get("model") ?? ""] ?? [];
    return route.fulfill({ json: { model: url.searchParams.get("model"), n_buckets: 10, buckets } });
  });
  await page.route(/\/api\/backend\/picks\/stats(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const groupBy = url.searchParams.get("group_by") ?? "";
    if (failStats !== undefined && groupBy === failStats) {
      return route.fulfill({ status: 500, json: { detail: "aggregation failed: database is locked" } });
    }
    if (empty) {
      return route.fulfill({ json: { group_by: [], filters: {}, rows: groupBy ? [] : [metrics([])] } });
    }
    return route.fulfill({ json: statsBody(bets, url) });
  });
  await page.route("**/api/backend/picks/history*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (empty) return route.fulfill({ json: { count: 0, rows: [] } });
    return route.fulfill({ json: legacy ? legacyHistoryBody(bets, url) : historyBody(bets, url) });
  });

  await page.clock.setFixedTime(NOW);
  return { unstubbed, requests };
}

async function openFilters(page: Page) {
  const toggle = page.getByRole("button", { name: /^Filters/ });
  if (await toggle.isVisible()) await toggle.click();
}

const leaderboardRows = (page: Page) =>
  page.getByRole("region", { name: "Leaderboard" }).locator("tbody tr");

/** The cell under the column whose header starts with `header` (hidden columns included). */
async function cellUnder(table: Locator, row: Locator, header: string): Promise<Locator> {
  const headers = await table.locator("thead th").allTextContents();
  const index = headers.findIndex((h) => h.trim().startsWith(header));
  expect(index, `column ${header}`).toBeGreaterThanOrEqual(0);
  return row.locator("td").nth(index);
}

/** Model with the best value among models with ≥ 30 settled bets, computed from the fixture. */
function expectedBest(bets: Bet[], metric: "roi" | "brier"): string {
  const byModel = new Map<string, Bet[]>();
  for (const b of bets) if (b.status === "settled") byModel.set(b.model, [...(byModel.get(b.model) ?? []), b]);
  const ranked = [...byModel.entries()]
    .filter(([, list]) => list.length >= 30)
    .map(([model, list]) => ({ model, value: metrics(list)[metric] as number }))
    .sort((a, b) => (metric === "brier" ? a.value - b.value : b.value - a.value));
  return ranked[0].model;
}

// ---------------------------------------------------------------------------
// Leaderboard

test.describe("leaderboard", () => {
  test("ranks models, dims small samples, sorts via the URL and links to the model page", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page);
    await page.goto("/en/performance");

    await expect(page.getByRole("heading", { level: 1, name: "Performance" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "90d" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("No settled live bets since")).toHaveCount(0);

    const kpis = page.getByText("Settled bets", { exact: true }).locator("..");
    await expect(kpis).toContainText("64");

    const rows = leaderboardRows(page);
    await expect(rows).toHaveCount(3);
    // Default sort: ROI, highest first.
    await expect(rows.nth(0)).toContainText("Gradient boosting");
    await expect(rows.nth(1)).toContainText("Logistic");
    // hgb has the top ROI but n = 10: its values are dimmed, its interval is not.
    const board = page.getByRole("region", { name: "Leaderboard" });
    const roi = await cellUnder(board.locator("table"), rows.nth(0), "ROI");
    await expect(roi.locator(".opacity-70")).toBeVisible();
    await expect(roi.getByText(/ to /)).not.toHaveClass(/opacity/);
    await expect(rows.nth(1).locator(".opacity-70")).toHaveCount(0);
    // Only logistic has n ≥ 30, so there is nothing to rank it against: no best mark.
    await expect(board.getByText("best", { exact: true })).toHaveCount(0);
    await expect(board.getByText(/marks the best value once at least two models/)).toBeVisible();

    // Second click on the active column flips the direction (kept in the URL).
    await page.getByRole("button", { name: /^ROI/ }).click();
    await expect(page).toHaveURL(/sort=roi&dir=asc/);
    await expect(rows.nth(0)).toContainText("Dixon–Coles");
    await expect(rows.nth(2)).toContainText("Gradient boosting");

    // Every stats request carried the 90-day window.
    const stats = requests.filter((u) => u.pathname.endsWith("/picks/stats"));
    expect(stats.length).toBeGreaterThan(0);
    for (const u of stats) expect(u.searchParams.get("date_from")).toBeTruthy();

    const link = rows.nth(1).getByRole("link", { name: /Logistic/ });
    await expect(link).not.toHaveAttribute("href", /model=/);
    await link.click();
    await expect(page).toHaveURL(/\/en\/models\/logistic/);
    await expect(page.getByRole("heading", { level: 1, name: "Logistic" })).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("defaults to all time with an explanation when nothing settled in 90 days", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page, { lastSettled: "2026-05-13T20:41:26Z" });
    await page.goto("/en/performance");

    const callout = page.getByText(/No settled live bets since .*13, 2026 — showing all time/);
    await expect(callout).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Data ops" }).first()).toHaveAttribute("href", "/en/ops");
    await expect(page.getByRole("radio", { name: "All time" })).toHaveAttribute("aria-checked", "true");
    await expect(leaderboardRows(page)).toHaveCount(3);
    for (const u of requests.filter((r) => r.pathname.endsWith("/picks/stats"))) {
      expect(u.searchParams.get("date_from")).toBeNull();
    }
    expect(unstubbed).toEqual([]);
  });

  test("with two rankable models the best mark lands on the better one", async ({ page }) => {
    const bets = buildBets(TWO_RANKABLE);
    const { unstubbed } = await stubPerformance(page, { counts: TWO_RANKABLE });
    await page.goto("/en/performance?window=all");

    const board = page.getByRole("region", { name: "Leaderboard" });
    const table = board.locator("table");
    await expect(leaderboardRows(page)).toHaveCount(3);
    for (const [header, metric] of [
      ["ROI", "roi"],
      ["Brier", "brier"]
    ] as const) {
      const best = expectedBest(bets, metric);
      for (const model of ["logistic", "dixon_coles", "hgb"]) {
        const row = leaderboardRows(page).filter({ has: page.locator(`a[href="/en/models/${model}?window=all"]`) });
        const cell = await cellUnder(table, row, header);
        await expect(cell.getByText("best", { exact: true }), `${header} best mark on ${model}`).toHaveCount(
          model === best ? 1 : 0
        );
      }
    }
    await expect(board.getByText(/best among models with at least 30 settled bets/)).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("custom window bounds reach every request as local-day ISO bounds", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page);
    await page.goto("/en/performance?window=all");

    await page.getByRole("radio", { name: "Custom" }).click();
    await expect(page).toHaveURL(/window=custom/);
    const from = page.getByLabel("From", { exact: true });
    await from.fill("2026-10-03");
    await expect(page).toHaveURL(/from=2026-10-03/);
    await page.getByLabel("To", { exact: true }).fill("2026-10-05");
    await expect(page).toHaveURL(/to=2026-10-05/);

    // The browser runs in UTC here, so local days map to whole UTC days.
    const settledInRange = SETTLED.filter((b) => b.settled_at! >= "2026-10-03" && b.settled_at! < "2026-10-06").length;
    await expect(page.getByText("Settled bets", { exact: true }).locator("..")).toContainText(String(settledInRange));
    await expect
      .poll(() =>
        requests.some(
          (u) =>
            u.pathname.endsWith("/picks/stats") &&
            u.searchParams.get("date_from") === "2026-10-03T00:00:00.000Z" &&
            u.searchParams.get("date_to") === "2026-10-05T23:59:59.999Z"
        )
      )
      .toBe(true);

    // A year still being typed (0002) never reaches the URL; blur restores the applied day.
    await from.fill("0002-10-03");
    await from.blur();
    await expect(page).toHaveURL(/from=2026-10-03/);
    await expect(from).toHaveValue("2026-10-03");
    expect(unstubbed).toEqual([]);
  });

  test("panels say what settled bets lack instead of claiming there are none", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page, {
      mutate: (b) => ({ ...b, clv: null, closing_price: null, competition: b.model === "hgb" ? null : b.competition })
    });
    await page.goto("/en/performance?window=all");

    const clv = page.getByRole("region", { name: "CLV distribution by model" });
    await expect(clv.getByText("None of the 64 settled bets has a closing price")).toBeVisible();
    await expect(clv.getByRole("link", { name: "Open Data ops" })).toBeVisible();
    // hgb's 10 bets have no competition: drawn competitions add up to 54, and the panel says so.
    const comps = page.getByRole("region", { name: "ROI by competition" });
    await expect(comps.getByText("10 bets with no known competition are not shown.")).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("a competition filter without its stage variants is a scoped error, then recovers", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page, { failFacets: 2 });
    await page.goto("/en/performance?window=all&competition=Chance%20Liga");

    const board = page.getByRole("region", { name: "Leaderboard" });
    await expect(board.getByText("The competition filter can't be applied")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Performance" })).toBeVisible();
    // Nothing was queried with the unexpanded root name.
    expect(requests.filter((u) => u.pathname.endsWith("/picks/stats"))).toEqual([]);

    await board.getByRole("button", { name: "Retry" }).click();
    await expect(leaderboardRows(page)).toHaveCount(3);
    const stats = requests.filter((u) => u.pathname.endsWith("/picks/stats"));
    expect(stats.length).toBeGreaterThan(0);
    for (const u of stats) {
      expect(u.searchParams.get("competition")).toBe("Chance Liga - Championship Group,Chance Liga - Relegation Group");
    }
    expect(unstubbed).toEqual([]);
  });

  test("empty data names the window and offers the fix", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page, { empty: true });
    await page.goto("/en/performance");

    const board = page.getByRole("region", { name: "Leaderboard" });
    await expect(board.getByText("No settled live bets across all time")).toBeVisible();
    await expect(board.getByRole("link", { name: "Open Data ops" })).toBeVisible();
    // Undefined metrics render as a dash, never 0.
    const roi = page.getByText("ROI", { exact: true }).first().locator("..");
    await expect(roi).toContainText("—");
    expect(unstubbed).toEqual([]);
  });

  test("an error in one panel keeps the page and the other panels", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page, { failStats: "competition" });
    await page.goto("/en/performance");

    const panel = page.getByRole("region", { name: "ROI by competition" });
    await expect(panel.getByText("Couldn't load this panel")).toBeVisible();
    await expect(panel.getByText("aggregation failed: database is locked")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();

    await expect(page.getByRole("heading", { level: 1, name: "Performance" })).toBeVisible();
    await expect(leaderboardRows(page)).toHaveCount(3);
    await expect(page.getByRole("region", { name: "Cumulative P&L by model" }).locator("svg").first()).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("renders in Czech", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/cs/performance");

    await expect(page.getByRole("heading", { level: 1, name: "Výkonnost" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Žebříček" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Kumulativní Z/Z podle modelu" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Vše" }).first()).toBeAttached();
    expect(unstubbed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bet explorer

test.describe("bet explorer", () => {
  test("filters live in the URL and reach the bets table request", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page);
    await page.goto("/en/performance/explore?window=all");

    await expect(page.getByRole("heading", { level: 1, name: "Bet explorer" })).toBeVisible();
    const bets = page.getByRole("region", { name: "Bets", exact: true });
    await expect(bets.locator("tbody tr")).toHaveCount(25);
    await expect(bets.getByText("1–25 of 64")).toBeVisible();
    await expect(bets.getByRole("link", { name: /Brentford – Fulham|Sparta Prague – Slavia Prague|Real Betis – Sevilla/ }).first()).toHaveAttribute(
      "href",
      /\/en\/matches\/ev\d+/
    );

    await openFilters(page);
    await page.getByLabel("Market").selectOption("1X2_FT");
    await expect(page).toHaveURL(/market=1X2_FT/);
    await expect
      .poll(() => requests.some((u) => u.pathname.endsWith("/picks/history") && u.searchParams.get("market") === "1X2_FT"))
      .toBe(true);

    const edge = page.getByRole("group", { name: /Edge/ });
    await edge.getByLabel("Min").fill("5");
    await edge.getByLabel("Min").press("Enter");
    await expect(page).toHaveURL(/edge_min=5/);
    await expect
      .poll(() =>
        requests.some(
          (u) =>
            u.pathname.endsWith("/picks/history") &&
            u.searchParams.get("market") === "1X2_FT" &&
            u.searchParams.get("edge_min") === "0.05"
        )
      )
      .toBe(true);
    // The aggregates get the very same filters as the table.
    await expect
      .poll(() =>
        requests.some(
          (u) =>
            u.pathname.endsWith("/picks/stats") &&
            u.searchParams.get("group_by") === "competition,selection" &&
            u.searchParams.get("market") === "1X2_FT" &&
            u.searchParams.get("edge_min") === "0.05"
        )
      )
      .toBe(true);

    await page.reload();
    await openFilters(page);
    await expect(page.getByLabel("Market")).toHaveValue("1X2_FT");
    expect(unstubbed).toEqual([]);
  });

  test("pages the bets table through the URL", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page);
    await page.goto("/en/performance/explore?window=all");

    const bets = page.getByRole("region", { name: "Bets", exact: true });
    await bets.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(bets.getByText("26–50 of 64")).toBeVisible();
    expect(requests.some((u) => u.pathname.endsWith("/picks/history") && u.searchParams.get("offset") === "25")).toBe(true);

    await bets.getByRole("radio", { name: "Pending" }).click();
    await expect(page).toHaveURL(/status=pending/);
    await expect(page).not.toHaveURL(/page=/);
    await expect(bets.locator("tbody tr")).toHaveCount(3);
    expect(unstubbed).toEqual([]);
  });

  test("a heatmap of small cells explains itself and keeps its data table", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/en/performance/explore?window=custom&from=2026-10-03&to=2026-10-05&edge_min=2.5&price_max=3");

    const heatmap = page.getByRole("region", { name: "Mean CLV · competition × pick" });
    await expect(heatmap.getByText("Every cell has fewer than 5 bets")).toBeVisible();
    await expect(heatmap.getByRole("button", { name: "Show all time" })).toBeVisible();
    await heatmap.getByRole("button", { name: "Show data" }).click();
    await expect(heatmap.locator("tbody tr").first()).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("an older history endpoint is filtered and paged in the browser", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page, { legacy: true });
    await page.goto("/en/performance/explore?window=all");

    const bets = page.getByRole("region", { name: "Bets", exact: true });
    await expect(bets.getByText(`1–25 of ${SETTLED.length}`)).toBeVisible();
    // Raw fixture names stand in for the joined team names.
    await expect(bets.getByRole("link", { name: / – / }).first()).toHaveAttribute("href", /\/en\/matches\/ev\d+/);
    await bets.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(bets.getByText(`26–50 of ${SETTLED.length}`)).toBeVisible();

    await openFilters(page);
    await page.getByLabel("Market").selectOption("OVER_UNDER_2.5_FT");
    const ou = SETTLED.filter((b) => b.market === "OVER_UNDER_2.5_FT").length;
    await expect(bets.getByText(`1–${Math.min(25, ou)} of ${ou}`)).toBeVisible();
    await expect(page.getByText("Settled bets", { exact: true }).locator("..")).toContainText(String(ou));

    await page.getByLabel("Competition", { exact: true }).selectOption("LaLiga");
    await expect(bets.getByText(/can't filter individual bets by competition yet/)).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("renders in Czech", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/cs/performance/explore");

    await expect(page.getByRole("heading", { level: 1, name: "Průzkum sázek" })).toBeVisible();
    await expect(page.getByRole("region", { name: "ROI podle decilu výhody" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Sázky", exact: true })).toBeVisible();
    expect(unstubbed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Model page

test.describe("model page", () => {
  test("shows live KPIs, calibration, bets, registry versions and backtests", async ({ page }) => {
    const { unstubbed, requests } = await stubPerformance(page);
    await page.goto("/en/models/logistic?window=all");

    await expect(page.getByRole("heading", { level: 1, name: "Logistic" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Performance" })).toHaveAttribute(
      "href",
      "/en/performance?window=all"
    );
    await expect(page.getByText("Settled bets", { exact: true }).locator("..")).toContainText("42");

    const calibration = page.getByRole("region", { name: "Calibration" });
    await expect(calibration.getByRole("img", { name: "calibration plot" })).toBeVisible();

    const registry = page.getByRole("region", { name: "Registry" });
    await expect(registry.getByText("Champion · v3")).toBeVisible();
    await expect(registry.getByText("Challenger · v4")).toBeVisible();
    await expect(registry.locator("tbody tr")).toHaveCount(3);
    await expect(registry.getByRole("link", { name: "Open registry" })).toHaveAttribute("href", "/en/lab/registry");

    const backtests = page.getByRole("region", { name: "Backtests" });
    await expect(backtests.locator("tbody tr")).toHaveCount(2);
    await expect(backtests.getByRole("link", { name: /logistic_2026-05-18/ })).toHaveAttribute(
      "href",
      "/en/lab/backtests/0fe2009f-6d0c-4a43-9a3e-3f3f0f1b2c11"
    );
    // A completed run without bets shows "no bets" and no fake 0 % ROI.
    const zeroRun = backtests.locator("tbody tr").filter({ hasText: "logistic_2026-05-17" });
    await expect(zeroRun).not.toContainText("0.0%");

    const bets = page.getByRole("region", { name: "Bets", exact: true });
    await expect(bets.getByText("1–25 of 42")).toBeVisible();
    expect(
      requests.filter((u) => u.pathname.endsWith("/picks/history")).every((u) => u.searchParams.get("model") === "logistic")
    ).toBe(true);
    expect(unstubbed).toEqual([]);
  });

  test("calibration below 30 bets shows bucket counts instead of a curve", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/en/models/dixon_coles?window=all");

    const calibration = page.getByRole("region", { name: "Calibration" });
    await expect(calibration.getByText("Not enough settled bets for a calibration curve")).toBeVisible();
    await expect(calibration.getByText("12 settled bets in this window; a curve needs at least 30.", { exact: false })).toBeVisible();
    await expect(calibration.getByRole("img", { name: "calibration plot" })).toHaveCount(0);
    await expect(calibration.locator("tbody tr")).toHaveCount(3);
    // No registered versions of picks-dixon_coles in the stub.
    await expect(page.getByRole("region", { name: "Registry" }).getByText("No registered versions")).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("registry outage stays inside its panel", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page, {
      registry: { status: { ...MLFLOW_STATUS, reachable: false, error: "connection refused" }, models: [] }
    });
    await page.goto("/en/models/logistic?window=all");

    await expect(page.getByRole("region", { name: "Registry" }).getByText("MLflow is unreachable")).toBeVisible();
    await expect(page.getByRole("region", { name: "Backtests" }).locator("tbody tr")).toHaveCount(2);
    await expect(page.getByRole("heading", { level: 1, name: "Logistic" })).toBeVisible();
    expect(unstubbed).toEqual([]);
  });

  test("an unknown model name is an empty state, not a crash", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/en/models/not_a_model");

    await expect(page.getByText("Unknown model “not_a_model”")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to leaderboard" })).toHaveAttribute("href", "/en/performance");
    expect(unstubbed).toEqual([]);
  });

  test("renders in Czech", async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.goto("/cs/models/logistic?window=all");

    await expect(page.getByRole("heading", { level: 1, name: "Logistická regrese" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Kalibrace" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Registr" }).getByText("Šampion · v3")).toBeVisible();
    expect(unstubbed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Responsive

const PAGES = ["en", "cs"].flatMap((l) => [
  `/${l}/performance`,
  `/${l}/performance/explore?window=all`,
  `/${l}/models/logistic?window=all`
]);

for (const path of PAGES) {
  test(`no horizontal overflow at 390px: ${path}`, async ({ page }) => {
    const { unstubbed } = await stubPerformance(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("tbody tr:visible").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    // Data tables fit their panels too: phones get the priority columns, not a
    // sideways scroll. (The heatmap chart scrolls inside its own frame by design.)
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("table")]
        .map((t) => t.parentElement!)
        .filter((el) => el.classList.contains("overflow-x-auto") && el.offsetParent !== null)
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.closest("section")?.querySelector("h2")?.textContent ?? "?")
    );
    expect(clipped).toEqual([]);
    expect(unstubbed).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Screenshots for visual review (opt-in: PERF_SHOTS_DIR=<dir>)

const SHOTS_DIR = process.env.PERF_SHOTS_DIR;

test.describe("screenshots", () => {
  test.skip(!SHOTS_DIR, "set PERF_SHOTS_DIR to capture review screenshots");

  const SHOTS: [name: string, path: string, opts: Options][] = [
    ["leaderboard", "/performance", {}],
    ["leaderboard-stale", "/performance", { lastSettled: "2026-05-13T20:41:26Z" }],
    // Settled bets without closing prices, and one model's bets without a competition.
    [
      "leaderboard-gaps",
      "/performance?window=all",
      { mutate: (b) => ({ ...b, clv: null, closing_price: null, competition: b.model === "hgb" ? null : b.competition }) }
    ],
    ["explore", "/performance/explore?window=all", {}],
    ["explore-custom", "/performance/explore?window=custom&from=2026-10-03&to=2026-10-05&edge_min=2.5&price_max=3", {}],
    ["model", "/models/logistic?window=all", {}]
  ];

  for (const locale of ["en", "cs"] as const) {
    for (const [name, path, opts] of SHOTS) {
      test(`${locale} ${name}`, async ({ page }, info) => {
        const mobile = info.project.name === "mobile";
        await stubPerformance(page, opts);
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        await page.goto(`/${locale}${path}`);
        await expect(page.locator("tbody tr:visible").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: `${SHOTS_DIR}/${name}-${locale}-${mobile ? "390" : "1440"}.png`,
          fullPage: true
        });
      });
    }
  }
});
