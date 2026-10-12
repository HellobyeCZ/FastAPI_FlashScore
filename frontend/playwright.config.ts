import { defineConfig, devices } from "@playwright/test";

// Each worktree/CI job picks its own port (E2E_PORT) so tests never attach
// to an unrelated server that happens to be listening on :3000.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    locale: "en-US"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    ...(process.env.E2E_ALL_BROWSERS
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] } },
          { name: "webkit", use: { ...devices["Desktop Safari"] } }
        ]
      : [])
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `${BASE}/en/settings`,
        reuseExistingServer: true,
        timeout: 180_000,
        // Tests stub every /api/* call; an unreachable backend makes any
        // un-stubbed request fail loudly instead of hitting a real FastAPI.
        env: { ODDS_BACKEND_BASE_URL: "http://127.0.0.1:9" }
      }
});
