import { expect, test, type Page } from "@playwright/test";
import { OPS_STATUS_STALE, stubJson, stubShell } from "./fixtures/stub";

/*
 * Shell-level behaviour shared by every page: navigation, keyboard, locale,
 * redirects and the health signal. Pages' own data calls are answered with a
 * 503 by a catch-all (registered first, so the specific stubs win); the shell
 * must stay usable whatever the pages do with that.
 */

async function stubAll(page: Page, ops?: unknown) {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: { code: "stubbed", message: "Not stubbed in shell tests" } } })
  );
  await stubShell(page, ops);
}

const isMobile = (name: string) => name === "mobile";

/** Waits until the client has hydrated: the status bar shows health from a query. */
async function hydrated(page: Page) {
  await expect(page.getByRole("contentinfo").getByRole("link", { name: /All systems normal|Problem/ })).toBeVisible();
}

function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Main navigation" });
}

/**
 * Nav link by its label. Top-level items reveal their shortcut ("g t") on
 * hover, which joins the accessible name, so match the label as a prefix.
 */
function navLink(page: Page, label: string) {
  return mainNav(page).getByRole("link", { name: new RegExp(`^${label}(\\s|$)`) });
}

/** On phones the navigation lives in a drawer behind the menu button. */
async function openNav(page: Page, mobile: boolean) {
  if (!mobile) return;
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog", { name: "Main navigation" })).toBeVisible();
}

const SECTIONS = [
  { link: "Today", path: "/en/today", current: "Today" },
  { link: "Matches", path: "/en/matches", current: "Matches" },
  { link: "Performance", path: "/en/performance", current: "Leaderboard" },
  { link: "Bet explorer", path: "/en/performance/explore", current: "Bet explorer" },
  { link: "Model lab", path: "/en/lab/backtests", current: "Backtests" },
  { link: "Experiments", path: "/en/lab/experiments", current: "Experiments" },
  { link: "Registry", path: "/en/lab/registry", current: "Registry" },
  { link: "Data ops", path: "/en/ops", current: "Data ops" },
  { link: "Settings", path: "/en/settings", current: "Settings" }
];

test.describe("shell", () => {
  test("navigation reaches every section and marks the current page", async ({ page }, testInfo) => {
    // First visits compile each route in dev mode.
    test.setTimeout(300_000);
    const mobile = isMobile(testInfo.project.name);
    await stubAll(page);
    await page.goto("/en/settings");
    await hydrated(page);

    for (const s of SECTIONS) {
      await openNav(page, mobile);
      await navLink(page, s.link).click();
      await expect(page).toHaveURL(new RegExp(`${s.path}$`), { timeout: 60_000 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1, { timeout: 60_000 });

      await openNav(page, mobile);
      await expect(navLink(page, s.current)).toHaveAttribute("aria-current", "page");
      await expect(mainNav(page).locator('[aria-current="page"]')).toHaveCount(1);
      if (mobile) await page.keyboard.press("Escape");
    }
  });

  test("? opens the keyboard sheet; Escape closes it and restores focus", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "keyboard shortcuts are a desktop affordance");
    await stubAll(page);
    await page.goto("/en/settings");
    await hydrated(page);

    const opener = navLink(page, "Matches");
    await opener.focus();
    await page.keyboard.type("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Go to Matches");

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page).toHaveURL(/\/en\/settings$/);
  });

  test("g m goes to Matches", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "keyboard shortcuts are a desktop affordance");
    await stubAll(page);
    await page.goto("/en/settings");
    await hydrated(page);
    await page.keyboard.press("g");
    await page.keyboard.press("m");
    await expect(page).toHaveURL(/\/en\/matches$/, { timeout: 60_000 });
    await expect(navLink(page, "Matches")).toHaveAttribute("aria-current", "page");
  });

  test("switching EN → CS keeps the path and query and sets <html lang>", async ({ page }) => {
    await stubAll(page);
    await page.goto("/en/settings?from=shell&tab=a");
    await hydrated(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    const switcher = (name: string) => page.getByRole("group", { name, exact: true });
    await switcher("Language").getByRole("button", { name: "cs", exact: true }).click();
    await expect(page).toHaveURL(/\/cs\/settings\?from=shell&tab=a$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "cs");
    await expect(page.getByRole("heading", { level: 1, name: "Nastavení" })).toBeVisible();
    const cs = switcher("Jazyk").getByRole("button", { name: "cs", exact: true });
    await expect(cs).toHaveAttribute("aria-pressed", "true");
  });

  test("old URLs redirect to the new sections, keeping the query", async ({ page }) => {
    test.setTimeout(180_000);
    await stubAll(page);
    for (const [from, to] of [
      ["/en/picks/models", /\/en\/performance$/],
      ["/en/jobs", /\/en\/ops$/],
      ["/en/odds", /\/en\/matches$/],
      ["/cs/odds?q=sparta", /\/cs\/matches\?q=sparta$/],
      ["/en/picks/health", /\/en\/ops$/],
      ["/en/picks/model/logistic", /\/en\/models\/logistic$/]
    ] as const) {
      await page.goto(from);
      await expect(page).toHaveURL(to, { timeout: 60_000 });
    }
  });

  test("the skip link moves focus to the main content", async ({ page }) => {
    await stubAll(page);
    await page.goto("/en/settings");
    await hydrated(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("a healthy backend shows no banner", async ({ page }) => {
    await stubAll(page);
    await page.goto("/en/settings");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "All systems normal" })).toBeVisible();
    const banner = page
      .getByRole("main")
      .getByRole("status")
      .filter({ has: page.getByRole("link", { name: "Open Data ops" }) });
    await expect(banner).toHaveCount(0);
  });

  test("a stale pipeline shows the slim banner and the health indicator", async ({ page }) => {
    await stubAll(page, OPS_STATUS_STALE);
    await page.goto("/en/settings");
    const banner = page.getByRole("main").getByRole("status").filter({ hasText: "Picks pipeline last ran" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Live numbers are stale.");
    await expect(banner).toContainText("+1");
    await expect(banner.getByRole("link", { name: "Open Data ops" })).toHaveAttribute("href", "/en/ops");

    const indicator = page.getByRole("contentinfo").getByRole("link", { name: /Problem/ });
    await expect(indicator).toContainText("(2)");
    await expect(indicator).toHaveAttribute("href", "/en/ops");
  });

  test("an unreachable backend shows the error indicator", async ({ page }) => {
    await stubAll(page);
    await stubJson(page, "**/api/backend/ops/status", { error: { code: "backend_unreachable", message: "down" } }, 502);
    await page.goto("/en/settings");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: /Problem/ })).toBeVisible();
    await expect(page.getByRole("main").getByText("Backend is unreachable — data may be outdated.")).toBeVisible();
  });

  test("mobile: the menu button opens the drawer; Escape closes it", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), "the drawer only exists below md");
    await stubAll(page);
    await page.goto("/en/settings");
    await hydrated(page);

    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Main navigation" });
    await expect(drawer).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.getByRole("link", { name: "Today", exact: true })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  test("no horizontal overflow on Today", async ({ page }, testInfo) => {
    // The spec's rule is 390 px; the mobile project's Pixel 7 alone is 412 px.
    if (isMobile(testInfo.project.name)) await page.setViewportSize({ width: 390, height: 844 });
    await stubAll(page, OPS_STATUS_STALE);
    await page.goto("/en/today");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
    await hydrated(page);
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth
    }));
    expect(scroll).toBeLessThanOrEqual(inner);
    if (isMobile(testInfo.project.name)) expect(scroll).toBeLessThanOrEqual(390);
  });
});
