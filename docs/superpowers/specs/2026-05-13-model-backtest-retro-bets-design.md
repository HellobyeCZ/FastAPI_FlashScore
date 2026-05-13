# Model backtest: retrospective bets with anti-leakage guarantees

**Status:** Draft
**Date:** 2026-05-13
**Branch:** `feat/model-backtest-retro-bets`

## Problem

The Models overview shows performance based on `paper_bets` — picks recorded
live by `scripts/record_picks.py` and settled by `scripts/settle_paper_bets.py`.
There is no way to ask "how would this model have performed if it had been
running over the last N months?" without manually running
`scripts/run_backtest.py` and reading flat files in `reports/`.

We need a one-click way to backtest any registered model over historical data,
have the results land in the existing dashboards alongside live picks
(visually distinguished), and guarantee no leakage of post-kickoff information
into the model's inputs.

## Goals

- One-click "Run Backtest" from the Models tab using sensible defaults, plus
  an "Advanced…" disclosure that exposes the same knobs the CLI harness has.
- Retrospective bets persist in SQLite, queryable by the same aggregation
  layer that powers the Models tab today, with an explicit `origin` flag so
  live and retro stats can never silently mix.
- Strict anti-leakage: every retro bet's feature vector is built from data
  with timestamps strictly before that event's kickoff, and this is auditable
  per bet after the fact.
- Async execution: runs may take minutes; the UI must not block.

## Non-goals

- No new ML model. Only models already registered in `app/ml/models.py`.
- No improvement to CLV computation. Archive-only CLV ≈ 0 stays as-is.
- No automatic re-runs on data refresh — manual trigger only.
- No multi-run comparison UI in v1. The data-source picker selects at most
  one backtest run alongside live picks.
- No backtest of non-football scopes in v1. `FOOTBALL_PHASE1_SCOPE` is the
  default; overriding scope is allowed via the API but not exposed in UI.

## Architecture

Three new pieces plus one schema change plus one targeted bug fix in
`app/ml/features.py`.

### 1. Storage — two new tables

Schema is owned by Prisma (`frontend/prisma/schema.prisma`); FastAPI writes
through a parallel update to `app/services/storage.py`.

```sql
CREATE TABLE backtest_runs (
  id              TEXT PRIMARY KEY,              -- uuid4
  label           TEXT NOT NULL,                 -- defaults to <model>_<utc-iso>
  model           TEXT NOT NULL,                 -- registry key from app.ml.models
  train_until     TEXT NOT NULL,                 -- ISO-8601 UTC
  test_until      TEXT,                          -- ISO-8601 UTC or NULL
  min_edge        REAL NOT NULL,
  kelly_fraction  REAL NOT NULL,
  force_bets      INTEGER NOT NULL,              -- 0/1
  scope_json      TEXT NOT NULL,                 -- JSON [[country, competition], ...]
  status          TEXT NOT NULL,                 -- queued|running|completed|failed|cancelled
  created_at      TEXT NOT NULL,                 -- ISO-8601 UTC
  started_at      TEXT,
  finished_at     TEXT,
  error           TEXT,                          -- traceback summary on failure
  -- Mirrored summary metrics from BacktestReport for fast leaderboard reads.
  -- NULL while status != 'completed'.
  test_events     INTEGER,
  total_bets      INTEGER,
  hit_rate        REAL,
  roi             REAL,
  mean_clv        REAL,
  brier           REAL,
  log_loss        REAL,
  max_drawdown    REAL,
  reliability_json TEXT                          -- JSON [{lower,upper,n,mean_pred,hit_rate}, ...]
);

CREATE TABLE backtest_bets (
  run_id          TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  bet_ts          TEXT NOT NULL,                 -- as_of_ts used for feature lookup (audit)
  kickoff_ts      TEXT NOT NULL,                 -- event kickoff (audit)
  market          TEXT NOT NULL,                 -- '1x2_ft' for v1
  selection       TEXT NOT NULL,                 -- 'home'|'draw'|'away'
  price_taken     REAL NOT NULL,
  closing_price   REAL NOT NULL,
  model_prob      REAL NOT NULL,
  implied_prob    REAL NOT NULL,
  devigged_prob   REAL NOT NULL,
  edge            REAL NOT NULL,
  stake_kelly_fraction REAL NOT NULL,
  result          REAL NOT NULL,                 -- 1.0 win / 0.0 loss
  pnl             REAL NOT NULL,
  clv             REAL,
  PRIMARY KEY (run_id, event_id, market, selection)
);
CREATE INDEX idx_backtest_bets_run   ON backtest_bets(run_id);
CREATE INDEX idx_backtest_bets_event ON backtest_bets(event_id);
```

`bet_ts` and `kickoff_ts` together are the per-row leakage audit: a SQL query
can verify `bet_ts < kickoff_ts` for every retro bet at any time.

### 2. `BacktestManager` — background worker

New module `app/services/backtest_manager.py`, modelled directly on the
existing `BulkScrapeManager`:

- Singleton, wired via `@lru_cache` factory in `src.py` and bound to the
  FastAPI startup/shutdown lifecycle.
- Maintains an `asyncio.Queue` of run ids; one worker task pulls and executes.
- `create_run(params) -> run_id`: insert `queued` row, enqueue id, return id.
- `cancel_run(run_id)`: marks `cancelled` if still queued; if running, sets a
  flag the worker checks between events (best-effort, not preemptive).
- Worker calls the existing `app.ml.backtest.run_backtest()` — the harness
  is **not** modified. The worker just persists the result.

The structural leakage checks live here, run once before `run_backtest()`:

- `train_until` parses as ISO-8601.
- `model` resolves through `app.ml.models.get()` (registry only — no
  arbitrary callables accepted via the API).
- For each `BetRecord` returned, assert `bet_ts < kickoff_ts` before
  insertion. A violation marks the run `failed` with an explicit error.

### 3. FastAPI routes

All under the existing `src.py` (consistent with the current single-file
convention). Auth/CORS follows the existing pattern.

| Method | Path                          | Purpose                                          |
|--------|-------------------------------|--------------------------------------------------|
| POST   | `/backtest/runs`              | Create a run (queued). Body = run params.        |
| GET    | `/backtest/runs`              | List runs with status + summary metrics.         |
| GET    | `/backtest/runs/{id}`         | Single run incl. reliability buckets.            |
| GET    | `/backtest/runs/{id}/bets`    | Paginated bet rows for drill-in/export.          |
| DELETE | `/backtest/runs/{id}`         | Cancel if running, delete rows.                  |

POST body schema (all fields except `model` and `train_until` optional, with
defaults matching `scripts/run_backtest.py`):

```json
{
  "model": "market_implied",
  "train_until": "2024-08-01T00:00:00Z",
  "test_until": null,
  "min_edge": 0.02,
  "kelly_fraction": 0.25,
  "force_bets": false,
  "label": null,
  "scope": null
}
```

`scope: null` means "use `FOOTBALL_PHASE1_SCOPE`". `label: null` means
"`<model>_<utc-iso>`".

The Next.js frontend mirrors these at `frontend/src/app/api/backtest/...`
following the existing `odds`/`match-stats` mirror pattern.

### 4. Models tab UI

`frontend/src/components/picks/tabs/ModelsTab.tsx` and a few new components:

- **`<DataSourcePicker />`** — pill at the top of the tab. Values:
  `live` (default) | `backtest` | `both`. URL-encoded as `source=...` and
  `run=<id>`. When `backtest` or `both`, the user picks which run from a
  dropdown of completed runs (default: latest completed).
- **`<RunBacktestButton />`** — single click POSTs with defaults, shows a
  toast and opens the runs panel.
- **`<BacktestAdvancedDialog />`** — modal form: model dropdown
  (populated from `/backtest/models` — a trivial new endpoint listing
  registry keys), `train_until` date picker, optional `test_until`,
  `min_edge` slider (0–0.10), `kelly_fraction` slider (0–1), `force_bets`
  checkbox, optional label. Submits via the same POST.
- **`<BacktestRunsPanel />`** — collapsible panel listing recent runs with
  status, timing, and summary metrics. Polls `GET /backtest/runs` every 5s
  while any run is `queued`/`running`. Delete button per row.

All existing chart fetches in `api-picks.ts` (`fetchStats`, `fetchHistory`,
calibration, etc.) gain optional `source` + `run_id` params. The backend
`paper_trade_stats.py` queries gain a sibling that reads from
`backtest_bets` joined to `backtest_runs`, switched by these params. The
aggregation SQL is structurally identical — a table-name swap. For
`source=both`, results are unioned with an extra `origin` column so the
charts can color-code (`live` vs `backtest`).

### 5. Leakage fix in `app/ml/features.py`

`_pre_match_elo` currently has a fallback (lines 139–148) that returns the
team's latest `post_elo` ordered by `start_time_utc DESC` — with no
`as_of_ts` filter. In practice this is not hit when `build_phase1` has
populated `team_elo_history` over the test window (the direct lookup by
`event_id` succeeds), so we are not currently leaking. But this is only
true by coincidence; the function's contract is point-in-time correctness,
and the surrounding helpers (`_team_form`, `_team_days_rest`) all filter by
`as_of_ts`.

Fix: add `WHERE start_time_utc < ? AND event_id != ?` to the fallback,
plumbing `as_of_ts` and `event_id` (excluding the test event explicitly,
defense-in-depth). This is a small change with a unit test, and it makes
the backtester's anti-leakage promise structurally robust to future
features that touch unseen events.

## Data flow

```
User clicks "Run Backtest"
   → POST /backtest/runs
   → BacktestManager.create_run() inserts queued row, enqueues
   → returns {id}
UI:
   → toast "Backtest queued"
   → BacktestRunsPanel polls /backtest/runs every 5s

Worker:
   → dequeues id
   → marks status=running, started_at=now
   → structural leakage checks (train_until parses, model in registry)
   → calls run_backtest(model, scope, train_until, ...)
     → for each test event: as_of_ts = kickoff - CLOSING_LINE_BUFFER
     → get_features(event_id, as_of_ts) — only pre-as_of_ts data
     → model(features) → {selection: prob}
     → emit BetRecord where edge >= min_edge
   → per-bet assert bet_ts < kickoff_ts
   → bulk insert backtest_bets
   → update backtest_runs row with summary metrics + reliability_json
   → status=completed, finished_at=now

UI on next poll:
   → run shows completed
   → user selects run in DataSourcePicker
   → charts re-fetch with source=backtest&run=<id>
   → paper_trade_stats sibling reads from backtest_bets
```

## Testing

- **Storage unit**: round-trip `backtest_runs` and `backtest_bets`, foreign
  key cascade on run delete, status transitions.
- **`BacktestManager` unit**: lifecycle (queued → running → completed),
  failure path captures traceback into `error`, cancellation marks queued
  runs cancelled.
- **End-to-end integration**: against a fixture DB seeded with Phase 1
  data, `POST /backtest/runs` → poll → assert `completed`, and the bet
  rows match `run_backtest()` called directly with the same params (byte-
  for-byte on `event_id, market, selection, edge, pnl`).
- **Leakage regression**: for every row produced by an integration run,
  assert `bet_ts < kickoff_ts`.
- **Elo fallback fix**: unit test that constructs a `team_elo_history`
  with rows after `as_of_ts` and verifies `_pre_match_elo` does not return
  them.
- **Stats sibling**: aggregation parity test — for a backtest run with
  N known bets, the new SQL returns the same shape/values as the live
  aggregation would for an equivalent `paper_bets` fixture.

## Migration

1. `frontend/prisma/schema.prisma`: add the two models. `npm run prisma:migrate`
   to generate `frontend/prisma/migrations/<ts>_backtest_tables/`. Commit
   the SQL migration.
2. `app/services/storage.py`: add parallel `CREATE TABLE IF NOT EXISTS`
   statements in `SnapshotStore` initialization so FastAPI deployments
   without Prisma still get the tables.
3. `npm run prisma:generate` to refresh the `@prisma/client` types. CI
   already runs this before `npm run build` per the existing convention
   noted in `CLAUDE.md` — no extra workflow step needed.

## Open questions

None blocking. Two items deferred to v2 if usage warrants:

- Multi-run overlay on the same chart (e.g. compare three `min_edge`
  settings of the same model).
- Scope picker in the UI (currently API-only).
