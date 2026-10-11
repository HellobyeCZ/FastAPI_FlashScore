import { expect, test, type Page, type Request } from "@playwright/test";
import { OPS_STATUS_OK, stubJson, stubShell } from "./fixtures/stub";

/*
 * Model lab: backtests list, run detail, compare, MLflow experiments and the
 * model registry. Every /api request is stubbed; anything unexpected gets a
 * 404 and is recorded so a test can fail on it.
 */

const SHOTS = process.env.LAB_SHOTS_DIR;

const LOGISTIC = "0fe2009fdb43494683fedb86956c2d2a";
const LOGISTIC_SHORT = "3ec625f4a8b14f6c9d2e7a1b5c3d9e0f";
const DIXON = "2e4d319e6c4b4c1f8a7d2b9e0f3a5c71";
const BASELINE = "a1aeda64b7e04d2a9c1f5e8b3d6a2c49";
const FAILED = "e6441c53f0a94b6e8d2c7b1a5f3e9d08";
const RUNNING = "5d1c8a2e9b7f4e3d8c6a1b0f2e4d7c95";
const QUEUED = "7b3e0d9c1a5f4b2e8d6c3a9f1e7b5d20";
const MLFLOW_RUN = "69106395b400429da2d05176533eed0e";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const SCOPE: [string, string][] = [
  ["ENGLAND", "Premier League"],
  ["ENGLAND", "Championship"],
  ["SPAIN", "LaLiga"],
  ["GERMANY", "Bundesliga"],
  ["ITALY", "Serie A"],
  ["FRANCE", "Ligue 1"],
  ["CZECH REPUBLIC", "Chance Liga"]
];

function summary(over: Record<string, unknown>) {
  return {
    label: "",
    created_at: "2026-05-18T21:27:18Z",
    train_until: "2024-08-01T00:00:00Z",
    test_until: null,
    started_at: "2026-05-18T21:27:18Z",
    finished_at: "2026-05-18T21:28:22Z",
    error: null,
    test_events: 2686,
    total_bets: 0,
    hit_rate: null,
    roi: null,
    mean_clv: null,
    brier: null,
    log_loss: null,
    max_drawdown: null,
    stage: null,
    market_spec: "football_1x2_ft",
    sharpe_adjusted: null,
    mlflow_run_id: null,
    n_train_events: null,
    mlflow_ui_url: null,
    ...over
  };
}

const RUNS = [
  summary({
    id: RUNNING,
    label: "logistic_2026-10-11T11:58:00.000000Z",
    model: "logistic",
    status: "running",
    stage: "training",
    created_at: minutesAgo(3),
    started_at: minutesAgo(2),
    finished_at: null,
    train_until: "2025-01-01T00:00:00Z",
    test_events: null,
    total_bets: null
  }),
  summary({
    id: QUEUED,
    label: "hgb_pca_2026-10-11T11:59:00.000000Z",
    model: "hgb_pca",
    status: "queued",
    created_at: minutesAgo(1),
    started_at: null,
    finished_at: null,
    test_events: null,
    total_bets: null
  }),
  summary({
    id: LOGISTIC,
    label: "logistic_2026-05-18T21:27:18.358543Z",
    model: "logistic",
    status: "completed",
    total_bets: 2756,
    hit_rate: 0.2979,
    roi: -0.0932,
    mean_clv: 0.0,
    brier: 0.1919,
    log_loss: 0.5688,
    max_drawdown: 6.2237,
    sharpe_adjusted: -0.0539,
    mlflow_run_id: MLFLOW_RUN,
    n_train_events: 12563,
    mlflow_ui_url: `http://127.0.0.1:5050/#/experiments/2/runs/${MLFLOW_RUN}`
  }),
  summary({
    id: FAILED,
    label: "hgb_2026-05-18T20:57:29.608095Z",
    model: "hgb",
    status: "failed",
    created_at: "2026-05-18T20:57:29Z",
    error: "unknown model 'hgb'. registered: ['market_implied', 'vig_included', 'dixon_coles', 'logistic']",
    test_events: null,
    total_bets: null
  }),
  summary({
    id: BASELINE,
    label: "market_implied_2026-05-15T20:33:51.478610Z",
    model: "market_implied",
    status: "completed",
    created_at: "2026-05-15T20:33:51Z",
    train_until: "2026-02-14T21:33:51Z",
    test_events: 412,
    total_bets: 0,
    hit_rate: 0.0,
    roi: 0.0,
    brier: 0.0,
    log_loss: 0.0,
    max_drawdown: 0.0,
    sharpe_adjusted: 0.0
  }),
  summary({
    id: DIXON,
    label: "Dixon–Coles · Aug 2024 smoke test",
    model: "dixon_coles",
    status: "completed",
    created_at: "2026-05-14T07:44:19Z",
    test_until: "2024-09-01T00:00:00Z",
    test_events: 306,
    total_bets: 306,
    hit_rate: 0.281,
    roi: -0.3146,
    brier: 0.2222,
    log_loss: 0.6365,
    max_drawdown: 1.9,
    sharpe_adjusted: -0.212
  }),
  summary({
    id: LOGISTIC_SHORT,
    label: "logistic_2026-05-14T07:43:09.132446Z",
    model: "logistic",
    status: "completed",
    created_at: "2026-05-14T07:43:09Z",
    test_until: "2024-09-01T00:00:00Z",
    test_events: 306,
    total_bets: 173,
    hit_rate: 0.3237,
    roi: -0.1124,
    brier: 0.2011,
    log_loss: 0.5934,
    max_drawdown: 0.81,
    sharpe_adjusted: -0.0811
  })
];

const RELIABILITY = [
  { lower: 0.0, upper: 0.1, n: 5, mean_pred: 0.0779, hit_rate: 0.0 },
  { lower: 0.1, upper: 0.2, n: 265, mean_pred: 0.1615, hit_rate: 0.0906 },
  { lower: 0.2, upper: 0.3, n: 767, mean_pred: 0.2622, hit_rate: 0.2099 },
  { lower: 0.3, upper: 0.4, n: 812, mean_pred: 0.3474, hit_rate: 0.25 },
  { lower: 0.4, upper: 0.5, n: 362, mean_pred: 0.4569, hit_rate: 0.3674 },
  { lower: 0.5, upper: 0.6, n: 235, mean_pred: 0.5446, hit_rate: 0.4383 },
  { lower: 0.6, upper: 0.7, n: 228, mean_pred: 0.6609, hit_rate: 0.5746 },
  { lower: 0.7, upper: 0.8, n: 29, mean_pred: 0.7334, hit_rate: 0.7931 },
  { lower: 0.8, upper: 0.9, n: 33, mean_pred: 0.8366, hit_rate: 0.8182 },
  { lower: 0.9, upper: 1.0, n: 20, mean_pred: 0.9542, hit_rate: 0.8 }
];

function detail(id: string) {
  const run = RUNS.find((r) => r.id === id);
  if (!run) return null;
  return {
    ...run,
    min_edge: 0.02,
    kelly_fraction: 0.25,
    force_bets: false,
    scope: id === DIXON ? SCOPE.slice(0, 3) : SCOPE,
    reliability_buckets: run.status === "completed" && (run.total_bets ?? 0) > 0 ? RELIABILITY : []
  };
}

const TEAMS: [string, string, string][] = [
  ["Arsenal", "Chelsea", "football/england/premier-league"],
  ["Real Betis", "Sevilla", "football/spain/laliga"],
  ["Sparta Praha", "Slavia Praha", "football/czech-republic/chance-liga"],
  ["Bayern München", "Borussia Dortmund", "football/germany/bundesliga"]
];

function historyRows(runId: string, offset: number, limit: number) {
  return Array.from({ length: Math.min(limit, 12) }, (_, i) => {
    const k = offset + i;
    const [home, away, competition] = TEAMS[k % TEAMS.length];
    const won = k % 3 === 0;
    const price = [2.1, 3.45, 1.85, 4.2][k % 4];
    const stake = 0.012;
    return {
      id: `${runId}_ev${k}_HOME_DRAW_AWAY:FULL_TIME_home`,
      event_id: `ev${String(k).padStart(6, "0")}`,
      market: "HOME_DRAW_AWAY:FULL_TIME",
      selection: ["home", "draw", "away"][k % 3],
      recommended_at: `2024-08-${String(2 + (k % 27)).padStart(2, "0")}T17:55:00Z`,
      price_at_recommendation: price,
      model_prob: 0.38 + (k % 5) * 0.03,
      edge: 0.021 + (k % 4) * 0.008,
      result: won ? 1.0 : 0.0,
      pnl: won ? stake * (price - 1) : -stake,
      clv: null,
      status: "settled",
      model: "logistic",
      run_id: runId,
      home_team: home,
      away_team: away,
      competition,
      country: "",
      kickoff: `2024-08-${String(2 + (k % 27)).padStart(2, "0")}T18:00:00Z`
    };
  });
}

function dayRows(runId: string) {
  const run = RUNS.find((r) => r.id === runId);
  const start = Date.UTC(2024, 7, 2);
  const days = runId === LOGISTIC ? 60 : 28;
  const drift = runId === DIXON ? -0.03 : runId === LOGISTIC_SHORT ? -0.012 : -0.006;
  return Array.from({ length: days }, (_, i) => {
    const wobble = Math.sin(i * 1.7 + (runId === DIXON ? 1 : 0)) * 0.05;
    return {
      day: new Date(start + i * 3 * 86_400_000).toISOString().slice(0, 10),
      n: 4 + (i % 5),
      pnl_total: drift + wobble,
      model: run?.model ?? "logistic"
    };
  });
}

const MLFLOW_OK = OPS_STATUS_OK.mlflow;
const MLFLOW_DOWN = {
  ...MLFLOW_OK,
  reachable: false,
  experiment_id: null,
  error: "HTTPConnectionPool(host='127.0.0.1', port=5050): Max retries exceeded",
  checked_at: "2026-10-11T12:00:00Z"
};

const MLFLOW_RUNS = [
  {
    run_id: MLFLOW_RUN,
    run_name: "bt_logistic_2024-08-01",
    status: "FINISHED",
    start_time: "2026-05-18T21:27:18Z",
    end_time: "2026-05-18T21:28:22Z",
    purpose: "walk_forward_backtest",
    model_name: "logistic",
    train_until: "2024-08-01T00:00:00Z",
    test_until: null,
    backtest_run_id: LOGISTIC,
    has_model: true,
    params: { n_train_events: "12563", min_edge: "0.02", kelly_fraction: "0.25" },
    metrics: { n_bets: 2756, hit_rate: 0.2979, roi: -0.0932, brier: 0.1919, log_loss: 0.5688, sharpe_adjusted: -0.0539 },
    registered_versions: [{ name: "picks-logistic", version: "3" }],
    ui_url: `http://127.0.0.1:5050/#/experiments/2/runs/${MLFLOW_RUN}`
  },
  {
    run_id: "b2c4e6a8d0f24b6d8e0a2c4e6f8a0b2c",
    run_name: "bt_logistic_2024-08-01_short",
    status: "FINISHED",
    start_time: "2026-05-14T07:43:09Z",
    end_time: "2026-05-14T07:43:51Z",
    purpose: "walk_forward_backtest",
    model_name: "logistic",
    train_until: "2024-08-01T00:00:00Z",
    test_until: "2024-09-01T00:00:00Z",
    backtest_run_id: LOGISTIC_SHORT,
    has_model: true,
    params: { n_train_events: "12563" },
    metrics: { n_bets: 173, roi: -0.1124, brier: 0.2011, sharpe_adjusted: -0.0811 },
    registered_versions: [{ name: "picks-logistic", version: "4" }],
    ui_url: "http://127.0.0.1:5050/#/experiments/2/runs/b2c4e6a8d0f24b6d8e0a2c4e6f8a0b2c"
  },
  {
    run_id: "c9e1a3b5d7f94c1e3a5b7d9f1c3e5a7b",
    run_name: "train_logistic_2024-08-01",
    status: "FINISHED",
    start_time: "2026-05-12T09:10:00Z",
    end_time: "2026-05-12T09:12:30Z",
    purpose: "offline_training",
    model_name: "logistic",
    train_until: "2024-08-01T00:00:00Z",
    test_until: null,
    backtest_run_id: null,
    has_model: true,
    params: { n_train_events: "12563" },
    metrics: { uncal_brier: 0.2051, cal_brier: 0.1987, uncal_log_loss: 0.6012, cal_log_loss: 0.5871, cal_roi: -0.041 },
    registered_versions: [],
    ui_url: "http://127.0.0.1:5050/#/experiments/2/runs/c9e1a3b5d7f94c1e3a5b7d9f1c3e5a7b"
  },
  {
    run_id: "d4f6a8c0e2b44d6f8a0c2e4b6d8f0a2c",
    run_name: "backfill_dixon_coles_2024-08-01",
    status: "FINISHED",
    start_time: "2026-10-10T08:00:00Z",
    end_time: "2026-10-10T08:00:02Z",
    purpose: "backfill",
    model_name: "dixon_coles",
    train_until: "2024-08-01T00:00:00Z",
    test_until: "2024-09-01T00:00:00Z",
    backtest_run_id: DIXON,
    has_model: false,
    params: {},
    metrics: { n_bets: 306, roi: -0.3146, brier: 0.2222, sharpe_adjusted: -0.212 },
    registered_versions: [],
    ui_url: "http://127.0.0.1:5050/#/experiments/2/runs/d4f6a8c0e2b44d6f8a0c2e4b6d8f0a2c"
  }
];

function version(v: string, over: Record<string, unknown>) {
  return {
    version: v,
    run_id: MLFLOW_RUN,
    created_at: "2026-10-09T10:00:00Z",
    aliases: [],
    status: "READY",
    description: null,
    metrics: {},
    purpose: "walk_forward_backtest",
    train_until: "2024-08-01T00:00:00Z",
    ui_url: `http://127.0.0.1:5050/#/models/picks-logistic/versions/${v}`,
    ...over
  };
}

const REGISTRY = {
  status: MLFLOW_OK,
  models: [
    {
      name: "picks-logistic",
      model_name: "logistic",
      aliases: { champion: "3" },
      servable: true,
      ui_url: "http://127.0.0.1:5050/#/models/picks-logistic",
      versions: [
        version("3", {
          aliases: ["champion"],
          created_at: "2026-10-09T10:00:00Z",
          metrics: { roi: -0.0932, sharpe_adjusted: -0.0539, n_bets: 2756, brier: 0.1919 }
        }),
        version("4", {
          run_id: "b2c4e6a8d0f24b6d8e0a2c4e6f8a0b2c",
          created_at: "2026-10-10T16:00:00Z",
          metrics: { roi: -0.1124, sharpe_adjusted: -0.0811, n_bets: 173, brier: 0.2011 }
        }),
        version("2", {
          run_id: "c9e1a3b5d7f94c1e3a5b7d9f1c3e5a7b",
          created_at: "2026-10-01T09:00:00Z",
          purpose: "offline_training",
          metrics: { cal_brier: 0.1987 }
        })
      ]
    },
    {
      name: "picks-dixon_coles",
      model_name: "dixon_coles",
      aliases: {},
      servable: false,
      ui_url: "http://127.0.0.1:5050/#/models/picks-dixon_coles",
      versions: [
        version("1", {
          run_id: "d4f6a8c0e2b44d6f8a0c2e4b6d8f0a2c",
          purpose: "backfill",
          metrics: { roi: -0.3146, sharpe_adjusted: -0.212, n_bets: 306, brier: 0.2222 },
          ui_url: "http://127.0.0.1:5050/#/models/picks-dixon_coles/versions/1"
        })
      ]
    }
  ]
};

type Recorded = { method: string; path: string; search: URLSearchParams; body: unknown };

type LabStubs = {
  runs?: unknown[];
  mlflowStatus?: typeof MLFLOW_OK;
  registry?: unknown;
};

/**
 * Stubs the shell plus every lab endpoint. Returns the list of API calls
 * (mutations carry their JSON body) and of requests nothing handled.
 */
async function stubLab(page: Page, opts: LabStubs = {}) {
  const calls: Recorded[] = [];
  const unhandled: string[] = [];
  const runs = opts.runs ?? RUNS;

  // Lowest priority: anything not stubbed below is a test bug.
  await page.route("**/api/**", (route) => {
    unhandled.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"not stubbed"}' });
  });
  await stubShell(page);

  await page.route(/\/api\/backend\/(backtest|picks|mlflow)\//, async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/backend/", "");
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path, search: url.searchParams, body });
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const runMatch = path.match(/^backtest\/runs\/([^/]+)(\/cancel)?$/);

    if (path === "backtest/runs" && method === "GET") return json({ items: runs });
    if (path === "backtest/runs" && method === "POST") return json({ id: "f00dfeedcafe4b1e9d2c3a4b5c6d7e8f" });
    if (path === "backtest/models") {
      return json({
        items: [
          { name: "market_implied", kind: "analytic" },
          { name: "vig_included", kind: "analytic" },
          { name: "dixon_coles", kind: "trainable" },
          { name: "hgb", kind: "trainable" },
          { name: "hgb_pca", kind: "trainable" },
          { name: "logistic", kind: "trainable" }
        ]
      });
    }
    if (runMatch && runMatch[2] && method === "POST") return json({ ok: true, status: "cancelled" });
    if (runMatch && method === "DELETE") return json({ ok: true });
    if (runMatch && method === "GET") {
      const id = decodeURIComponent(runMatch[1]);
      if (id === "f00dfeedcafe4b1e9d2c3a4b5c6d7e8f") {
        return json({
          ...detail(QUEUED)!,
          id,
          label: "Logistic · EPL only",
          model: "logistic",
          created_at: minutesAgo(0)
        });
      }
      const d = detail(id);
      return d ? json(d) : json({ detail: "run not found" }, 404);
    }
    if (path === "picks/history") {
      const runId = url.searchParams.get("run_id") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const total = RUNS.find((r) => r.id === runId)?.total_bets ?? 0;
      return json({ count: total, rows: historyRows(runId, offset, limit) });
    }
    if (path === "picks/stats") return json({ group_by: ["day"], filters: {}, rows: dayRows(url.searchParams.get("run_id") ?? "") });
    if (path === "mlflow/runs") {
      const status = opts.mlflowStatus ?? MLFLOW_OK;
      const purpose = url.searchParams.get("purpose");
      const model = url.searchParams.get("model");
      const reachable = status.enabled && status.reachable;
      return json({
        status,
        experiment_id: reachable ? "2" : null,
        experiment_ui_url: reachable ? "http://127.0.0.1:5050/#/experiments/2" : null,
        runs: reachable
          ? MLFLOW_RUNS.filter((r) => (!purpose || r.purpose === purpose) && (!model || r.model_name === model))
          : []
      });
    }
    if (path === "mlflow/registry" && method === "GET") return json(opts.registry ?? REGISTRY);
    if (path === "mlflow/registry/register" && method === "POST") {
      return json({ name: "picks-logistic", version: "5", alias: (body as { alias?: string })?.alias ?? null, reloaded: false });
    }
    const alias = path.match(/^mlflow\/registry\/([^/]+)\/aliases(?:\/([^/]+))?$/);
    if (alias && method === "POST") {
      const b = body as { version: string; alias: string };
      return json({ name: "picks-logistic", version: b.version, alias: b.alias, reloaded: b.alias === "champion" });
    }
    if (alias && method === "DELETE") return json({ ok: true });
    unhandled.push(`${method} ${req.url()}`);
    return json({ detail: "not stubbed" }, 404);
  });

  return { calls, unhandled };
}

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });

test.describe("lab · backtests", () => {
  test("lists runs honestly and compares two selected runs", async ({ page }) => {
    const { unhandled } = await stubLab(page);
    await page.goto("/en/lab/backtests");
    await expect(h1(page)).toHaveText(/Backtests/);

    const table = page.getByRole("table", { name: /Backtest runs/ });
    // Auto-generated labels become model + window.
    await expect(table.getByText("Logistic · Aug 1, 2024 → open")).toBeVisible();
    // A 0-bet run shows "0 bets" and an undefined ROI, not 0.0%.
    const baselineRow = table.getByRole("row").filter({ hasText: "Market implied" });
    await expect(baselineRow.getByText("0 bets")).toBeVisible();
    await expect(baselineRow.getByText("0.0%")).toHaveCount(0);
    await expect(table.getByText(/unknown model 'hgb'/)).toBeVisible();

    // Selection lives in the URL, so the box flips once the route updates.
    const pickLogistic = page.getByRole("checkbox", { name: /Select Logistic · Aug 1, 2024 → open/ });
    await pickLogistic.click();
    await expect(pickLogistic).toBeChecked();
    const pickDixon = page.getByRole("checkbox", { name: /Select Dixon–Coles · Aug 2024 smoke test/ });
    await pickDixon.click();
    await expect(pickDixon).toBeChecked();
    await expect(page).toHaveURL(new RegExp(`selected=${LOGISTIC}%2C${DIXON}|selected=${LOGISTIC},${DIXON}`));
    // Active runs can't be compared.
    await expect(page.getByRole("checkbox", { name: /Select Logistic · Jan 1, 2025 → open/ })).toBeDisabled();

    await page.getByRole("link", { name: "Compare selected (2)" }).click();
    await expect(page).toHaveURL(/\/en\/lab\/compare\?ids=/);
    await expect(h1(page)).toContainText("Compare backtests");
    await expect(page.getByText("Not directly comparable")).toBeVisible();
    await expect(page.getByText(/train\/test window/)).toBeVisible();
    const cmp = page.getByRole("table", { name: /compared metric by metric/ });
    await expect(cmp.getByRole("link", { name: "Dixon–Coles · Aug 2024 smoke test" })).toHaveAttribute(
      "href",
      `/en/lab/backtests/${DIXON}`
    );
    await expect(cmp.getByRole("row", { name: /CLV/ }).getByText("—")).toHaveCount(2);
    expect(unhandled).toEqual([]);
  });

  test("new backtest dialog validates and queues the run", async ({ page }) => {
    const { calls, unhandled } = await stubLab(page);
    await page.goto("/en/lab/backtests");
    await page.getByRole("button", { name: "New backtest" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New backtest" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Queue backtest" }).click();
    await expect(dialog.getByText("Choose a model.")).toBeVisible();
    await expect(dialog.getByText("Enter the training cut-off date.")).toBeVisible();

    await dialog.getByLabel("Model").selectOption("market_implied");
    await expect(dialog.getByText("This baseline will place 0 bets")).toBeVisible();
    await dialog.getByLabel("Model").selectOption("logistic");
    await dialog.getByLabel("Train until").fill("2024-08-01");
    await dialog.getByLabel("Test until").fill("2024-07-01");
    await expect(dialog.getByText("Test until must be after train until.")).toBeVisible();
    await dialog.getByLabel("Test until").fill("2024-12-31");
    await dialog.getByLabel("Min edge (pp)").fill("3");
    await dialog.getByLabel("Kelly fraction").fill("0.5");
    await dialog.getByLabel("Force bets").check();
    await dialog.getByLabel("Label").fill("Logistic · EPL only");
    await dialog.getByRole("button", { name: "Queue backtest" }).click();

    await expect(page).toHaveURL(/\/en\/lab\/backtests\/f00dfeedcafe4b1e9d2c3a4b5c6d7e8f$/);
    await expect(h1(page)).toContainText("Logistic · EPL only");
    await expect(page.getByText("Waiting in the queue").first()).toBeVisible();
    const post = calls.find((c) => c.method === "POST" && c.path === "backtest/runs");
    expect(post?.body).toEqual({
      model: "logistic",
      train_until: "2024-08-01T00:00:00Z",
      test_until: "2024-12-31T00:00:00Z",
      min_edge: 0.03,
      kelly_fraction: 0.5,
      force_bets: true,
      label: "Logistic · EPL only"
    });
    expect(unhandled).toEqual([]);
  });

  test("cancel and delete go through a confirmation", async ({ page }) => {
    const { calls } = await stubLab(page);
    await page.goto("/en/lab/backtests");

    await page.getByRole("button", { name: /Cancel run Logistic · Jan 1, 2025 → open/ }).click();
    const cancel = page.getByRole("dialog", { name: "Cancel this backtest?" });
    await expect(cancel).toContainText("next checkpoint");
    await cancel.getByRole("button", { name: "Yes, cancel run" }).click();
    await expect(cancel).toBeHidden();
    expect(calls.some((c) => c.method === "POST" && c.path === `backtest/runs/${RUNNING}/cancel`)).toBe(true);

    await page.getByRole("button", { name: /Delete run Dixon–Coles · Aug 2024 smoke test/ }).click();
    const del = page.getByRole("dialog", { name: "Delete this backtest?" });
    await expect(del).toContainText("306 bets");
    await del.getByRole("button", { name: "Cancel" }).click();
    await expect(del).toBeHidden();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: /Delete run Dixon–Coles · Aug 2024 smoke test/ }).click();
    await page.getByRole("dialog", { name: "Delete this backtest?" }).getByRole("button", { name: "Delete run" }).click();
    await expect.poll(() => calls.some((c) => c.method === "DELETE" && c.path === `backtest/runs/${DIXON}`)).toBe(true);
  });

  test("empty and error states keep the page chrome", async ({ page }) => {
    await stubLab(page, { runs: [] });
    await page.goto("/en/lab/backtests");
    await expect(page.getByText("No backtests yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "New backtest" })).toHaveCount(2);

    const other = await page.context().newPage();
    await stubLab(other);
    // Registered last, so it wins over the lab stubs for the runs list only.
    await stubJson(other, /\/api\/backend\/backtest\/runs(\?.*)?$/, { detail: "database is locked" }, 500);
    await other.goto("/en/lab/backtests");
    await expect(h1(other)).toHaveText(/Backtests/);
    await expect(other.getByText("Couldn't load backtest runs")).toBeVisible({ timeout: 15_000 });
    await expect(other.getByText("database is locked")).toBeVisible();
    await expect(other.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test.describe("lab · run detail", () => {
  test("shows settings, honest KPIs, bets with teams and registers the model", async ({ page }) => {
    const { calls, unhandled } = await stubLab(page);
    await page.goto(`/en/lab/backtests/${LOGISTIC}`);
    await expect(h1(page)).toContainText("Logistic · Aug 1, 2024 → open");

    // CLV is undefined for backtests: an em dash plus the reason, never 0.
    const clv = page.getByText("Undefined: bets are priced at the close");
    await expect(clv).toBeVisible();
    await expect(clv.locator("..")).toContainText("—");
    await expect(page.getByText("n = 2,756").first()).toBeVisible();
    await expect(page.getByText("7 competitions")).toBeVisible();

    const bets = page.getByRole("table", { name: "Bets placed by this backtest run" });
    const first = bets.getByRole("link", { name: /Arsenal – Chelsea/ }).first();
    await expect(first).toHaveAttribute("href", "/en/matches/ev000000");
    await expect(page.getByText("1–50 of 2,756")).toBeVisible();

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText("51–100 of 2,756")).toBeVisible();

    await page.getByRole("button", { name: "Register model…" }).click();
    const dialog = page.getByRole("dialog", { name: "Register a new version of picks-logistic?" });
    await expect(dialog).toContainText("Live picks don't change");
    await dialog.getByLabel("Also set as challenger").check();
    await dialog.getByRole("button", { name: "Register" }).click();
    await expect(page.getByText("Registered picks-logistic v5")).toBeVisible();
    const reg = calls.find((c) => c.path === "mlflow/registry/register");
    expect(reg?.body).toEqual({ run_id: MLFLOW_RUN, alias: "challenger" });
    expect(unhandled).toEqual([]);
  });

  test("failed and zero-bet runs explain themselves; unknown ids show an empty state", async ({ page }) => {
    await stubLab(page);
    await page.goto(`/en/lab/backtests/${FAILED}`);
    await expect(page.getByText("This run failed")).toBeVisible();
    await expect(page.getByText(/unknown model 'hgb'/)).toBeVisible();

    await page.goto(`/en/lab/backtests/${BASELINE}`);
    await expect(page.getByText("No bets were placed")).toBeVisible();
    await page.getByRole("button", { name: "Re-run with force bets" }).click();
    const dialog = page.getByRole("dialog", { name: "New backtest" });
    await expect(dialog.getByLabel("Force bets")).toBeChecked();
    await expect(dialog.getByLabel("Model")).toHaveValue("market_implied");

    await page.goto("/en/lab/backtests/doesnotexist");
    await expect(h1(page)).toContainText("Backtest not found");
    await expect(page.getByRole("link", { name: "Back to backtests" })).toBeVisible();
  });
});

test.describe("lab · experiments", () => {
  test("lists MLflow runs with purpose filter in the URL", async ({ page }) => {
    const { calls } = await stubLab(page);
    await page.goto("/en/lab/experiments");
    await expect(h1(page)).toContainText("Experiments");
    const table = page.getByRole("table", { name: /MLflow runs/ });
    await expect(table.getByText("bt_logistic_2024-08-01", { exact: true })).toBeVisible();
    await expect(table.getByText("v3")).toBeVisible();

    await page.getByRole("radio", { name: "Training" }).click();
    await expect(page).toHaveURL(/purpose=offline_training/);
    await expect(page.getByRole("columnheader", { name: /Brier \(cal\)/ })).toBeVisible();
    await expect(table.getByText("0.1987")).toBeVisible();
    expect(calls.some((c) => c.path === "mlflow/runs" && c.search.get("purpose") === "offline_training")).toBe(true);
  });

  test("explains how to start MLflow when it is down", async ({ page }) => {
    await stubLab(page, { mlflowStatus: MLFLOW_DOWN });
    await page.goto("/en/lab/experiments");
    await expect(h1(page)).toContainText("Experiments");
    await expect(page.getByText("MLflow is unreachable")).toBeVisible();
    await expect(page.getByText("make mlflow")).toBeVisible();
    await expect(page.getByText(/http:\/\/127\.0\.0\.1:5050/).first()).toBeVisible();
    await expect(page.getByText("No runs to show while MLflow is unavailable")).toBeVisible();
  });
});

test.describe("lab · registry", () => {
  test("promotion states the serving consequence and flags weak evidence", async ({ page }) => {
    const { calls, unhandled } = await stubLab(page);
    await page.goto("/en/lab/registry");
    await expect(h1(page)).toContainText("Registry");
    await expect(page.getByText("In sync").first()).toBeVisible();
    await expect(page.getByText("Not served from the registry")).toBeVisible();

    await page.getByRole("button", { name: "Make v4 the Champion" }).click();
    const dialog = page.getByRole("dialog", { name: /Make v4 the Champion of picks-logistic/ });
    await expect(dialog).toContainText("Live picks will be recorded with picks-logistic v4; currently v3.");
    await expect(dialog).toContainText("Only 173 bets of evidence");
    await expect(dialog).toContainText("worse than the champion v3");
    await dialog.getByRole("button", { name: "Make champion" }).click();
    await expect(dialog).toBeHidden();
    const post = calls.find((c) => c.method === "POST" && c.path === "mlflow/registry/logistic/aliases");
    expect(post?.body).toEqual({ version: "4", alias: "champion" });

    await page.getByRole("button", { name: "Remove Champion from v3" }).click();
    const remove = page.getByRole("dialog", { name: "Remove Champion from v3?" });
    await expect(remove).toContainText("fall back to its file artifact");
    await remove.getByRole("button", { name: "Remove champion" }).click();
    await expect.poll(() => calls.some((c) => c.method === "DELETE" && c.path === "mlflow/registry/logistic/aliases/champion")).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test("highlights serving that doesn't match the champion", async ({ page }) => {
    await stubLab(page);
    await stubShell(page, {
      ...OPS_STATUS_OK,
      models: [{ ...OPS_STATUS_OK.models[0], source: "file", version: null }, ...OPS_STATUS_OK.models.slice(1)]
    });
    await page.goto("/en/lab/registry");
    await expect(page.getByText("Serving is out of sync with the registry")).toBeVisible();
    await expect(page.getByText("Mismatch").first()).toBeVisible();
  });

  test("empty registry explains the path to a champion", async ({ page }) => {
    await stubLab(page, { registry: { status: MLFLOW_OK, models: [] } });
    await page.goto("/en/lab/registry");
    await expect(page.getByText("No registered models yet")).toBeVisible();
    await expect(page.getByText("On the run page, register the model it logged.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to backtests" })).toHaveAttribute("href", "/en/lab/backtests");
  });
});

const PAGES = [
  { name: "backtests", path: "lab/backtests", en: /Backtests/, cs: /Backtesty/ },
  { name: "detail", path: `lab/backtests/${LOGISTIC}`, en: /Logistic · Aug 1, 2024 → open/, cs: /Logistická regrese · 1\. 8\. 2024 → dosud/ },
  { name: "compare", path: `lab/compare?ids=${LOGISTIC},${DIXON},${LOGISTIC_SHORT}`, en: /Compare backtests/, cs: /Porovnání backtestů/ },
  { name: "experiments", path: "lab/experiments", en: /Experiments/, cs: /Experimenty/ },
  { name: "registry", path: "lab/registry", en: /Registry/, cs: /Registr/ }
];

test.describe("lab · locale and layout", () => {
  test("Czech locale renders translated headings", async ({ page }) => {
    await stubLab(page);
    for (const p of PAGES) {
      await page.goto(`/cs/${p.path}`);
      await expect(h1(page)).toHaveText(p.cs);
    }
    await page.goto("/cs/lab/backtests");
    await expect(page.getByRole("button", { name: "Nový backtest" })).toBeVisible();
    await expect(page.getByText("0 sázek")).toBeVisible();
  });

  test("no horizontal overflow on phones", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "mobile viewport only");
    await stubLab(page);
    for (const p of PAGES) {
      await page.goto(`/en/${p.path}`);
      await expect(h1(page)).toHaveText(p.en);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${p.name} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });

  test("screenshots", async ({ page }, info) => {
    test.skip(!SHOTS || info.project.name !== "chromium", "set LAB_SHOTS_DIR to capture screenshots");
    test.setTimeout(240_000);
    await stubLab(page);
    for (const [vw, vh, tag] of [
      [1440, 900, "desktop"],
      [390, 844, "mobile"]
    ] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      for (const locale of ["en", "cs"] as const) {
        for (const p of PAGES) {
          await page.goto(`/${locale}/${p.path}`);
          await expect(h1(page)).toHaveText(p[locale]);
          await page.waitForTimeout(600);
          await page.screenshot({ path: `${SHOTS}/${tag}-${locale}-${p.name}.png`, fullPage: true });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/lab/backtests");
    await page.getByRole("button", { name: "New backtest" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Queue backtest" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/desktop-en-dialog-new.png` });
    await page.keyboard.press("Escape");
    await page.goto("/en/lab/registry");
    await page.getByRole("button", { name: "Make v4 the Champion" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/desktop-en-dialog-promote.png` });
    await stubLab(page, { mlflowStatus: MLFLOW_DOWN });
    await page.goto("/en/lab/experiments");
    await expect(page.getByText("MLflow is unreachable")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-en-experiments-down.png`, fullPage: true });
  });
});
