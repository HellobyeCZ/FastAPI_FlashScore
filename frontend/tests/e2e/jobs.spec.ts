import { test, expect } from "@playwright/test";

test("jobs page lists jobs and shows a start button", async ({ page }) => {
  await page.route("**/api/db-stats", (route) =>
    route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } })
  );
  await page.route("**/api/bulk-scrape/jobs*", (route) => {
    if (route.request().method() === "POST") {
      route.fulfill({ json: { id: "abc" } });
    } else {
      route.fulfill({
        json: [
          {
            id: "j1",
            competition_path: "football/x/y",
            status: "running",
            progress: 0.4
          }
        ]
      });
    }
  });

  await page.goto("/en/jobs");
  await expect(page.getByText("Jobs · bulk scrape")).toBeVisible();
  await expect(page.getByPlaceholder(/football\//i)).toBeVisible();
  await expect(page.getByRole("button", { name: /start/i })).toBeVisible();
});
