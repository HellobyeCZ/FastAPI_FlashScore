import { test, expect } from "@playwright/test";

test.describe("Today page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/db-stats", (route) =>
      route.fulfill({ json: { ok: true, rows: 100, odds: 50, stats: 50 } })
    );
  });

  test("renders hero strip with three stat cells", async ({ page }) => {
    await page.route("**/api/today", (route) =>
      route.fulfill({ json: { openPicks: [], settledPicks: [], runningJobs: [] } })
    );

    await page.goto("/en/today");
    await expect(page.getByText("Today · Cockpit")).toBeVisible();
    await expect(page.getByText(/Model P&L · trailing 30d/i)).toBeVisible();
    await expect(page.getByText(/Today · open picks/i)).toBeVisible();
    await expect(page.getByText(/Scrape queue/i)).toBeVisible();
  });

  test("edge filter chip narrows the slate", async ({ page }) => {
    await page.route("**/api/today", (route) =>
      route.fulfill({
        json: {
          openPicks: [
            {
              id: "1",
              kickoff: "2026-05-12T14:00:00Z",
              league: "X",
              homeTeam: "A",
              awayTeam: "B",
              market: "1X2",
              pick: "1",
              odds: 1.9,
              edge: 0.005,
              model: "m",
              status: "OPEN"
            },
            {
              id: "2",
              kickoff: "2026-05-12T15:00:00Z",
              league: "Y",
              homeTeam: "C",
              awayTeam: "D",
              market: "1X2",
              pick: "1",
              odds: 2.1,
              edge: 0.06,
              model: "m",
              status: "OPEN"
            }
          ],
          settledPicks: [],
          runningJobs: []
        }
      })
    );

    await page.goto("/en/today");
    // Wait for the slate to populate (mock returns 2 picks).
    await expect(page.getByText("A", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("C", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: /≥5%/ }).click();
    // After filtering, the low-edge pick (A vs B, edge=0.5%) should be gone.
    await expect(page.locator("td").filter({ hasText: /^A$/ })).toHaveCount(0);
    await expect(page.locator("td").filter({ hasText: /C/ }).first()).toBeVisible();
  });
});
