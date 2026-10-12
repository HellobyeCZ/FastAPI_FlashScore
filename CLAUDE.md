# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Two cooperating apps share one SQLite database:

- **FastAPI backend** (`src.py` + `app/`) — proxies/scrapes FlashScore odds and match-stats. Deployable as a standalone ASGI service (`uvicorn`) or as an Azure Functions HTTP trigger via `function_app.py` (which wraps the FastAPI app in `func.AsgiFunctionApp`). `host.json` sets an empty route prefix so Functions routes match FastAPI paths verbatim.
- **Next.js 14 frontend** (`frontend/`) — App Router dashboard using React Query, `next-intl` (en/cs), Tailwind, and Playwright e2e tests. Has its own API routes under `frontend/src/app/api/` that mirror the backend (`odds`, `match-stats`, `bulk-scrape`, `scraped-matches`).

### Snapshot storage — the key cross-app contract

Both apps read/write the **same SQLite file**. Schema is owned by Prisma in `frontend/prisma/schema.prisma` (tables `odds_snapshots`, `match_stats_snapshots`); FastAPI writes to it directly via `app/services/storage.py` (`SnapshotStore`). The two paths must agree:

- FastAPI: `APP_STORAGE_DB_PATH` (default `data/flashscore_snapshots.sqlite3`)
- Frontend/Prisma: `DATABASE_URL` in `frontend/.env`, configured via `frontend/prisma.config.ts` (Prisma 7 — datasource URL lives in `prisma.config.ts`, **not** in `schema.prisma`).

`match_stats_snapshots` rows carry an `is_terminal` flag. When a terminal snapshot exists for an event, the backend short-circuits scraping: `/match-stats/{event_id}` returns the latest terminal row, and `/odds/{event_id}` is served from the latest stored odds. This is load-bearing for cost/rate-limit reasons — preserve it when modifying those endpoints.

### FastAPI internals (`app/`)

- `app/config.py` — Pydantic settings with `APP_` env prefix. Builds the upstream odds URL (`build_odds_url`) and stats feed URL (`build_match_stats_url`). Tries `pydantic-settings` (v2) and falls back to Pydantic v1 `BaseSettings`.
- `app/services/odds_client.py`, `stats_client.py` — async httpx clients for the two upstream sources.
- `app/services/{odds,match_stats}.py` — `map_*_payload` functions transforming upstream JSON into the response schemas under `app/schemas/`.
- `app/services/bulk_scrape.py` — `BulkScrapeManager` runs background scraping jobs; lifecycle is bound to FastAPI startup/shutdown events in `src.py`.
- `src.py` — the FastAPI app. Core routes (`/odds/{event_id}`, `/match-stats/{event_id}`, `/storage/...`, `/bulk-scrape/jobs`, `/backtest/*`, `/picks/*`, `/predict/*`) live here; newer areas are routers in `app/routes/` (`/ops/status`, `/events/*`, `/mlflow/*`) included at the bottom of `src.py`. Singletons (`OddsClient`, `MatchStatsClient`, `SnapshotStore`, `BulkScrapeManager`) are wired via `@lru_cache` factories and exposed as FastAPI dependencies.
- Handlers that run synchronous SQLite/ML work (`/picks/*`, `/predict/*`, `/events/*`, `/ops/status`) are plain `def` endpoints so FastAPI runs them in its threadpool; keep new blocking handlers that way (or offload with `asyncio.to_thread`, as `SnapshotStore` does). Read paths resolve the DB per call via `app.ml.db.connect(read_only=True)` rather than the cached `SnapshotStore`.
- `/events/{event_id}[/odds|/stats|/picks]` serve stored data only and never scrape; `/odds` and `/match-stats` still scrape non-terminal events. `/ops/status` must stay cheap — never `COUNT(*)` the snapshot tables there.
- Optional Azure Monitor / OpenTelemetry telemetry initializes only if `azure-monitor-opentelemetry-exporter` is available and a connection string is configured; code uses `_NoopTracer`/`_NoopMeter` fallbacks otherwise — don't assume tracer/meter calls require the real SDK.

## Commands

### Backend

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn src:app --reload          # FastAPI on :8000 (frontend expects this)
func start                        # Azure Functions emulator on :7071 (uses function_app.py)
```

Local Functions config goes in `local.settings.json` (gitignored). Backend env vars use `APP_` prefix (see `.env.local.example`).

ML / scripts / tests need a Python with `requirements.txt` + `pytest pytest-asyncio`. On the dev Mac the **system python3 has a broken mlflow** (mlflow 1.30 on top of protobuf 6 → `ImportError` on `import mlflow`), so use a venv: `uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt pytest pytest-asyncio`. Run as `PYTHONPATH=. APP_STORAGE_DB_PATH=<path> .venv/bin/python scripts/<name>.py` — both env vars are required from a worktree. The real DB lives at `<repo-root>/data/flashscore_snapshots.sqlite3`, not in the worktree. The API itself boots without mlflow (imports are lazy); `APP_MLFLOW_DISABLED=1` turns tracking off (the test suite sets it).

### ML pipeline (`app/ml/` + `scripts/`)

- Tables: `bet_labels`, `closing_odds`, `team_elo_history`, `paper_bets`, `upcoming_fixtures`, `live_odds_snapshots`, `match_event_summaries`. `paper_bets`, `scrape_jobs` and `scrape_job_events` are FastAPI-only (not in Prisma; Next routes query them with `$queryRaw`). Several are read by many modules but written only by Phase 0/1 backfill scripts or the live `SnapshotStore` — if a table looks stale, check who writes to it before adding reads.
- `FOOTBALL_PHASE1_SCOPE` in `app/ml/labels.py` is the canonical (country, competition) allowlist for labels + closing_odds backfill. FlashScore reports stage variants (e.g. `Chance Liga - Relegation Group`) as distinct strings — add explicitly.
- Two odds sources: `odds_snapshots` (archive, rich JSON, `build_closing_odds`, written on every `GET /odds/{event_id}` and frozen once terminal) vs `live_odds_snapshots` (live pipeline, flat per-bookmaker rows, `build_closing_from_live` fallback, written by `LiveOddsScheduler.run_once()`). The frontend "Snapshots" strip on the match detail page reads `live_odds_snapshots` via `/api/snapshots/[eventId]` — NOT `odds_snapshots`.
- Case-folding mismatch: `upcoming_fixtures.country` is lowercase, `match_event_summaries.country` is UPPERCASE. Scope predicates use uppercase.
- Settler pipeline: `record_picks` → `build_phase1` (labels + closing_odds + elo) → `settle_paper_bets`. Skipping any step zeroes the dashboard.
- `upcoming_fixtures.home_team_raw/away_team_raw` come from FlashScore feed fields `AE` (home) / `AF` (away). Rows scraped before 2026-10 were stored swapped; each discovery refresh rewrites them.
- Backtests price bets at the averaged close, so backtest CLV is undefined: stored as NULL and reported as null — never 0.

### MLflow (tracking + registry)

- `app/ml/tracking.py` is the only MLflow writer (`log_training_run`, `log_backtest_run`); `app/ml/registry.py` owns registered models; `app/routes/mlflow.py` exposes `/mlflow/status|runs|registry`, register/alias mutations and `POST /ml/reload`. The browser never talks to MLflow — the backend returns deep links (`ui_url`, from `APP_MLFLOW_UI_URL`, else the tracking URI).
- Server: `make mlflow` → `http://127.0.0.1:5050` (macOS AirPlay owns :5000). `MLFLOW_TRACKING_URI` defaults to :5050. An unreachable server pauses logging for 60 s (re-probed), never blocks or fails a backtest.
- Every backtest logs its fitted model as `picks_model` (trainable adapters expose it as `fn.trained_model`). Registered names are `picks-<model>`. The `@champion` alias is the serving gate for `logistic`/`hgb`/`hgb_pca` (Dixon–Coles still loads from files); without a champion, serving falls back to `$APP_ML_MODELS_DIR`. Setting/removing a champion hot-reloads serving; `paper_bets.model_version` records the version behind each pick. Promote from the app (Model lab › Registry) or the API.
- An experiment's `artifact_location` is fixed when it is created — a copied `mlflow.db` keeps writing artifacts to the original path. Start a fresh store (or migrate the experiment) when moving it.
- `sharpe_adjusted` is computed on unit-stake returns (price−1 / −1 / 0), independent of Kelly sizing.
- New ML training scripts call `log_training_run(..., extra_params=...)` with their hyper-parameters.

### Frontend

```bash
cd frontend
npm install
npm run dev                       # :3000, proxies FastAPI at ODDS_BACKEND_BASE_URL (default :8000)
npm run lint
npm run build
E2E_PORT=3200 npm run test:e2e   # Playwright (chromium + mobile); stubs every /api call, no backend needed
E2E_PORT=3200 npm run test:e2e -- tests/e2e/matches.spec.ts   # single spec
npm run prisma:deploy             # apply migrations
npm run prisma:generate           # regenerate client after schema changes
```

When changing `frontend/prisma/schema.prisma`, run `prisma:migrate` in dev to create a migration, then `prisma:generate`. Because FastAPI writes the same DB directly, schema changes need parallel updates in `app/services/storage.py`.

## Conventions worth knowing

- The repo has both a top-level `package-lock.json` and `frontend/package-lock.json` — node tooling lives in `frontend/`; the root lockfile is incidental.
- Localization is en/cs via a custom typed catalog split by namespace in `frontend/src/lib/i18n/{en,cs}/<ns>.ts` (keys prefixed `<ns>.`), exposed by `useLocale()` (`t`, plural-aware `tp` with `.one/.few/.many/.other` keys, and `fmt` number/date formatters) — NOT `next-intl`. Each Czech file is typed `Record<keyof typeof en, string>`, so a missing translation fails `tsc`; write Czech with diacritics. The URL locale is the source of truth (`setLocale` navigates; `<html lang>` comes from the `[locale]` root layout).
- Every href goes through `frontend/src/lib/routes.ts` (`routes.*`, `asRoute`) — the one place typedRoutes casts live.
- UI is built from `frontend/src/components/ui` (Button, SegmentedControl, Field/Select, Panel, PageHeader, Stat, Badge/StateBadge, Callout, EmptyState, Dialog/ConfirmDialog, Table, QueryState…). Tokens in `src/styles/tokens.css` are RGB channels (`rgb(var(--x))`; Tailwind alpha modifiers work). Use the named type scale (`text-label|meta|body|lead|title|stat|hero`), never `text-[NNpx]` or hex. Numbers through `fmt`, enums through `lib/labels.ts`; undefined metrics render as an em dash, never 0; show `n` with every KPI.
- Browser → FastAPI calls go through the allowlisted proxy `frontend/src/app/api/backend/[...path]/route.ts` (`backendGet`/`backendSend` in `lib/api/http.ts`). Add a method+regex rule there for every new endpoint. Upstream-scraping endpoints (`/odds/{id}`, `/match-stats/{id}`) are deliberately NOT proxied; only the explicit, confirmed "fetch latest" action uses `/api/odds` and `/api/match-stats`.
- Data fetching is React Query only; filters/sort/selection live in the URL.
- `host.json` deliberately sets `routePrefix: ""` so Azure Functions does not prepend `/api` — keep this if you add routes.
- visx package is `@visx/stats` (plural) for ViolinPlot/BoxPlot — `@visx/stat` (singular) does not exist on npm.
- Prisma 7 requires `npx prisma generate` before `npm run build` or the client import fails. The CI workflow needs this step.
- `useEffect`/`useMemo` deps split arrays via `.join(",")` to keep primitives in dep arrays — ESLint warns; the warnings are sanctioned. Don't "fix" them by adding the arrays directly.
- Transient `ENOENT: _ssgManifest.js` during `npm run build` in a worktree is a known race; safe to ignore if "Compiled successfully" printed first.
- Playwright cross-browser: firefox/webkit binaries aren't installed locally by default (`npx playwright install` to fix). Tests routinely chromium-only on dev machines.
- `competitionRoot()` in `frontend/src/lib/competition.ts` folds stage suffixes ("NHL - Play Offs" → "NHL"). Use it anywhere league names are grouped/displayed; pairs with `FOOTBALL_PHASE1_SCOPE` in `app/ml/labels.py` which is the canonical allowlist for the unfolded variants.
- Charts live in `frontend/src/components/charts` (import from the index only) and size to their parent via `useElementWidth` — don't hard-pin `width`. Model colours come from `modelColor()` in `lib/labels.ts` (a categorical palette kept apart from win/loss colours). Daily series use `CumulativeLineChart xType="time" timeUnit="day"`.
- Playwright: give each worktree its own `E2E_PORT` (another app may hold :3000; `reuseExistingServer` would silently attach to it). API specs that call route handlers directly must use `tests/e2e/fixtures/database.ts` `bindDatabase()` so two specs in one worker don't share a Prisma client.
- Next.js dev keeps compile errors in its log buffer after the file becomes valid again — `preview_console_logs(level:error)` can show stale syntax errors even after a successful render. Trust the rendered DOM (or `preview_eval`) over the error buffer when they disagree.
