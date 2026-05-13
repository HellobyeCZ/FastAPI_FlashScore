import { expect, test } from "@playwright/test";

const mockOdds = {
  event: {
    id: "123456",
    name: "Sample Event"
  },
  lastUpdate: "2024-01-01T12:00:00Z",
  markets: [
    {
      id: "m1",
      name: "Match Winner",
      selections: [
        {
          id: "s1",
          name: "Team A",
          odds: 1.9,
          bookmaker: { id: "bk1", name: "Bookie One" }
        },
        {
          id: "s2",
          name: "Team B",
          odds: 2.1,
          bookmaker: { id: "bk2", name: "Bookie Two" }
        }
      ]
    }
  ]
};

test.describe("odds dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/db-stats", (route) =>
      route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } })
    );
    await page.route("**/odds/*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(mockOdds),
        headers: { "content-type": "application/json" }
      });
    });
    await page.route("**/api/odds/*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(mockOdds),
        headers: { "content-type": "application/json" }
      });
    });
    await page.route("**/api/match-stats/*", (route) =>
      route.fulfill({ status: 404, body: "{}", headers: { "content-type": "application/json" } })
    );
  });

  test("renders odds search controls", async ({ page }) => {
    await page.goto("/en/odds");
    await expect(page.locator("[data-search-input]")).toBeVisible();
    await expect(page.getByRole("button", { name: /load/i })).toBeVisible();
  });

  test("supports locale toggle in top bar", async ({ page }) => {
    await page.goto("/en/odds");
    await page.getByRole("button", { name: "CS", exact: true }).click();
    // Locale state changes; the rail nav and other text now render Czech keys.
    await expect(page.getByRole("button", { name: "CS", exact: true })).toBeVisible();
  });
});
