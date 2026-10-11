import type { Page, Route } from "@playwright/test";

/**
 * Stub an API route with a JSON body. `pattern` is matched against the
 * request URL (glob or RegExp), e.g. "**\/api/backend/ops/status".
 */
export async function stubJson(page: Page, pattern: string | RegExp, body: unknown, status = 200) {
  await page.route(pattern, (route: Route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  );
}

/** Healthy /ops/status used by default so the shell renders without warnings. */
export const OPS_STATUS_OK = {
  generated_at: "2026-10-11T12:00:00Z",
  git_sha: "abc1234",
  db: { size_bytes: 9_326_305_280 },
  pipeline: {
    last_pick_recorded_at: "2026-10-11T06:00:00Z",
    last_settled_at: "2026-10-11T06:00:00Z",
    pending_bets: 3,
    oldest_pending_at: "2026-10-10T18:00:00Z",
    last_live_odds_at: "2026-10-11T06:00:00Z",
    last_discovery_at: "2026-10-11T06:00:00Z",
    upcoming_fixtures_72h: 24,
    last_scrape_job_at: "2026-10-10T20:00:00Z",
    active_scrape_jobs: 0,
    active_backtests: 0
  },
  models: [
    { name: "logistic", loaded: true, source: "registry", version: "3", run_id: "r1", loaded_at: "2026-10-11T06:00:00Z" },
    { name: "hgb", loaded: true, source: "file", version: null, run_id: null, loaded_at: "2026-10-11T06:00:00Z" },
    { name: "dixon_coles", loaded: false, source: null, version: null, run_id: null, loaded_at: null }
  ],
  mlflow: {
    enabled: true,
    reachable: true,
    tracking_uri: "http://127.0.0.1:5050",
    ui_url: "http://127.0.0.1:5050",
    experiment_name: "picks",
    experiment_id: "2",
    error: null,
    checked_at: "2026-10-11T12:00:00Z"
  },
  health: { level: "ok", issues: [] }
};

/** Stale-pipeline variant (the real state of the DB during the 2026-10 audit). */
export const OPS_STATUS_STALE = {
  ...OPS_STATUS_OK,
  pipeline: { ...OPS_STATUS_OK.pipeline, last_pick_recorded_at: "2026-05-12T06:23:24Z", pending_bets: 18 },
  health: {
    level: "error",
    issues: [
      {
        code: "pipeline_stale",
        level: "error",
        message: "Picks pipeline last ran 152 days ago",
        params: { since: "2026-05-12T06:23:24Z" }
      },
      {
        code: "settle_overdue",
        level: "warn",
        message: "18 bets unsettled",
        params: { count: 18, since: "2026-05-14T19:30:00Z" }
      }
    ]
  }
};

export async function stubShell(page: Page, ops: unknown = OPS_STATUS_OK) {
  await stubJson(page, "**/api/backend/ops/status", ops);
}
