import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import type { TodayResponse } from "../../src/components/today/types";
import { OPS_STATUS_OK, OPS_STATUS_STALE, stubJson, stubShell } from "./fixtures/stub";

// Every relative time, KPI tone and the viewer's local day hang off "now", so
// the clock and zone are pinned: 12:00 UTC = 14:00 in Prague, matching the
// generated_at of OPS_STATUS_OK.
const NOW = "2026-10-11T12:00:00.000Z";
const WINDOW = { today_start: "2026-10-10T22:00:00.000Z", today_end: "2026-10-11T22:00:00.000Z", tz: "Europe/Prague" };
const TODAY_API = /\/api\/today(\?|$)/;

test.use({ timezoneId: "Europe/Prague" });

type Pick = {
  id: number;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  price: number;
  edge: number | null;
  state: "open" | "pending" | "won" | "lost" | "void";
  recommended_at: string;
  kickoff: string | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  country: string | null;
};

function pick(
  id: number,
  event_id: string,
  [home_team, away_team]: [string, string],
  competition: string,
  kickoff: string,
  market: string,
  selection: string,
  price: number,
  edge: number | null,
  model: string,
  state: Pick["state"]
): Pick {
  return {
    id,
    event_id,
    model,
    market,
    selection,
    price,
    edge,
    state,
    recommended_at: "2026-10-11T06:00:00.000Z",
    kickoff,
    home_team,
    away_team,
    competition,
    country: null
  };
}

// Today in Prague: four open picks, one settled earlier today, one kicked off.
const SLATE: Pick[] = [
  pick(105, "Hk5Lb3eq", ["Hradec Kralove", "Liberec"], "Chance Liga - Championship Group", "2026-10-11T08:00:00.000Z", "1X2_FT", "away", 3.1, 0.071, "logistic", "won"),
  pick(106, "Pz7Wn4kd", ["Plzen", "Ostrava"], "Chance Liga", "2026-10-11T11:00:00.000Z", "1X2_FT", "home", 1.95, 0.026, "dixon_coles", "pending"),
  pick(101, "Kp3xQw1a", ["Slavia Prague", "Sparta Prague"], "Chance Liga", "2026-10-11T16:00:00.000Z", "1X2_FT", "home", 2.15, 0.062, "logistic", "open"),
  pick(103, "Bm4Dt7xq", ["Bayern Munich", "Borussia Dortmund"], "Bundesliga", "2026-10-11T16:30:00.000Z", "OVER_UNDER_2.5_FT", "over", 1.72, 0.018, "hgb", "open"),
  pick(102, "Lv8Ar2sn", ["Liverpool", "Arsenal"], "Premier League", "2026-10-11T18:30:00.000Z", "1X2_FT", "draw", 3.6, 0.034, "dixon_coles", "open"),
  pick(104, "Ny2Ra9pl", ["Real Madrid", "Atl. Madrid"], "LaLiga", "2026-10-11T19:00:00.000Z", "BTTS_FT", "yes", 1.85, 0.008, "logistic", "open")
];

const LATER: Pick[] = [
  pick(107, "Mc1Cp6ts", ["Manchester City", "Crystal Palace"], "Premier League", "2026-10-12T14:00:00.000Z", "1X2_FT", "home", 1.4, 0.021, "hgb", "open"),
  pick(108, "Ib3Sv9fa", ["Inter", "Napoli"], "Serie A", "2026-10-13T18:45:00.000Z", "OVER_UNDER_2.5_FT", "under", 2.05, 0.044, "logistic", "open")
];

function settled(p: Pick, result: number | null, pnl: number | null, settled_at: string) {
  const state = result === null ? "void" : result >= 1 ? "won" : "lost";
  return { ...p, state, result, pnl, settled_at };
}

const RECENT = [
  settled(SLATE[0], 1, 0.284, "2026-10-11T09:00:00.000Z"),
  settled(pick(91, "Sl2Jb7cv", ["Slavia Prague", "Jablonec"], "Chance Liga", "2026-10-10T18:00:00.000Z", "1X2_FT", "draw", 4.56, 0.051, "dixon_coles", "lost"), 0, -0.049, "2026-10-10T21:40:00.000Z"),
  settled(pick(92, "Sl2Jb7cv", ["Slavia Prague", "Jablonec"], "Chance Liga", "2026-10-10T18:00:00.000Z", "1X2_FT", "home", 1.62, 0.033, "logistic", "won"), 1, 0.041, "2026-10-10T21:40:00.000Z"),
  settled(pick(93, "Ac4Mi1lr", ["AC Milan", "Lazio"], "Serie A", "2026-10-10T16:00:00.000Z", "BTTS_FT", "yes", 1.8, 0.022, "hgb", "lost"), 0, -0.032, "2026-10-10T19:10:00.000Z"),
  settled(pick(94, "Ps6Ly2om", ["PSG", "Lyon"], "Ligue 1", "2026-10-09T19:00:00.000Z", "OVER_UNDER_2.5_FT", "over", 1.55, 0.019, "logistic", "won"), 1, 0.021, "2026-10-09T22:30:00.000Z"),
  settled(pick(95, "Aj9Fe3yn", ["Ajax", "Feyenoord"], "Eredivisie", "2026-10-09T16:45:00.000Z", "1X2_FT", "away", 3.9, 0.064, "dixon_coles", "void"), null, null, "2026-10-09T20:00:00.000Z"),
  settled(pick(96, "Bn1Wb8rk", ["Benfica", "Braga"], "Liga Portugal", "2026-10-08T19:15:00.000Z", "1X2_FT", "home", 1.7, 0.027, "logistic", "lost"), 0, -0.041, "2026-10-08T22:00:00.000Z"),
  settled(pick(97, "Cl3Rn5gs", ["Celtic", "Rangers"], "Premiership", "2026-10-08T11:30:00.000Z", "BTTS_FT", "yes", 1.66, 0.015, "hgb", "won"), 1, 0.012, "2026-10-08T14:00:00.000Z"),
  settled(pick(98, "Gl7Fb2tz", ["Galatasaray", "Fenerbahce"], "Super Lig", "2026-10-07T17:00:00.000Z", "1X2_FT", "draw", 3.45, 0.038, "dixon_coles", "lost"), 0, -0.036, "2026-10-07T19:30:00.000Z"),
  settled(pick(99, "Ol5Bz8qw", ["Olympiacos", "PAOK"], "Super League", "2026-10-06T18:30:00.000Z", "OVER_UNDER_2.5_FT", "under", 1.9, 0.024, "logistic", "won"), 1, 0.023, "2026-10-06T21:00:00.000Z")
];

const PNL_STEPS = [0.21, -0.05, 0.12, 0.3, -0.18, 0.07, 0.41, -0.09, 0.26, 0.33, 0.12, 0.34];
const PNL_SERIES = PNL_STEPS.map((_, i) => ({
  settled_at: new Date(Date.parse("2026-09-14T21:00:00Z") + i * 2.2 * 86_400_000).toISOString(),
  cum_pnl: Number(PNL_STEPS.slice(0, i + 1).reduce((a, b) => a + b, 0).toFixed(3))
}));

const TODAY_HEALTHY = {
  generated_at: NOW,
  window: WINDOW,
  slate: SLATE,
  upcoming72h: [...SLATE.filter((p) => p.state === "open"), ...LATER],
  open72h: { count: 6, today_count: 4 },
  pnl30d: { n: PNL_SERIES.length, pnl: PNL_SERIES[PNL_SERIES.length - 1].cum_pnl, series: PNL_SERIES },
  last_settled_at: "2026-10-11T09:00:00.000Z",
  pending: { count: 3, overdue_count: 2, unscheduled_count: 0, oldest_kickoff: "2026-10-10T15:00:00.000Z" },
  last_recommended_at: "2026-10-11T06:00:00.000Z",
  recent_settled: RECENT
};

// Mirrors OPS_STATUS_STALE and the real database during the 2026-10 audit:
// the pipeline last recorded picks in May, so nothing is on today's slate.
const TODAY_STALE = {
  generated_at: NOW,
  window: WINDOW,
  slate: [],
  upcoming72h: [],
  open72h: { count: 0, today_count: 0 },
  pnl30d: { n: 0, pnl: null, series: [] },
  last_settled_at: "2026-05-13T20:41:26.231Z",
  pending: { count: 18, overdue_count: 18, unscheduled_count: 0, oldest_kickoff: "2026-05-12T19:30:00.000Z" },
  last_recommended_at: "2026-05-12T06:23:24.032Z",
  recent_settled: RECENT.map((r) => ({ ...r, settled_at: "2026-05-13T20:41:26.231Z" }))
};

// The route's error bodies: generic English messages the page replaces with its own copy.
const TODAY_FAILED = {
  error: { code: "today_query_failed", message: "Today's data could not be loaded; see the server log" }
};
const TODAY_BUSY = { error: { code: "today_db_busy", message: "The database is busy; try again in a moment" } };

let unexpected: string[] = [];
let todayRequests: URL[] = [];

/**
 * Pins the clock, fails any un-stubbed /api call, then stubs the shell and
 * /api/today (recording each request so tests can check what was asked).
 */
async function setup(page: Page, { ops = OPS_STATUS_OK as unknown, today = TODAY_HEALTHY as unknown, status = 200 } = {}) {
  unexpected = [];
  todayRequests = [];
  await page.clock.setFixedTime(new Date(NOW));
  // Registered first so every specific stub below takes precedence over it.
  await page.route("**/api/**", (route) => {
    unexpected.push(route.request().url());
    return route.fulfill({ status: 599, contentType: "application/json", body: "{}" });
  });
  await stubShell(page, ops);
  await page.route(TODAY_API, (route) => {
    todayRequests.push(new URL(route.request().url()));
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(today) });
  });
}

test.afterEach(() => {
  expect(unexpected, "un-stubbed API requests").toEqual([]);
});

const kpis = (page: Page, name = "Key figures") => page.getByRole("region", { name });
const slate = (page: Page, name: string | RegExp = "Today's slate") => page.getByRole("region", { name });
const slateRows = (page: Page, name?: string) => slate(page, name).locator("tbody tr");

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe("Today cockpit", () => {
  test("healthy day: KPIs, slate with team links, edge filter in the URL", async ({ page }) => {
    await setup(page);
    await page.goto("/en/today");

    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByText("as of 02:00 PM")).toBeVisible();
    // The local-day window is computed for the zone the browser reports.
    expect(todayRequests.length).toBeGreaterThan(0);
    for (const url of todayRequests) expect(url.searchParams.get("tz")).toBe("Europe/Prague");
    // Healthy ops status: no full banner.
    await expect(page.getByText("System status")).toHaveCount(0);

    // KPI strip: real windows, n flagged when small, pipeline freshness.
    await expect(page.getByText("P&L · last 30 days")).toBeVisible();
    await expect(page.getByText("+1.84u")).toBeVisible();
    await expect(page.getByText("Small sample (n = 12) — treat as noise")).toBeVisible();
    await expect(page.getByRole("img", { name: "Cumulative P&L of 12 bets settled in the last 30 days" })).toBeVisible();
    await expect(page.getByText("4 kick off today")).toBeVisible();
    await expect(page.getByText(/^2 overdue \(kick-off over 6\sh ago\) · oldest 21 hours ago$/)).toBeVisible();
    await expect(page.getByText("6 hours ago", { exact: true })).toBeVisible();

    // Slate: all six of today's picks, team names linking to the match page.
    await expect(slate(page)).toContainText("Kick-offs on Oct 11, 2026, local time (Europe/Prague)");
    await expect(slateRows(page)).toHaveCount(6);
    const match = slate(page).getByRole("link", { name: /Slavia Prague – Sparta Prague/ });
    await expect(match).toHaveAttribute("href", "/en/matches/Kp3xQw1a");
    await expect(slate(page)).not.toContainText("Kp3xQw1a");
    await expect(slate(page).getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");

    await slate(page).getByRole("radio", { name: "≥ 3%" }).click();
    await expect(page).toHaveURL(/[?&]edge=0\.03(&|$)/);
    await expect(slateRows(page)).toHaveCount(3);
    await expect(slate(page)).toContainText("3 picks · 3 hidden by the edge filter");
    await expect(slate(page)).not.toContainText("Bayern Munich");

    await slate(page).getByRole("radio", { name: "≥ 5%" }).click();
    await expect(page).toHaveURL(/[?&]edge=0\.05(&|$)/);
    await expect(slateRows(page)).toHaveCount(2);

    await slate(page).getByRole("radio", { name: "All" }).click();
    await expect(page).toHaveURL(/[?&]edge=0(&|$)/);
    await expect(slateRows(page)).toHaveCount(6);

    // Recent settled: names, model + market, age and a link to Performance.
    const recent = page.getByRole("region", { name: "Last 10 settled" });
    await expect(recent.locator("tbody tr")).toHaveCount(10);
    await expect(recent.getByRole("link", { name: /Hradec Kralove – Liberec/ })).toHaveAttribute(
      "href",
      "/en/matches/Hk5Lb3eq"
    );
    await expect(recent.getByRole("link", { name: "All results" })).toHaveAttribute("href", "/en/performance");

    // Served models from /ops/status.
    const models = page.getByRole("region", { name: "Served models" });
    await expect(models).toContainText("Registry · v3");
    await expect(models).toContainText("File");
    await expect(models).toContainText("Not loaded");
    await expect(models.getByRole("link", { name: "Open registry" })).toHaveAttribute("href", "/en/lab/registry");
  });

  test("edge threshold that hides every pick says how many and offers to show all", async ({ page }) => {
    await setup(page, { today: { ...TODAY_HEALTHY, slate: SLATE.filter((p) => (p.edge ?? 0) < 0.05) } });
    await page.goto("/en/today?edge=0.05");

    await expect(slate(page)).toContainText("No picks with edge ≥ 5%");
    await expect(slate(page)).toContainText("4 picks in this window are below the threshold.");
    // Still today's window: the filter never triggers the 72 h fallback.
    await expect(slate(page)).toContainText("Kick-offs on Oct 11, 2026");

    await slate(page).getByRole("button", { name: "Show all picks" }).click();
    await expect(page).toHaveURL(/[?&]edge=0(&|$)/);
    await expect(slateRows(page)).toHaveCount(4);
  });

  test("the saved minimum edge applies when the URL has none", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "terminal.settings.v2",
        JSON.stringify({ scanlines: false, dense: false, minEdge: 0.03 })
      );
    });
    await setup(page);
    await page.goto("/en/today");

    await expect(slate(page).getByRole("radio", { name: "≥ 3%" })).toHaveAttribute("aria-checked", "true");
    await expect(slateRows(page)).toHaveCount(3);
  });

  test("nothing today falls back to the next 72 hours and says so", async ({ page }) => {
    await setup(page, {
      today: { ...TODAY_HEALTHY, slate: [], upcoming72h: LATER, open72h: { count: 2, today_count: 0 } }
    });
    await page.goto("/en/today");

    const panel = slate(page, "Next 72 hours");
    await expect(panel).toContainText("No picks kick off today — open picks until");
    await expect(panel.locator("tbody tr")).toHaveCount(2);
    await expect(panel.getByRole("link", { name: /Inter – Napoli/ })).toHaveAttribute("href", "/en/matches/Ib3Sv9fa");
    await expect(panel).toContainText("Oct 13, 2026");
  });

  test("fresh pipeline with nothing to bet says so instead of blaming staleness", async ({ page }) => {
    await setup(page, {
      today: { ...TODAY_HEALTHY, slate: [], upcoming72h: [], open72h: { count: 0, today_count: 0 } }
    });
    await page.goto("/en/today");

    await expect(slate(page)).toContainText("No picks today or in the next 72 hours");
    await expect(slate(page)).toContainText("The pipeline last ran 6 hours ago and found nothing worth a pick.");
    await expect(slate(page).getByRole("link", { name: "Browse matches" })).toHaveAttribute("href", "/en/matches");
    await expect(slate(page)).not.toContainText("stale");
  });

  test("stale pipeline: full banner and an empty slate that explains why", async ({ page }) => {
    await setup(page, { ops: OPS_STATUS_STALE, today: TODAY_STALE });
    await page.goto("/en/today");

    const banner = page.getByRole("status").filter({ hasText: "System status" });
    await expect(banner).toContainText("Picks pipeline last ran 5 months ago");
    await expect(banner).toContainText("18 bets still unsettled");
    await expect(banner.getByRole("link", { name: "Open Data ops" })).toHaveAttribute("href", "/en/ops");

    await expect(slate(page)).toContainText("No current picks — the pipeline is stale");
    await expect(slate(page)).toContainText("Picks were last recorded 5 months ago");
    await expect(slate(page).getByRole("link", { name: "Open Data ops" })).toHaveAttribute("href", "/en/ops");
    await expect(slate(page).locator("table")).toHaveCount(0);

    await expect(page.getByText("No settled bets in 30 days — last settled 5 months ago")).toBeVisible();
    await expect(page.getByText(/^18 overdue \(kick-off over 6\sh ago\) · oldest 5 months ago$/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Last 10 settled" })).toContainText("Latest settled 5 months ago");
  });

  test("/api/today failing keeps the chrome, dashes the KPIs and offers a retry", async ({ page }) => {
    await setup(page, { today: TODAY_FAILED, status: 500 });
    await page.goto("/en/today");

    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    // Shell chrome (the rail collapses into a menu on phones; the top bar stays).
    await expect(page.getByRole("group", { name: "Language" })).toBeVisible();

    await expect(slate(page)).toContainText("Couldn't load today's picks");
    await expect(slate(page)).toContainText("The database query failed; the server log has the details.");
    await expect(slate(page)).not.toContainText("see the server log");
    await expect(page.getByRole("region", { name: "Last 10 settled" })).toContainText("Couldn't load settled bets");
    // Every KPI keeps its tile, with a dash for the value and the reason under it.
    await expect(kpis(page).getByText("Couldn't load", { exact: true })).toHaveCount(4);
    await expect(kpis(page).getByText("—", { exact: true })).toHaveCount(4);
    await expect(kpis(page)).toContainText("P&L · last 30 days");

    // Served models come from /ops/status and are unaffected.
    await expect(page.getByRole("region", { name: "Served models" })).toContainText("Registry · v3");

    await stubJson(page, TODAY_API, TODAY_HEALTHY);
    await slate(page).getByRole("button", { name: "Retry" }).click();
    await expect(slateRows(page)).toHaveCount(6);
    await expect(page.getByText("Couldn't load", { exact: true })).toHaveCount(0);
    await expect(kpis(page).getByText("—", { exact: true })).toHaveCount(0);
  });

  test("a busy database is explained in the viewer's language", async ({ page }) => {
    await setup(page, { today: TODAY_BUSY, status: 503 });
    await page.goto("/cs/today");

    const panel = slate(page, "Dnešní tipy");
    await expect(panel).toContainText("Dnešní tipy se nepodařilo načíst");
    await expect(panel).toContainText("Databáze je zaneprázdněná (zapisuje do ní jiná úloha).");
    await expect(panel).not.toContainText("The database is busy");
    await expect(kpis(page, "Klíčové ukazatele").getByText("Nepodařilo se načíst", { exact: true })).toHaveCount(4);
    await expect(panel.getByRole("button", { name: "Zkusit znovu" })).toBeVisible();
  });

  test("a sample of 30 or more shows n without the small-sample caution", async ({ page }) => {
    const steps = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? -0.04 : 0.05));
    const series = steps.map((_, i) => ({
      settled_at: new Date(Date.parse("2026-09-12T21:00:00Z") + i * 86_400_000).toISOString(),
      cum_pnl: Number(steps.slice(0, i + 1).reduce((a, b) => a + b, 0).toFixed(3))
    }));
    await setup(page, {
      today: { ...TODAY_HEALTHY, pnl30d: { n: 30, pnl: series[29].cum_pnl, series } }
    });
    await page.goto("/en/today");

    await expect(kpis(page).getByText("+0.60u", { exact: true })).toBeVisible();
    await expect(kpis(page).getByText("n = 30", { exact: true })).toBeVisible();
    await expect(kpis(page)).not.toContainText("Small sample");
    await expect(
      kpis(page).getByRole("img", { name: "Cumulative P&L of 30 bets settled in the last 30 days" })
    ).toBeVisible();
  });

  test("a pick whose event has no stored teams falls back to its event id", async ({ page }) => {
    const nameless = { ...SLATE[2], id: 109, event_id: "Xq8Zt1vm", home_team: null, away_team: null };
    await setup(page, { today: { ...TODAY_HEALTHY, slate: [...SLATE, nameless] } });
    await page.goto("/en/today");

    await expect(slateRows(page)).toHaveCount(7);
    await expect(slate(page).getByRole("link", { name: /Xq8Zt1vm/ })).toHaveAttribute("href", "/en/matches/Xq8Zt1vm");
  });

  test("Czech locale renders translated headings", async ({ page }) => {
    await setup(page);
    await page.goto("/cs/today");

    await expect(page.locator("html")).toHaveAttribute("lang", "cs");
    await expect(page.getByRole("heading", { level: 1, name: "Dnes" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dnešní tipy" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Posledních 10 vypořádaných" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Nasazené modely" })).toBeVisible();
    await expect(page.getByText("Zisk/ztráta · posledních 30 dní")).toBeVisible();
    await expect(page.getByText("Čeká na vypořádání")).toBeVisible();
    await expect(page.getByText("4 tipy začínají dnes")).toBeVisible();
    await expect(page.getByRole("region", { name: "Dnešní tipy" }).getByRole("radio", { name: "Vše" })).toBeVisible();
  });

  for (const [name, today, ops, locale] of [
    ["healthy", TODAY_HEALTHY, OPS_STATUS_OK, "en"],
    ["stale", TODAY_STALE, OPS_STATUS_STALE, "en"],
    ["healthy (cs)", TODAY_HEALTHY, OPS_STATUS_OK, "cs"]
  ] as const) {
    test(`no horizontal overflow at 390 px: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await setup(page, { today, ops });
      await page.goto(`/${locale}/today`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("region", { name: locale === "cs" ? "Nasazené modely" : "Served models" })).toBeVisible();
      if (today === TODAY_HEALTHY) {
        const first = slateRows(page, locale === "cs" ? "Dnešní tipy" : "Today's slate").first();
        await expect(first).toBeVisible();
        if (locale === "en") {
          // The status and model columns are hidden at this width; both fold
          // into visible cells (innerText skips display: none).
          await expect(first).toContainText("Hradec Kralove", { useInnerText: true });
          await expect(first).toContainText(/\bwon\b/i, { useInnerText: true });
          await expect(first).toContainText("Logistic", { useInnerText: true });
        }
      }
      await expectNoHorizontalOverflow(page);
    });
  }
});

// ---------------------------------------------------------------------------
// The route itself, run in the test process against a small seeded SQLite
// file (no browser, no dev server): local-day and 72 h windows, the kick-off
// and team-name fallback order, null handling and the error mapping.

type RouteContext = {
  GET: typeof import("../../src/app/api/today/route").GET;
  prisma: typeof import("../../src/server/prisma").prisma;
  dbUrl: string;
  dir: string;
  seededAt: number;
  kickoffs: Map<number, number>;
};

let routeContext: Promise<RouteContext> | undefined;

const HOUR = 3_600_000;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The Python writers' shape: "+00:00" with microseconds. */
const pyIso = (ms: number) => new Date(ms).toISOString().replace("Z", "123+00:00");
const jsIso = (ms: number) => new Date(ms).toISOString();

/** Seeds a fresh database once per worker; the route's Prisma client binds to it on first import. */
function seededRoute(): Promise<RouteContext> {
  routeContext ??= (async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "today-route-"));
    const dbUrl = `file:${path.join(dir, "today.sqlite3")}`;
    process.env.DATABASE_URL = dbUrl;
    // Loaded only now that DATABASE_URL points at the seeded file, and through
    // require(), which Playwright transpiles (a dynamic import() of TS isn't).
    const { prisma } = require("../../src/server/prisma") as typeof import("../../src/server/prisma");
    const { GET } = require("../../src/app/api/today/route") as typeof import("../../src/app/api/today/route");

    // Only the columns the route reads (paper_bets as app/ml/paper_trade.py creates it).
    for (const ddl of [
      `CREATE TABLE paper_bets (
         id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, model TEXT NOT NULL,
         market TEXT NOT NULL, selection TEXT NOT NULL, recommended_at TEXT NOT NULL,
         price_at_recommendation REAL NOT NULL, edge REAL, result REAL, pnl REAL,
         status TEXT NOT NULL DEFAULT 'pending', settled_at TEXT)`,
      `CREATE TABLE match_event_summaries (
         event_id TEXT PRIMARY KEY, home_team TEXT, away_team TEXT, country TEXT, competition TEXT,
         start_time_utc TEXT)`,
      `CREATE TABLE bet_labels (
         event_id TEXT PRIMARY KEY, home_team TEXT, away_team TEXT, country TEXT, competition TEXT,
         start_time_utc TEXT)`,
      `CREATE TABLE upcoming_fixtures (
         event_id TEXT PRIMARY KEY, home_team_raw TEXT, away_team_raw TEXT, country TEXT, competition TEXT,
         start_time_utc TEXT NOT NULL)`
    ]) {
      await prisma.$executeRawUnsafe(ddl);
    }

    const now = Date.now();
    const kickoffs = new Map<number, number>([
      [1, now + 2 * HOUR], // open, summary + fixture rows
      [2, now + 30 * HOUR], // open, fixture row only
      [3, now - 50 * HOUR], // settled (won), label + fixture rows
      [4, now - 41 * 24 * HOUR], // settled (lost) outside the 30-day window
      [5, now - 26 * HOUR], // voided
      [6, now - 7 * HOUR], // pending, overdue
      [7, now - 1 * HOUR] // pending, not yet overdue
    ]);
    const k = (id: number) => kickoffs.get(id)!;
    const bets: [number, string, string, string, number | null, number | null, number | null, string | null][] = [
      // id, event, status, selection, edge, result, pnl, settled_at
      [1, "EvMes001", "pending", "home", 0.05, null, null, null],
      [2, "EvFix002", "pending", "home", 0.02, null, null, null],
      [3, "EvLbl003", "settled", "away", 0.04, 1, 0.9, jsIso(now - 48 * HOUR)],
      [4, "EvOld004", "settled", "draw", 0.03, 0, -1, pyIso(now - 40 * 24 * HOUR)],
      [5, "EvVoid05", "voided", "home", 0.01, null, null, pyIso(now - 24 * HOUR)],
      [6, "EvOver06", "pending", "over", null, null, null, null],
      [7, "EvLate07", "pending", "under", 0.03, null, null, null],
      [8, "EvNone08", "pending", "yes", 0.02, null, null, null] // no fixture data at all
    ];
    for (const [id, event, status, selection, edge, result, pnl, settledAt] of bets) {
      await prisma.$executeRaw`
        INSERT INTO paper_bets (id, event_id, model, market, selection, recommended_at,
          price_at_recommendation, edge, result, pnl, status, settled_at)
        VALUES (${id}, ${event}, 'logistic', '1X2_FT', ${selection}, ${pyIso(now - (60 - id) * HOUR)},
          2.0, ${edge}, ${result}, ${pnl}, ${status}, ${settledAt})`;
    }
    // Summaries and labels carry the real orientation; upcoming_fixtures
    // stores it reversed (see the route), so its rows here are crossed.
    for (const [event, id, home, away] of [
      ["EvMes001", 1, "Slavia Prague", "Sparta Prague"],
      ["EvOver06", 6, "Plzen", "Ostrava"],
      ["EvVoid05", 5, "Ajax", "Feyenoord"],
      ["EvOld004", 4, "Benfica", "Braga"]
    ] as const) {
      await prisma.$executeRaw`
        INSERT INTO match_event_summaries (event_id, home_team, away_team, country, competition, start_time_utc)
        VALUES (${event}, ${home}, ${away}, 'CZECH REPUBLIC', 'Chance Liga', ${pyIso(k(id))})`;
    }
    await prisma.$executeRaw`
      INSERT INTO bet_labels (event_id, home_team, away_team, country, competition, start_time_utc)
      VALUES ('EvLbl003', 'Hradec Kralove', 'Liberec', 'CZECH REPUBLIC', 'Chance Liga', ${jsIso(k(3))})`;
    for (const [event, id, homeRaw, awayRaw] of [
      ["EvMes001", 1, "Sparta Prague", "Slavia Prague"],
      ["EvFix002", 2, "Arsenal", "Liverpool"],
      ["EvLbl003", 3, "Liberec", "Hradec Kralove"],
      ["EvLate07", 7, "Napoli", "Inter"]
    ] as const) {
      await prisma.$executeRaw`
        INSERT INTO upcoming_fixtures (event_id, home_team_raw, away_team_raw, country, competition, start_time_utc)
        VALUES (${event}, ${homeRaw}, ${awayRaw}, 'england', 'Premier League', ${jsIso(k(id))})`;
    }
    return { GET, prisma, dbUrl, dir, seededAt: now, kickoffs };
  })();
  return routeContext;
}

async function callRoute(ctx: RouteContext, tz: string) {
  const res = await ctx.GET(new NextRequest(`http://localhost/api/today?tz=${encodeURIComponent(tz)}`));
  return { status: res.status, body: await res.json() };
}

test.describe("GET /api/today (seeded database)", () => {
  // Browser-independent: run once, on the desktop chromium project, in one worker.
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "runs once, on chromium");

  test.afterAll(async () => {
    if (!routeContext) return;
    const ctx = await routeContext;
    await ctx.prisma.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("windows, fallback order and counts", async () => {
    const ctx = await seededRoute();
    const { status, body } = await callRoute(ctx, "Europe/Prague");
    expect(status).toBe(200);
    const res = body as TodayResponse;

    // The local day is a Prague calendar day that contains "now".
    const { today_start, today_end, tz } = res.window;
    expect(tz).toBe("Europe/Prague");
    const prague = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit"
    });
    expect(prague.format(new Date(today_start))).toBe("00:00");
    expect(prague.format(new Date(today_end))).toBe("00:00");
    const length = Date.parse(today_end) - Date.parse(today_start);
    expect([23 * HOUR, 24 * HOUR, 25 * HOUR]).toContain(length);
    expect(Date.parse(today_start)).toBeLessThanOrEqual(Date.parse(res.generated_at));
    expect(Date.parse(today_end)).toBeGreaterThan(Date.parse(res.generated_at));

    const inDay = (ms: number) => ms >= Date.parse(today_start) && ms < Date.parse(today_end);
    const byKickoff = (a: number, b: number) => ctx.kickoffs.get(a)! - ctx.kickoffs.get(b)!;
    expect(res.slate.map((p) => p.id)).toEqual([...ctx.kickoffs.keys()].filter((id) => inDay(ctx.kickoffs.get(id)!)).sort(byKickoff));
    expect(res.upcoming72h.map((p) => p.id)).toEqual([1, 2]);
    expect(res.open72h).toEqual({
      count: 2,
      today_count: [1, 2].filter((id) => ctx.kickoffs.get(id)! < Date.parse(today_end)).length
    });

    // Names: summary, then label, then the fixture row read crossed.
    const upcoming = new Map(res.upcoming72h.map((p) => [p.id, p]));
    expect(upcoming.get(1)).toMatchObject({ home_team: "Slavia Prague", away_team: "Sparta Prague", state: "open" });
    expect(upcoming.get(2)).toMatchObject({ home_team: "Liverpool", away_team: "Arsenal", competition: "Premier League" });
    for (const p of [...res.slate, ...res.upcoming72h]) expect(p.kickoff).toMatch(ISO_MS);
    expect(Date.parse(upcoming.get(1)!.kickoff!)).toBe(ctx.kickoffs.get(1));

    // Pending: kicked off, unsettled; overdue after 6 h; no kick-off counted apart.
    expect(res.pending).toEqual({
      count: 2,
      overdue_count: 1,
      unscheduled_count: 1,
      oldest_kickoff: jsIso(ctx.kickoffs.get(6)!)
    });

    // P&L: settled in the last 30 days only; voided bets never count.
    expect(res.pnl30d).toEqual({ n: 1, pnl: 0.9, series: [{ settled_at: jsIso(ctx.seededAt - 48 * HOUR), cum_pnl: 0.9 }] });
    expect(res.last_settled_at).toBe(jsIso(ctx.seededAt - 48 * HOUR));
    expect(res.last_recommended_at).toBe(jsIso(ctx.seededAt - 52 * HOUR));

    // Recent: settled and voided, newest first, with names and nulls kept.
    expect(res.recent_settled.map((r) => [r.id, r.state, r.result, r.pnl])).toEqual([
      [5, "void", null, null],
      [3, "won", 1, 0.9],
      [4, "lost", 0, -1]
    ]);
    expect(res.recent_settled[1]).toMatchObject({ home_team: "Hradec Kralove", away_team: "Liberec" });
    expect(res.recent_settled[2].settled_at).toBe(jsIso(ctx.seededAt - 40 * 24 * HOUR));
  });

  test("zone fallbacks: a UTC offset in minutes, or UTC for anything unknown", async () => {
    const ctx = await seededRoute();
    expect((await callRoute(ctx, "-120")).body.window.tz).toBe("UTC+02:00");
    expect((await callRoute(ctx, "330")).body.window.tz).toBe("UTC−05:30");
    expect((await callRoute(ctx, "Mars/Olympus_Mons")).body.window.tz).toBe("UTC");
  });

  test("errors stay generic: a locked database is busy, anything else failed", async () => {
    const ctx = await seededRoute();
    // The route logs the driver error; capture it instead of printing it.
    const logged: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    const locker = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: ctx.dbUrl, timeout: 0 }) });
    try {
      // An exclusive lock on another connection blocks every reader until the
      // route's connection gives up (better-sqlite3's default busy timeout).
      await locker.$executeRawUnsafe("BEGIN EXCLUSIVE");
      const busy = await callRoute(ctx, "Europe/Prague");
      expect(busy.status).toBe(503);
      expect(busy.body).toEqual({
        error: { code: "today_db_busy", message: "The database is busy; try again in a moment" }
      });
      await locker.$executeRawUnsafe("ROLLBACK");

      await ctx.prisma.$executeRawUnsafe("DROP TABLE bet_labels");
      const failed = await callRoute(ctx, "Europe/Prague");
      expect(failed.status).toBe(500);
      // No SQL, table names or file paths reach the client; they stay in the log.
      expect(failed.body).toEqual({
        error: { code: "today_query_failed", message: "Today's data could not be loaded; see the server log" }
      });
      expect(String(logged.at(-1)?.[1])).toContain("no such table: bet_labels");
    } finally {
      console.error = consoleError;
      await locker.$disconnect();
    }
  });
});

// Visual review only: TODAY_SHOTS=<dir> npx playwright test today --project=chromium
test.describe("Today screenshots", () => {
  const dir = process.env.TODAY_SHOTS;
  test.skip(!dir, "set TODAY_SHOTS=<dir> to capture screenshots");

  const cases = [
    { name: "healthy", today: TODAY_HEALTHY, ops: OPS_STATUS_OK, status: 200 },
    { name: "stale", today: TODAY_STALE, ops: OPS_STATUS_STALE, status: 200 },
    { name: "error", today: TODAY_FAILED, ops: OPS_STATUS_OK, status: 500 }
  ];
  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ];

  for (const c of cases) {
    for (const vp of viewports) {
      for (const locale of ["en", "cs"] as const) {
        test(`${c.name} ${vp.name} ${locale}`, async ({ page }, info) => {
          test.skip(info.project.name !== "chromium", "captured once, on chromium");
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await setup(page, { today: c.today, ops: c.ops, status: c.status });
          await page.goto(`/${locale}/today`);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expect(page.locator("[aria-hidden].animate-pulse")).toHaveCount(0);
          await page.evaluate(() => document.fonts.ready);
          mkdirSync(dir!, { recursive: true });
          await page.screenshot({ path: path.join(dir!, `today-${c.name}-${vp.name}-${locale}.png`), fullPage: true });
        });
      }
    }
  }
});
