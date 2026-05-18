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
- `src.py` — single-file FastAPI app. All routes (`/odds/{event_id}`, `/match-stats/{event_id}`, `/storage/...`, `/bulk-scrape/jobs`) live here. Singletons (`OddsClient`, `MatchStatsClient`, `SnapshotStore`, `BulkScrapeManager`) are wired via `@lru_cache` factories and exposed as FastAPI dependencies.
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

ML / scripts workflow runs against system Python (the documented venv lacks pytest and ML deps). Use `PYTHONPATH=. APP_STORAGE_DB_PATH=<path> python3 scripts/<name>.py` — both env vars are required from a worktree. The real DB lives at `<repo-root>/data/flashscore_snapshots.sqlite3`, not in the worktree.

### ML pipeline (`app/ml/` + `scripts/`)

- Tables: `bet_labels`, `closing_odds`, `team_elo_history`, `paper_bets`, `upcoming_fixtures`, `live_odds_snapshots`, `match_event_summaries` (legacy, NOT in Prisma). Several are read by many modules but written only by Phase 0/1 backfill scripts or the live `SnapshotStore` — if a table looks stale, check who writes to it before adding reads.
- `FOOTBALL_PHASE1_SCOPE` in `app/ml/labels.py` is the canonical (country, competition) allowlist for labels + closing_odds backfill. FlashScore reports stage variants (e.g. `Chance Liga - Relegation Group`) as distinct strings — add explicitly.
- Two odds sources: `odds_snapshots` (archive, rich JSON, `build_closing_odds`, written on every `GET /odds/{event_id}` and frozen once terminal) vs `live_odds_snapshots` (live pipeline, flat per-bookmaker rows, `build_closing_from_live` fallback, written by `LiveOddsScheduler.run_once()`). The frontend "Snapshots" strip on the match detail page reads `live_odds_snapshots` via `/api/snapshots/[eventId]` — NOT `odds_snapshots`.
- Case-folding mismatch: `upcoming_fixtures.country` is lowercase, `match_event_summaries.country` is UPPERCASE. Scope predicates use uppercase.
- Settler pipeline: `record_picks` → `build_phase1` (labels + closing_odds + elo) → `settle_paper_bets`. Skipping any step zeroes the dashboard.
- New ML training scripts should call `app.ml.tracking.log_training_run` (not the deprecated `app.ml.training.log_run_to_mlflow`) for canonical-schema MLflow logging.

### Frontend

```bash
cd frontend
npm install
npm run dev                       # :3000, expects backend on :8000
npm run lint
npm run build
npm run test:e2e                  # Playwright; stubs FastAPI, no backend needed
npm run test:e2e -- tests/e2e/odds.spec.ts   # single test file
npm run prisma:deploy             # apply migrations
npm run prisma:generate           # regenerate client after schema changes
```

When changing `frontend/prisma/schema.prisma`, run `prisma:migrate` in dev to create a migration, then `prisma:generate`. Because FastAPI writes the same DB directly, schema changes need parallel updates in `app/services/storage.py`.

## Conventions worth knowing

- The repo has both a top-level `package-lock.json` and `frontend/package-lock.json` — node tooling lives in `frontend/`; the root lockfile is incidental.
- Localization is en/cs via a custom typed catalog in `frontend/src/lib/i18n.ts` exposed by `useLocale()` from `frontend/src/contexts/LocaleContext` — NOT `next-intl` despite the dependency being present.
- `host.json` deliberately sets `routePrefix: ""` so Azure Functions does not prepend `/api` — keep this if you add routes.
- Next.js 14 typedRoutes can't statically validate dynamic query-string paths — for `<Link href={`...?tab=${tab}`}>` use `as unknown as Parameters<typeof Link>[0]["href"]` cast (see `frontend/src/components/picks/PicksLayout.tsx`).
- visx package is `@visx/stats` (plural) for ViolinPlot/BoxPlot — `@visx/stat` (singular) does not exist on npm.
- Prisma 7 requires `npx prisma generate` before `npm run build` or the client import fails. The CI workflow needs this step.
- `useEffect`/`useMemo` deps split arrays via `.join(",")` to keep primitives in dep arrays — ESLint warns; the warnings are sanctioned. Don't "fix" them by adding the arrays directly.
- Transient `ENOENT: _ssgManifest.js` during `npm run build` in a worktree is a known race; safe to ignore if "Compiled successfully" printed first.
- Playwright cross-browser: firefox/webkit binaries aren't installed locally by default (`npx playwright install` to fix). Tests routinely chromium-only on dev machines.
- `competitionRoot()` in `frontend/src/lib/competition.ts` folds stage suffixes ("NHL - Play Offs" → "NHL"). Use it anywhere league names are grouped/displayed; pairs with `FOOTBALL_PHASE1_SCOPE` in `app/ml/labels.py` which is the canonical allowlist for the unfolded variants.
- Terminal charts in `frontend/src/components/terminal/charts/` size to their parent via `useElementWidth` (ResizeObserver hook in `frontend/src/hooks/useElementWidth.ts`) — don't hard-pin `width={720}`. Pass an explicit `width` prop only for fixed-size fixtures.
- Next.js dev keeps compile errors in its log buffer after the file becomes valid again — `preview_console_logs(level:error)` can show stale syntax errors even after a successful render. Trust the rendered DOM (or `preview_eval`) over the error buffer when they disagree.
