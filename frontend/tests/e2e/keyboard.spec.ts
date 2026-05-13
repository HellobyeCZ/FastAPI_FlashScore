import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/db-stats", (route) =>
    route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } })
  );
  await page.route("**/api/today", (route) =>
    route.fulfill({ json: { openPicks: [], settledPicks: [], runningJobs: [] } })
  );
});

test("? opens keyboard sheet and esc closes it", async ({ page }) => {
  await page.goto("/en/today");
  await page.keyboard.press("Shift+Slash");
  await expect(page.getByText(/Keyboard/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Show keyboard/i)).toBeHidden();
});

test("g t navigates to today", async ({ page }) => {
  await page.goto("/en/odds");
  await page.locator("body").click();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/en\/today$/);
});
