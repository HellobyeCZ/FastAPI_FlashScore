import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { OPS_STATUS_OK, OPS_STATUS_STALE, stubJson, stubShell } from "./fixtures/stub";

/*
 * Data ops + Settings. Every /api request is stubbed: a catch-all answers
 * anything unexpected with a 404 (and records it), specific stubs are
 * registered after it so they take precedence.
 */

const SHOTS = process.env.OPS_SHOTS_DIR;

type Json = Record<string, unknown>;

function job(overrides: Json): Json {
  return {
    competition_path: "football/czech-republic/chance-liga",
    seasons: 5,
    include_stats: true,
    include_odds: true,
    max_concurrency: 4,
    status: "completed",
    created_at: "2026-10-10T18:00:00+00:00",
    started_at: "2026-10-10T18:00:01+00:00",
    updated_at: "2026-10-10T18:20:59+00:00",
    finished_at: "2026-10-10T18:20:59+00:00",
    last_error: null,
    total_events: 0,
    pending_events: 0,
    running_events: 0,
    succeeded_events: 0,
    failed_events: 0,
    skipped_events: 0,
    ...overrides
  };
}

const RUNNING_JOB = job({
  id: 22,
  competition_path: "hockey/czech-republic/extraliga",
  seasons: 3,
  status: "running",
  finished_at: null,
  updated_at: "2026-10-11T11:58:00+00:00",
  total_events: 1040,
  pending_events: 610,
  running_events: 4,
  succeeded_events: 312,
  skipped_events: 114
});

const JOBS_SETTLED = [
  job({
    id: 21,
    status: "completed_with_errors",
    total_events: 182,
    succeeded_events: 14,
    failed_events: 3,
    skipped_events: 165
  }),
  job({
    id: 16,
    competition_path: "football/england/premier-league",
    seasons: 15,
    max_concurrency: 8,
    total_events: 4208,
    succeeded_events: 1438,
    skipped_events: 2770,
    updated_at: "2026-03-07T18:34:04+00:00"
  }),
  job({
    id: 15,
    competition_path: "football/france/ligue-1",
    seasons: 15,
    max_concurrency: 8,
    status: "failed",
    last_error: "Could not fetch 'https://www.flashscore.com/football/france/ligue-1-2023-2024/results/': ",
    updated_at: "2026-03-07T18:25:39+00:00"
  }),
  job({ id: 3, competition_path: "nhl", seasons: 10, total_events: 12896, succeeded_events: 12896 })
];

const JOBS_ACTIVE = [RUNNING_JOB, ...JOBS_SETTLED];

function jobEvent(event_id: string, status: string, last_error: string | null = null): Json {
  return {
    event_id,
    season_path: "/football/czech-republic/chance-liga/",
    status,
    attempts: status === "failed" ? 3 : 1,
    skipped_reason: null,
    last_error,
    created_at: "2026-10-10T18:00:02+00:00",
    started_at: "2026-10-10T18:00:03+00:00",
    updated_at: "2026-10-10T18:00:09+00:00",
    finished_at: "2026-10-10T18:00:09+00:00"
  };
}

/** GET bulk-scrape/jobs/21: the completed_with_errors job with its three failed events. */
const JOB_21_DETAIL = {
  ...JOBS_SETTLED[0],
  events: [
    jobEvent("CvsfNo26", "succeeded"),
    jobEvent("6svnP7Xg", "failed", "Unable to contact upstream match stats service."),
    jobEvent("tGh2Lk9q", "failed", "Upstream odds service temporarily unavailable."),
    jobEvent("Wq8xZ1ab", "failed", "Upstream odds service temporarily unavailable.")
  ]
};

const DONE_RUN = {
  run_id: "a1b2c3d4e5f6",
  status: "done",
  started_at: "2026-10-11T06:00:00+00:00",
  finished_at: "2026-10-11T06:04:12+00:00",
  duration_seconds: 252,
  stage_progress: {
    scrape: {
      state: "done",
      competitions_processed: 9,
      fixtures_discovered_or_updated: 64,
      events_snapshotted: 58,
      live_rows_written: 1914
    },
    phase1: {
      state: "done",
      labels_upserted: 41,
      closing_upserted: 38,
      closing_from_live_upserted: 3,
      elo_upserted: 41
    },
    settle: { state: "done", pending_at_start: 7, settled: 6, voided: 0, skipped_no_label: 1 },
    predict: { state: "done", upcoming_events: 24, candidate_picks: 5, newly_inserted: 4, duplicates_skipped: 1 }
  },
  error: null,
  summary: {}
};

/** A running refresh the list still names after FastAPI restarted; its detail is a 404. */
const FORGOTTEN_RUN = {
  ...DONE_RUN,
  run_id: "r1",
  status: "scrape",
  finished_at: null,
  stage_progress: { scrape: { state: "running" } }
};

/**
 * Answer the run list with `run` as active, and the run's detail with `status`.
 * With `restarted`, the list forgets the run once its detail has failed, as a
 * restarted backend's would.
 */
async function stubFollowedRun(
  page: Page,
  run: Json & { run_id: string },
  status: number,
  { restarted = false } = {}
) {
  let polls = 0;
  let lists = 0;
  await page.route(/\/api\/backend\/refresh-now(\?.*)?$/, (route) => {
    lists += 1;
    const forgotten = restarted && polls > 0;
    return route.fulfill({
      json: forgotten ? { active_run_id: null, runs: [] } : { active_run_id: run.run_id, runs: [run] }
    });
  });
  await page.route(new RegExp(`/api/backend/refresh-now/${run.run_id}$`), (route) => {
    polls += 1;
    return route.fulfill({ status, json: { detail: status === 404 ? "Refresh run not found." : "Internal Server Error" } });
  });
  return { polls: () => polls, lists: () => lists };
}

/** Status with a mix of fresh, stale and overdue stages (generated 12:00Z). */
const OPS_STATUS_MIXED = {
  ...OPS_STATUS_STALE,
  pipeline: {
    ...OPS_STATUS_STALE.pipeline,
    last_settled_at: "2026-05-13T20:41:00Z",
    oldest_pending_at: "2026-05-12T06:23:24Z",
    last_live_odds_at: "2026-10-10T06:00:00Z",
    last_discovery_at: "2026-10-11T06:00:00Z",
    upcoming_fixtures_72h: 0,
    active_backtests: 2
  },
  mlflow: { ...OPS_STATUS_OK.mlflow, reachable: false, error: "ConnectionError: [Errno 61] Connection refused" }
};

type Stubs = {
  ops?: unknown;
  opsStatus?: number;
  jobs?: unknown[];
  jobsStatus?: number;
  refreshList?: unknown;
  refreshStatus?: number;
};

/** Stub everything the ops and settings pages call; returns request logs. */
async function stubOps(page: Page, s: Stubs = {}) {
  const stray: string[] = [];
  const posts: Request[] = [];
  await page.route("**/api/**", (route) => {
    stray.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 404, json: { error: { code: "unstubbed", message: "not stubbed" } } });
  });
  await stubShell(page, s.ops ?? OPS_STATUS_OK);
  if (s.opsStatus) {
    await stubJson(page, "**/api/backend/ops/status", { detail: "Internal Server Error" }, s.opsStatus);
  }
  await page.route(/\/api\/backend\/bulk-scrape\/jobs(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request());
      const body = route.request().postDataJSON() as Json;
      return route.fulfill({ json: job({ id: 23, status: "queued", ...body, total_events: 0 }) });
    }
    return s.jobsStatus
      ? route.fulfill({ status: s.jobsStatus, json: { detail: "Bulk scrape storage unavailable" } })
      : route.fulfill({ json: { total: (s.jobs ?? JOBS_SETTLED).length, jobs: s.jobs ?? JOBS_SETTLED } });
  });
  await page.route(/\/api\/backend\/refresh-now(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request());
      return route.fulfill({ json: { ...DONE_RUN, run_id: "fresh0000001", status: "queued", stage_progress: {} } });
    }
    return s.refreshStatus
      ? route.fulfill({ status: s.refreshStatus, json: { detail: "Internal Server Error" } })
      : route.fulfill({ json: s.refreshList ?? { active_run_id: null, runs: [DONE_RUN] } });
  });
  return { stray, posts };
}

/** Table row (inside `scope`) whose cell contains exactly `name`. */
function stageRow(scope: Locator, name: string) {
  return scope.getByRole("row").filter({ has: scope.page().getByText(name, { exact: true }) });
}

/**
 * Inputs typed into before hydration are reset by React, so form tests wait
 * for something only the client renders: data from a stubbed query.
 */
async function waitForJobs(page: Page) {
  await expect(page.getByRole("button", { name: "nhl", exact: true })).toBeVisible();
}

async function waitForSettings(page: Page) {
  await expect(page.getByRole("region", { name: /About|O aplikaci/ })).toContainText("abc1234");
}

/** The spec's narrowest viewport; the mobile project's Pixel 7 is 412 px wide. */
const PHONE = { width: 390, height: 844 };

/** On the mobile project, check overflow at 390 px rather than the device width. */
async function phoneWidth(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "mobile") await page.setViewportSize(PHONE);
}

/**
 * Neither the page nor any table inside it scrolls sideways. Compared with the
 * configured viewport width: on an emulated phone, overflowing content can
 * zoom the page out and widen window.innerWidth along with it.
 */
async function noHorizontalOverflow(page: Page) {
  const { scroll, inner, scrollingTables } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    scrollingTables: Array.from(document.querySelectorAll("main table"))
      .filter((t) => t.parentElement && t.parentElement.scrollWidth > t.parentElement.clientWidth + 1)
      .map((t) => t.querySelector("caption")?.textContent)
  }));
  const width = page.viewportSize()?.width ?? inner;
  expect(scroll).toBeLessThanOrEqual(width);
  expect(inner).toBeLessThanOrEqual(width);
  expect(scrollingTables).toEqual([]);
}

test.describe("Data ops", () => {
  test("pipeline freshness tones follow the health thresholds", async ({ page }) => {
    const { stray } = await stubOps(page, { ops: OPS_STATUS_MIXED });
    await page.goto("/en/ops");
    await expect(page.getByRole("heading", { level: 1, name: "Data ops" })).toBeVisible();

    const pipeline = page.getByRole("region", { name: "Pipeline freshness" });
    await expect(stageRow(pipeline, "Picks recorded")).toContainText("Overdue");
    await expect(stageRow(pipeline, "Bets settled")).toContainText("Behind");
    await expect(stageRow(pipeline, "Pending bets")).toContainText("18 bets");
    // No fixtures coming up, so a day-old live snapshot is not a problem
    // (the backend raises live_odds_stale only when fixtures exist).
    await expect(stageRow(pipeline, "Live odds snapshot")).toContainText("Not needed");
    await expect(stageRow(pipeline, "Fixture discovery")).toContainText("Fresh");
    await expect(stageRow(pipeline, "Upcoming fixtures (72 h)")).toContainText("None");
    await expect(stageRow(pipeline, "Backtest queue")).toContainText("2 active");
    await expect(pipeline.getByRole("link", { name: "View backtests" })).toHaveAttribute("href", "/en/lab/backtests");
    // The age keeps its absolute time on hover.
    await expect(stageRow(pipeline, "Picks recorded").locator("time")).toHaveAttribute("title", /2026/);

    // Full health banner lists every issue and links to this page.
    await expect(page.getByRole("main").getByText("18 bets still unsettled", { exact: false }).first()).toBeVisible();

    // MLflow down: explained, with the command that starts it.
    const serving = page.getByRole("region", { name: "Served models & MLflow" });
    await expect(serving.getByText("MLflow is not reachable")).toBeVisible();
    await expect(serving.getByText("make mlflow")).toBeVisible();
    await expect(serving.getByRole("link", { name: "Model registry" })).toHaveAttribute("href", "/en/lab/registry");
    await expect(serving.getByRole("link", { name: "Experiments" })).toHaveAttribute("href", "/en/lab/experiments");
    await expect(serving.getByRole("link", { name: /Open MLflow/ })).toHaveCount(0);
    expect(stray).toEqual([]);
  });

  test("served models show source, version and an MLflow link when reachable", async ({ page }) => {
    await stubOps(page);
    await page.goto("/en/ops");
    const serving = page.getByRole("region", { name: "Served models & MLflow" });
    await expect(stageRow(serving, "Logistic")).toContainText("Registry v3");
    await expect(stageRow(serving, "Gradient boosting")).toContainText("Model file");
    await expect(stageRow(serving, "Dixon–Coles")).toContainText("Not loaded");
    await expect(serving.getByRole("link", { name: /Open MLflow/ })).toHaveAttribute("href", "http://127.0.0.1:5050");
    await expect(serving.getByText("picks · #2")).toBeVisible();
  });

  test("refresh-all asks for confirmation, then polls the run to completion", async ({ page }) => {
    const { posts } = await stubOps(page, { refreshList: { active_run_id: null, runs: [] } });
    let statusCalls = 0;
    await page.route("**/api/backend/ops/status", (route) => {
      statusCalls += 1;
      return route.fulfill({ json: OPS_STATUS_OK });
    });
    const sequence = [
      { status: "scrape", stage_progress: { scrape: { state: "running" } } },
      {
        status: "phase1",
        stage_progress: { scrape: DONE_RUN.stage_progress.scrape, phase1: { state: "running" } }
      },
      { status: "done", stage_progress: DONE_RUN.stage_progress }
    ];
    let polls = 0;
    await page.route(/\/api\/backend\/refresh-now\/fresh0000001$/, (route) => {
      const step = sequence[Math.min(polls, sequence.length - 1)];
      polls += 1;
      return route.fulfill({
        json: {
          ...DONE_RUN,
          run_id: "fresh0000001",
          finished_at: step.status === "done" ? "2026-10-11T12:04:00+00:00" : null,
          ...step
        }
      });
    });

    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Refresh all" });
    await expect(panel.getByText("No refresh since the backend started")).toBeVisible();
    await panel.getByRole("button", { name: "Run refresh" }).click();

    const dialog = page.getByRole("dialog", { name: "Run a full refresh?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("upstream requests to FlashScore");
    await expect(dialog).toContainText("next 7 days");
    expect(posts).toHaveLength(0);

    await dialog.getByRole("button", { name: "Run refresh" }).click();
    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(1);
    const url = new URL(posts[0].url());
    expect(Object.fromEntries(url.searchParams)).toEqual({
      window_days: "7",
      max_concurrency: "4",
      hours_ahead: "72",
      min_edge: "0.02"
    });

    const stage = (s: string) => panel.locator(`[data-stage="${s}"]`);
    await expect(panel.getByRole("button", { name: /Refresh running/ })).toBeDisabled();
    await expect(stage("phase1")).toHaveAttribute("data-state", "running", { timeout: 10_000 });
    await expect(stage("scrape")).toHaveAttribute("data-state", "done");
    await expect(stage("scrape")).toContainText("Fixtures found");
    const statusCallsWhileRunning = statusCalls;
    for (const s of ["scrape", "phase1", "settle", "predict"]) {
      await expect(stage(s)).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    }
    await expect(panel.getByRole("button", { name: "Run refresh" })).toBeEnabled();
    // Completion invalidates the cached status (and every other query).
    await expect.poll(() => statusCalls).toBeGreaterThan(statusCallsWhileRunning);
    // Polling stops once the run is done.
    const settled = polls;
    await page.waitForTimeout(2_500);
    expect(polls).toBe(settled);
  });

  test("a failed refresh marks the stage that failed and the ones never reached", async ({ page }) => {
    const failed = {
      ...DONE_RUN,
      status: "error",
      stage_progress: { scrape: DONE_RUN.stage_progress.scrape, phase1: { state: "running" } },
      error: "OperationalError: database is locked"
    };
    await stubOps(page, { refreshList: { active_run_id: null, runs: [failed] } });
    await page.route(/\/api\/backend\/refresh-now\/a1b2c3d4e5f6$/, (route) => route.fulfill({ json: failed }));
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Refresh all" });
    await expect(panel.locator('[data-stage="scrape"]')).toHaveAttribute("data-state", "done");
    await expect(panel.locator('[data-stage="phase1"]')).toHaveAttribute("data-state", "failed");
    await expect(panel.locator('[data-stage="settle"]')).toHaveAttribute("data-state", "skipped");
    await expect(panel.getByText("Refresh failed at “Rebuild labels, closing odds and Elo”")).toBeVisible();
    await expect(panel.getByText("OperationalError: database is locked")).toBeVisible();
  });

  test("a followed run the backend no longer knows stops polling and frees the button", async ({ page }) => {
    // FastAPI keeps refresh runs in memory: after a restart the list (stale in
    // the cache, or still listing it) points at a run whose detail is a 404.
    await stubOps(page);
    const run = await stubFollowedRun(page, FORGOTTEN_RUN, 404);
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Refresh all" });
    await expect(panel.getByText("The backend no longer knows this run")).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByRole("button", { name: "Run refresh" })).toBeEnabled();
    await expect(panel.locator('[data-state="running"]')).toHaveCount(0);
    await expect(panel.getByText(/Current run started/)).toHaveCount(0);
    await expect(panel.getByText("Couldn't load the current run")).toHaveCount(0);

    const settled = run.polls();
    await page.waitForTimeout(4_500);
    expect(run.polls()).toBe(settled);

    // The list was reloaded once; it still names the run, which must not loop.
    expect(run.lists()).toBe(2);

    await panel.getByRole("button", { name: "Dismiss" }).click();
    await expect(panel.getByText("The backend no longer knows this run")).toHaveCount(0);
  });

  test("after a backend restart the reloaded list drops the forgotten run", async ({ page }) => {
    await stubOps(page);
    await stubFollowedRun(page, FORGOTTEN_RUN, 404, { restarted: true });
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Refresh all" });
    await expect(panel.getByText("No refresh since the backend started")).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("The backend no longer knows this run")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Run refresh" })).toBeEnabled();
  });

  test("a failing run fetch is reported as such and stops polling", async ({ page }) => {
    await stubOps(page);
    const run = await stubFollowedRun(
      page,
      {
        ...DONE_RUN,
        run_id: "r2",
        status: "settle",
        finished_at: null,
        stage_progress: { scrape: DONE_RUN.stage_progress.scrape, settle: { state: "running" } }
      },
      500
    );
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Refresh all" });
    await expect(panel.getByText("Couldn't load the current run")).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("Couldn't load refresh runs")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Run refresh" })).toBeEnabled();
    const settled = run.polls();
    await page.waitForTimeout(4_500);
    expect(run.polls()).toBe(settled);
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => run.polls()).toBeGreaterThan(settled);
  });

  test("scrape jobs show completed_with_errors, progress counts and error details", async ({ page }) => {
    await stubOps(page);
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Bulk scrape" });
    const table = panel.getByRole("table", { name: "Bulk scrape jobs, newest first" });

    const partial = table.getByRole("row").filter({ hasText: "#21" });
    await expect(partial).toContainText("Completed with errors");
    await expect(partial).toContainText("182 of 182");
    await expect(partial).toContainText("14 fetched");
    await expect(partial).toContainText("165 skipped");
    await expect(partial).toContainText("3 failed");
    await expect(partial.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "182");

    const failed = table.getByRole("row").filter({ hasText: "#15" });
    await expect(failed).toContainText("Failed");
    await expect(failed).toContainText("Could not fetch 'football/france/ligue-1-2023-2024/results/'");
    const full = failed.getByText("https://www.flashscore.com/football/france/ligue-1-2023-2024/results/", {
      exact: false
    });
    await expect(full).toBeHidden();
    await failed.getByText("Details").click();
    await expect(full).toBeVisible();

    // Nothing is active, so there is no stop action.
    await expect(table.getByRole("button", { name: /Stop job/ })).toHaveCount(0);
  });

  test("per-event failures of a completed_with_errors job load when expanded", async ({ page }) => {
    await stubOps(page);
    const detail: string[] = [];
    await page.route(/\/api\/backend\/bulk-scrape\/jobs\/21(\?.*)?$/, (route) => {
      detail.push(route.request().url());
      return route.fulfill({ json: JOB_21_DETAIL });
    });
    await page.goto("/en/ops");
    const row = page.getByRole("region", { name: "Bulk scrape" }).getByRole("row").filter({ hasText: "#21" });
    await expect(row).toContainText("3 events failed");
    await page.waitForTimeout(500);
    expect(detail).toEqual([]);

    await row.getByText("Details").click();
    const reasons = row.getByRole("list", { name: "Why events of job #21 failed" }).getByRole("listitem");
    await expect(reasons).toHaveText([
      "Upstream odds service temporarily unavailable. · 2 events",
      "Unable to contact upstream match stats service. · 1 event"
    ]);
    // Every event of the job is requested, so late failures are not missed.
    expect(detail).toHaveLength(1);
    expect(new URL(detail[0]).searchParams.get("event_limit")).toBe("182");
    await expect(row).not.toContainText("6svnP7Xg");
  });

  test("the jobs list polls only while a job is active", async ({ page }) => {
    let active = 0;
    await stubOps(page, { jobs: JOBS_ACTIVE });
    await page.route(/\/api\/backend\/bulk-scrape\/jobs(\?.*)?$/, (route) => {
      active += 1;
      return route.fulfill({ json: { total: JOBS_ACTIVE.length, jobs: JOBS_ACTIVE } });
    });
    await page.goto("/en/ops");
    await expect(page.getByRole("button", { name: "Stop job #22" })).toBeVisible();
    // Every 3 s while job #22 runs: at least two refetches after the first load.
    await expect.poll(() => active, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  });

  test("the jobs list does not poll when every job has finished", async ({ page }) => {
    let calls = 0;
    await stubOps(page);
    await page.route(/\/api\/backend\/bulk-scrape\/jobs(\?.*)?$/, (route) => {
      calls += 1;
      return route.fulfill({ json: { total: JOBS_SETTLED.length, jobs: JOBS_SETTLED } });
    });
    await page.goto("/en/ops");
    await waitForJobs(page);
    const loaded = calls;
    await page.waitForTimeout(4_000);
    expect(calls).toBe(loaded);
  });

  test("stopping a running job needs confirmation; a 404 is reported in place", async ({ page }) => {
    await stubOps(page, { jobs: JOBS_ACTIVE });
    const cancels: string[] = [];
    await page.route(/\/api\/backend\/bulk-scrape\/jobs\/\d+\/cancel$/, (route) => {
      cancels.push(route.request().url());
      return route.fulfill({ status: 404, json: { detail: "Not Found" } });
    });
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Bulk scrape" });
    await expect(panel.getByText("Running", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Stop job #22" }).click();

    const dialog = page.getByRole("dialog", { name: "Stop job #22?" });
    await expect(dialog).toContainText("hockey/czech-republic/extraliga");
    await expect(dialog).toContainText("remaining 614 events");
    expect(cancels).toHaveLength(0);
    await dialog.getByRole("button", { name: "Stop job" }).click();

    await expect(dialog).toBeHidden();
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatch(/\/bulk-scrape\/jobs\/22\/cancel$/);
    const alert = panel.getByRole("alert");
    await expect(alert).toContainText("Couldn't stop job #22");
    await expect(alert).toContainText("404");
    await alert.getByRole("button", { name: "Dismiss" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });

  test("stopping a job refreshes the list", async ({ page }) => {
    let cancelled = false;
    await stubOps(page, { jobs: JOBS_ACTIVE });
    await page.route(/\/api\/backend\/bulk-scrape\/jobs(\?.*)?$/, (route) => {
      const jobs = cancelled ? [{ ...RUNNING_JOB, status: "cancelled" }, ...JOBS_SETTLED] : JOBS_ACTIVE;
      return route.fulfill({ json: { total: jobs.length, jobs } });
    });
    await page.route(/\/api\/backend\/bulk-scrape\/jobs\/22\/cancel$/, (route) => {
      cancelled = true;
      return route.fulfill({ json: { ...RUNNING_JOB, status: "cancelled" } });
    });
    await page.goto("/en/ops");
    const panel = page.getByRole("region", { name: "Bulk scrape" });
    await panel.getByRole("button", { name: "Stop job #22" }).click();
    await page.getByRole("dialog", { name: "Stop job #22?" }).getByRole("button", { name: "Stop job" }).click();
    await expect(panel.getByText("Stop requested for job #22.")).toBeVisible();
    const row = panel.getByRole("row").filter({ hasText: "#22" });
    await expect(row).toContainText("Cancelled");
    await expect(panel.getByRole("button", { name: /Stop job/ })).toHaveCount(0);
  });

  test("new scrape: validation, a confirmation that summarises the cost, then the POST", async ({ page }) => {
    const { posts } = await stubOps(page);
    await page.goto("/en/ops");
    await waitForJobs(page);
    const panel = page.getByRole("region", { name: "Bulk scrape" });
    const pathInput = panel.getByLabel("Competition path");
    const seasons = panel.getByLabel("Seasons");
    const concurrency = panel.getByLabel("Parallel requests");
    const review = panel.getByRole("button", { name: "Review scrape" });

    await expect(pathInput).toHaveValue("");
    await expect(pathInput).toHaveAttribute("placeholder", "sport/country/competition");
    await review.click();
    await expect(panel.getByText("Enter a competition path.")).toBeVisible();
    await expect(pathInput).toHaveAttribute("aria-invalid", "true");

    await pathInput.fill("premier league!");
    await seasons.fill("12");
    await concurrency.fill("0");
    await panel.getByLabel("Match stats", { exact: true }).uncheck();
    await panel.getByLabel("Odds", { exact: true }).uncheck();
    await expect(panel.getByText("That doesn't look like a FlashScore path.", { exact: false })).toBeVisible();
    await expect(panel.getByText("Enter a whole number from 1 to 10.")).toBeVisible();
    await expect(panel.getByText("Enter a whole number from 1 to 8.")).toBeVisible();
    await expect(panel.getByText("Pick at least one of match stats or odds.")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A recent path fills the field; a full URL is normalised.
    await panel.getByRole("button", { name: "football/england/premier-league" }).click();
    await expect(pathInput).toHaveValue("football/england/premier-league");
    await pathInput.fill("https://www.flashscore.com/football/czech-republic/chance-liga/results/");
    await seasons.fill("5");
    await concurrency.fill("3");
    await panel.getByLabel("Odds", { exact: true }).check();
    await review.click();

    const dialog = page.getByRole("dialog", { name: "Start this scrape?" });
    await expect(dialog).toContainText("football/czech-republic/chance-liga");
    await expect(dialog).toContainText("5 seasons");
    await expect(dialog).toContainText("≈ 182 events");
    await expect(dialog).toContainText("Job #21 found 182 events for the same seasons");
    await expect(dialog).toContainText("Odds only");
    await expect(dialog).toContainText("upstream requests to FlashScore");
    expect(posts).toHaveLength(0);

    await dialog.getByRole("button", { name: "Start scrape" }).click();
    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(1);
    expect(posts[0].postDataJSON()).toEqual({
      competition_path: "football/czech-republic/chance-liga",
      seasons: 5,
      include_stats: false,
      include_odds: true,
      max_concurrency: 3
    });
    await expect(panel.getByText("Job #23 queued for football/czech-republic/chance-liga.")).toBeVisible();
    await expect(pathInput).toHaveValue("");
  });

  test("an unseen competition has no estimate, and scaling is explained", async ({ page }) => {
    await stubOps(page);
    await page.goto("/en/ops");
    await waitForJobs(page);
    const panel = page.getByRole("region", { name: "Bulk scrape" });
    await panel.getByLabel("Competition path").fill("basketball/usa/nba");
    await panel.getByRole("button", { name: "Review scrape" }).click();
    let dialog = page.getByRole("dialog", { name: "Start this scrape?" });
    await expect(dialog).toContainText("Unknown until discovery");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await panel.getByLabel("Competition path").fill("football/england/premier-league");
    await panel.getByLabel("Seasons").fill("3");
    await panel.getByRole("button", { name: "Review scrape" }).click();
    dialog = page.getByRole("dialog", { name: "Start this scrape?" });
    await expect(dialog).toContainText("≈ 842 events");
    await expect(dialog).toContainText("Scaled from job #16, which found 4,208 events in 15 seasons.");
  });

  test("empty and failing panels keep the rest of the page usable", async ({ page }) => {
    await stubOps(page, { jobs: [], refreshStatus: 500, opsStatus: 500 });
    await page.goto("/en/ops");
    await expect(page.getByRole("heading", { level: 1, name: "Data ops" })).toBeVisible();

    const scrape = page.getByRole("region", { name: "Bulk scrape" });
    await expect(scrape.getByText("No scrape jobs yet")).toBeVisible();
    await expect(scrape.getByRole("button", { name: "Review scrape" })).toBeVisible();

    const pipeline = page.getByRole("region", { name: "Pipeline freshness" });
    await expect(pipeline.getByText("Couldn't load the system status")).toBeVisible();
    await expect(pipeline.getByRole("button", { name: "Retry" })).toBeVisible();

    const refresh = page.getByRole("region", { name: "Refresh all" });
    await expect(refresh.getByText("Couldn't load refresh runs")).toBeVisible({ timeout: 10_000 });
    await expect(refresh.getByRole("button", { name: "Run refresh" })).toBeEnabled();

    // Shell still renders and reports the backend problem.
    await expect(page.getByRole("contentinfo")).toContainText("Problem");
  });

  test("a failing jobs list shows a scoped error with retry", async ({ page }) => {
    await stubOps(page, { jobsStatus: 500 });
    await page.goto("/en/ops");
    const scrape = page.getByRole("region", { name: "Bulk scrape" });
    await expect(scrape.getByText("Couldn't load scrape jobs")).toBeVisible({ timeout: 10_000 });
    await expect(scrape.getByText("Bulk scrape storage unavailable")).toBeVisible();
    await expect(scrape.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pipeline freshness" })).toContainText("Picks recorded");
  });

  test("Czech locale translates the page", async ({ page }) => {
    await stubOps(page, { ops: OPS_STATUS_MIXED, jobs: JOBS_ACTIVE });
    await page.goto("/cs/ops");
    await expect(page.locator("html")).toHaveAttribute("lang", "cs");
    await expect(page.getByRole("heading", { level: 1, name: "Správa dat" })).toBeVisible();
    for (const name of ["Čerstvost pipeline", "Obnovit vše", "Nasazené modely a MLflow", "Hromadné stahování"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    const pipeline = page.getByRole("region", { name: "Čerstvost pipeline" });
    await expect(stageRow(pipeline, "Čekající sázky")).toContainText("18 sázek");
    await expect(page.getByRole("button", { name: "Zastavit úlohu #22" })).toBeVisible();
    await expect(page.getByText("Dokončeno s chybami")).toBeVisible();
  });

  test("no horizontal overflow with long paths and errors", async ({ page }, testInfo) => {
    await phoneWidth(page, testInfo);
    await stubOps(page, { ops: OPS_STATUS_MIXED, jobs: JOBS_ACTIVE });
    await page.goto("/en/ops");
    await expect(page.getByText("Completed with errors")).toBeVisible();
    await expect(page.getByRole("region", { name: "Refresh all" }).locator('[data-stage="predict"]')).toBeVisible();
    await noHorizontalOverflow(page);
  });
});

test.describe("Settings", () => {
  test("toggles apply immediately and persist across reload", async ({ page }) => {
    await stubOps(page);
    await page.goto("/en/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await waitForSettings(page);

    const dense = page.getByLabel("Compact tables");
    const scanlines = page.getByLabel("CRT scanlines");
    const edge = page.getByRole("radiogroup", { name: "Minimum edge" });
    await expect(dense).not.toBeChecked();
    await expect(edge.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");

    await dense.check();
    await scanlines.check();
    await edge.getByRole("radio", { name: "3%" }).click();
    await expect(edge.getByRole("radio", { name: "3%" })).toHaveAttribute("aria-checked", "true");

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("terminal.settings.v2") ?? "{}"));
    expect(stored).toEqual({ scanlines: true, dense: true, minEdge: 0.03 });

    await page.reload();
    await waitForSettings(page);
    await expect(page.getByLabel("Compact tables")).toBeChecked();
    await expect(page.getByLabel("CRT scanlines")).toBeChecked();
    await expect(
      page.getByRole("radiogroup", { name: "Minimum edge" }).getByRole("radio", { name: "3%" })
    ).toHaveAttribute("aria-checked", "true");
  });

  test("language control switches to Czech on the same page", async ({ page }) => {
    await stubOps(page);
    await page.goto("/en/settings");
    await waitForSettings(page);
    const language = page.getByRole("radiogroup", { name: "Interface language" });
    await language.getByRole("radio", { name: "Čeština" }).click();
    await expect(page).toHaveURL(/\/cs\/settings$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "cs");
    await expect(page.getByRole("heading", { level: 1, name: "Nastavení" })).toBeVisible();
    for (const name of ["Jazyk", "Zobrazení", "Výchozí pohled Dnes", "O aplikaci"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect(page.getByLabel("CRT rastr")).toBeVisible();
  });

  test("about shows build and backend status, and survives a backend outage", async ({ page }) => {
    await stubOps(page, { opsStatus: 502 });
    await page.goto("/en/settings");
    const about = page.getByRole("region", { name: "About" });
    await expect(about.getByText("The backend isn't answering")).toBeVisible();
    await expect(about.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(about.getByRole("link", { name: "Open Data ops" })).toHaveAttribute("href", "/en/ops");
    await expect(page.getByLabel("Compact tables")).toBeEnabled();
  });

  test("no horizontal overflow", async ({ page }, testInfo) => {
    await phoneWidth(page, testInfo);
    await stubOps(page);
    await page.goto("/en/settings");
    await expect(page.getByRole("region", { name: "About" })).toContainText("abc1234");
    await noHorizontalOverflow(page);
  });
});

test.describe("screenshots", () => {
  test.skip(!SHOTS, "set OPS_SHOTS_DIR to capture review screenshots");

  test("Data ops and Settings, desktop and mobile, en and cs", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "captured once, from the desktop project");
    test.setTimeout(180_000);
    mkdirSync(SHOTS!, { recursive: true });
    await stubOps(page, { ops: OPS_STATUS_MIXED, jobs: JOBS_ACTIVE });
    await stubJson(page, /\/api\/backend\/bulk-scrape\/jobs\/21(\?.*)?$/, JOB_21_DETAIL);
    for (const [label, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", PHONE]
    ] as const) {
      await page.setViewportSize(size);
      for (const locale of ["en", "cs"]) {
        await page.goto(`/${locale}/ops`);
        await expect(page.locator('[data-stage="predict"]')).toBeVisible();
        await expect(page.getByRole("progressbar").first()).toBeVisible();
        await noHorizontalOverflow(page);
        await page.screenshot({ path: path.join(SHOTS!, `${label}-${locale}-ops.png`), fullPage: true });
        await page.goto(`/${locale}/settings`);
        await expect(page.locator("[data-health]")).toBeVisible();
        await noHorizontalOverflow(page);
        await page.screenshot({ path: path.join(SHOTS!, `${label}-${locale}-settings.png`), fullPage: true });
      }
    }
    // Confirmation dialogs, desktop en.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/ops");
    await waitForJobs(page);
    const scrape = page.getByRole("region", { name: "Bulk scrape" });
    await scrape.getByLabel("Competition path").fill("football/czech-republic/chance-liga");
    await scrape.getByRole("button", { name: "Review scrape" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS!, "desktop-en-ops-scrape-confirm.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("region", { name: "Refresh all" }).getByRole("button", { name: "Run refresh" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS!, "desktop-en-ops-refresh-confirm.png") });
    await page.keyboard.press("Escape");

    // Per-event failures expanded, phone width, Czech (the longest copy).
    await page.setViewportSize(PHONE);
    await page.goto("/cs/ops");
    const jobs = page.getByRole("region", { name: "Hromadné stahování" });
    const partial = jobs.getByRole("row").filter({ hasText: "#21" });
    await partial.getByText("Podrobnosti").click();
    await expect(partial.getByRole("listitem")).toHaveCount(2);
    await noHorizontalOverflow(page);
    await partial.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS!, "mobile-cs-ops-job-failures.png") });

    // A followed run the backend forgot.
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubFollowedRun(page, FORGOTTEN_RUN, 404, { restarted: true });
    await page.goto("/en/ops");
    const refresh = page.getByRole("region", { name: "Refresh all" });
    await expect(refresh.getByText("The backend no longer knows this run")).toBeVisible({ timeout: 10_000 });
    await expect(refresh.getByText("No refresh since the backend started")).toBeVisible();
    await refresh.screenshot({ path: path.join(SHOTS!, "desktop-en-ops-refresh-gone.png") });
  });
});
