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
    await page.route("**/odds/*", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(mockOdds),
        headers: { "content-type": "application/json" }
      });
    });
  });

  test("allows visitors to search and view odds", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Enter event ID").fill("123456");
    await page.getByRole("button", { name: "Fetch odds" }).click();

    await expect(page.getByRole("row", { name: /Team A/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Team B/ })).toBeVisible();
    await expect(page.getByText("Updated", { exact: false })).toBeVisible();
  });

  test("supports localisation switching", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Language").selectOption("cs");
    await expect(page.getByRole("heading", { name: "FastAPI FlashScore kurzy" })).toBeVisible();
  });
});
