import { expect, test } from "@playwright/test";

// Stats response shape: { group_by, filters, rows: StatsRow[] }
// StatsRow: { n, wins, hit_rate, stake_total, pnl_total, roi, mean_clv, brier, max_drawdown, ...dims }
const STATS_RESPONSE = {
  group_by: [] as string[],
  filters: {},
  rows: [
    {
      n: 42,
      wins: 21,
      hit_rate: 0.5,
      stake_total: 42,
      pnl_total: 12.34,
      roi: 0.08,
      mean_clv: 0.021,
      brier: 0.21,
      max_drawdown: -3.2
    }
  ]
};

const STATS_BY_MODEL_RESPONSE = {
  group_by: ["model"],
  filters: {},
  rows: [
    {
      model: "dixon_coles",
      n: 20,
      wins: 11,
      hit_rate: 0.55,
      stake_total: 20,
      pnl_total: 7.5,
      roi: 0.09,
      mean_clv: 0.03,
      brier: 0.2,
      max_drawdown: -1.5
    },
    {
      model: "elo",
      n: 22,
      wins: 10,
      hit_rate: 0.4545,
      stake_total: 22,
      pnl_total: 4.84,
      roi: 0.07,
      mean_clv: 0.012,
      brier: 0.22,
      max_drawdown: -2
    }
  ]
};

// Calibration response: { model, n_buckets, buckets: [{lower,upper,n,mean_pred,hit_rate}] }
const CALIBRATION_RESPONSE = {
  model: "dixon_coles",
  n_buckets: 5,
  buckets: [
    { lower: 0.0, upper: 0.2, n: 10, mean_pred: 0.1, hit_rate: 0.08 },
    { lower: 0.2, upper: 0.4, n: 15, mean_pred: 0.3, hit_rate: 0.28 },
    { lower: 0.4, upper: 0.6, n: 20, mean_pred: 0.5, hit_rate: 0.52 },
    { lower: 0.6, upper: 0.8, n: 12, mean_pred: 0.7, hit_rate: 0.71 },
    { lower: 0.8, upper: 1.0, n: 5, mean_pred: 0.9, hit_rate: 0.88 }
  ]
};

// History response: { count, rows: HistoryRow[] }
const HISTORY_RESPONSE = {
  count: 2,
  rows: [
    {
      id: 1,
      event_id: "evt1",
      model: "dixon_coles",
      market: "1x2",
      selection: "home",
      recommended_at: "2026-05-10T12:00:00Z",
      bet_ts: "2026-05-10T12:00:00Z",
      price_at_recommendation: 2.1,
      closing_price: 2.0,
      model_prob: 0.55,
      devigged_prob: 0.5,
      edge: 0.05,
      kelly_full: 0.04,
      result: 1,
      pnl: 1.1,
      clv: 0.04,
      status: "settled"
    },
    {
      id: 2,
      event_id: "evt2",
      model: "elo",
      market: "1x2",
      selection: "away",
      recommended_at: "2026-05-09T15:00:00Z",
      bet_ts: "2026-05-09T15:00:00Z",
      price_at_recommendation: 3.2,
      closing_price: 3.4,
      model_prob: 0.35,
      devigged_prob: 0.3,
      edge: -0.02,
      kelly_full: 0,
      result: 0,
      pnl: -1,
      clv: -0.01,
      status: "settled"
    }
  ]
};

test.describe("picks dashboard", () => {
  test.beforeEach(async ({ page }) => {
    // Calibration must be registered first because /api/picks/stats/calibration
    // would also match /api/picks/stats*.
    await page.route("**/api/picks/stats/calibration*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(CALIBRATION_RESPONSE),
        headers: { "content-type": "application/json" }
      });
    });
    await page.route("**/api/picks/stats*", async (route) => {
      const url = route.request().url();
      const body = url.includes("group_by=") ? STATS_BY_MODEL_RESPONSE : STATS_RESPONSE;
      await route.fulfill({
        status: 200,
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      });
    });
    await page.route("**/api/picks/history*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(HISTORY_RESPONSE),
        headers: { "content-type": "application/json" }
      });
    });
    await page.route("**/api/picks/summary*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" }
      });
    });
  });

  test("Health tab renders KPIs and per-model snapshot", async ({ page }) => {
    await page.goto("/en/picks?tab=health");
    await expect(page.getByText("Paper Trade Picks")).toBeVisible();
    await expect(page.getByText("7-day hit rate")).toBeVisible();
    await expect(page.getByText("dixon_coles").first()).toBeVisible();
  });

  test("Tab links update the URL", async ({ page }) => {
    await page.goto("/en/picks?tab=health");
    await page.getByRole("link", { name: "Models" }).click();
    await expect(page).toHaveURL(/tab=models/);
  });

  test("Filter selection updates URL on Models tab", async ({ page }) => {
    await page.goto("/en/picks?tab=models");
    await page.getByLabel("Date").selectOption("30d");
    await expect(page).toHaveURL(/date=30d/);
  });

  test("Model deep-dive page renders calibration section", async ({ page }) => {
    await page.goto("/en/picks/model/dixon_coles");
    await expect(page.getByText("Calibration plot")).toBeVisible();
  });
});
