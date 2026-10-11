# UX overhaul + MLflow registry ("Phase C-lite") — design

**Status:** Approved for implementation (autonomous session, 2026-10-11)
**Branch:** `claude/ux-audit-mlflow`, stacked on PR #13 (`claude/epic-saha-1c8754`)
**Inputs:** 8-lens UI/UX audit (IA, data honesty, states, a11y, responsive, i18n, visual system, perf) with adversarial verification; 6 codebase maps; live screenshot sweep (desktop/mobile, en/cs).

## 1. Why

The dashboard looks deliberate but is not yet safe to make decisions from:

- **Fake / mislabelled numbers.** Today's "Model · health" tiles were hard-coded (Brier 0.241, log-loss 0.587, n 1,204); "P&L · trailing 30d" summed the last 10 settled bets of any age; W/L counters could never be non-zero.
- **Invisible staleness.** The picks pipeline last ran ~152 days ago with 18 bets unsettled, while the global LED said green "ok" (it only meant a `COUNT(*)` succeeded).
- **Empty defaults.** Models/Explore default to *live · last 90 days* → blank pages while 14 backtest runs exist.
- **Context loss.** Live vs backtest is a hidden `?source=` toggle some pages ignore; filters drop the selected run; drill-downs silently switch to live data.
- **Raw identifiers.** Event ids instead of team names, `HOME_DRAW_AWAY:FULL_TIME` vs `1X2_FT`, results as `0/1`, CLV `0.0000` where CLV is undefined.
- **Match page has no model layer** (and opening it scraped FlashScore upstream), 40+ odds tables with no navigation, mislabelled "Odds · live lookup".
- **Foundation bugs.** Tailwind alpha modifiers generated no CSS (near-white `#e5e7eb` row borders), 13px root shrank every rem, base styles lost the cascade, `--text-faint` at 2.2:1 contrast, `<html lang="en">` on Czech pages, locale toggle was a no-op, `npm run build` failed (useSearchParams without Suspense).
- **MLflow (PR #13) is write-only and fragile:** top-level `import mlflow` can crash the API, hard-coded `experiments/1` links (picks is experiment 2), default port 5000 = macOS AirPlay, a sticky process-wide disable latch, MLflow's own retries can stall the backtest queue for minutes, backtests log KPIs but no model while training runs log a model but no KPIs (so there is no basis for promotion), and serving still loads pickles by hard-coded folder name from `$APP_ML_MODELS_DIR` — which on this machine doesn't exist, so **no trained model is served at all**.

## 2. Decisions

1. **Keep the stack and the terminal identity; rebuild the IA and every page on a hardened design system.** (Visual-system audit verdict: refine, don't rebuild the tokens/library; IA + pages are rebuilt.)
2. **Information architecture by operator job**, not by data source:

   | Section | Routes | Job |
   |---|---|---|
   | Today | `/today` | Is everything OK? What's on today? |
   | Matches | `/matches`, `/matches/[eventId]` | Browse stored matches; one match = header, model view, picks, odds by market, stats |
   | Performance | `/performance`, `/performance/explore`, `/models/[name]` | Live paper-trading results: leaderboard, bet explorer, per-model page |
   | Model lab | `/lab/backtests`, `/lab/backtests/[id]`, `/lab/compare`, `/lab/experiments`, `/lab/registry` | Backtest research, MLflow experiments, model registry / promotion |
   | Data ops | `/ops` | Pipeline freshness, refresh-all, bulk scrape jobs, MLflow + served-model status |
   | Settings | `/settings` | Language, density, scanlines |

   Old URLs redirect (`/odds`→`/matches`, `/jobs`→`/ops`, `/picks*`→`/performance*`, `/picks/health`→`/ops`, `/picks/model/:n`→`/models/:n`).
   **Data scope is part of the route:** Performance = live paper trading only; backtest results live under Model lab (run detail / compare). No hidden `source` toggles.
3. **MLflow is backend-owned and surfaced in-app.** This deliberately changes PR #13's rule "the frontend never calls MLflow": the *browser* still never talks to MLflow; FastAPI exposes `/mlflow/*` (status, runs, registry, promote) and returns ready-made UI deep links. MLflow UI stays the power-user surface.
4. **Registry is the serving gate (Phase C-lite).** Registered models `picks-<model>`; alias `@champion` is what `/predict`, `/picks/upcoming` and refresh-now record picks with; `@challenger` is tracked. Fallback to `$APP_ML_MODELS_DIR` when the registry is unreachable or has no champion. Promotion from the app requires a confirmation that shows the evidence (backtest KPIs, n, window).
5. **Honest metrics.** Undefined ≠ zero: backtest CLV is `null`; `n = 0` ⇒ ROI/hit rate/Brier `null`; small samples are flagged (n < 30) rather than crowned "best".

## 3. Design-system rules (all pages)

- Import primitives only from `@/components/ui` and charts only from `@/components/charts`. No `text-[NNpx]`, no hex colors, no inline `letterSpacing`. Type scale: `text-label|meta|body|lead|title|stat|hero`. Colors: tokens (`text-text-dim`, `bg-surface`, `border-border-strong`, `text-pos/neg/warn/info/accent`), alpha modifiers allowed.
- Every page renders exactly one `PageHeader` (h1, breadcrumbs, description, actions, meta "as of …").
- Every data view handles loading (Skeleton), error (Callout with retry, scoped to the panel — never blank the page), and empty (EmptyState that names the filter/window and offers the fixing action).
- Every number goes through `useLocale().fmt` (`pct`, `units`, `signed`, `odds`, `int`, `dateTime`, `relative`); every enum through `lib/labels` (`modelLabel`, `marketLabel`, `selectionLabel`, `StateBadge`). Never print raw event ids where teams are available — render "Home – Away" linking to `routes.match()`.
- Every KPI shows its window and `n`; small n uses `Stat caution=` / `SampleSize`.
- All copy in the namespace catalog for that page (`src/lib/i18n/{en,cs}/<ns>.ts`), Czech with diacritics; plurals via `tp()` with `.one/.few/.many/.other` keys.
- Data via React Query (`@tanstack/react-query`); FastAPI via `backendGet/backendSend` (`/api/backend/*` allowlisted proxy); Prisma-backed Next routes via `appGet`. No `useEffect`+`fetch`. No polling unless something is running (then 2–5 s, stop when done).
- URL is the state for filters/sort/selection (`useSearchParams` + `router.replace`), so back/forward and sharing work.
- Responsive: tables use `hideBelow` column priorities; nothing may overflow a 390px viewport (`document.documentElement.scrollWidth <= 390`).
- Keyboard: everything reachable by Tab; tables with `rowHref` (real links); consequential actions via `ConfirmDialog`.
- Expensive upstream actions (bulk scrape, refresh-all, "fetch live odds") always confirm and state the cost.

## 4. Backend contracts

### 4.1 `GET /ops/status` → `OpsStatus` (`frontend/src/types/ops.ts`)
Cheap (no `COUNT(*)` over snapshot tables; DB size via `os.stat`). Health rules: `pipeline_stale` warn if last `paper_bets.recommended_at` > 36 h, error if > 7 d (params `{since}`); `pipeline_never` if none; `settle_overdue` warn if pending bets with kickoff older than 6 h (params `{count, since}`); `no_models_loaded` warn when no trained model is served; `live_odds_stale` warn if latest `live_odds_snapshots.fetched_at` > 24 h and fixtures exist; `mlflow_unreachable` warn when enabled but unreachable. `level` = max issue level.

### 4.2 Events (stored data only — never scrapes)
- `GET /events/{event_id}` → `{ event_id, home_team, away_team, sport, country, competition, competition_path, start_time_utc, status, status_detail, outcome, score: {home, away} | null, is_terminal, latest_odds_fetched_at, latest_stats_fetched_at, odds_snapshot_count, stats_snapshot_count }` (from `match_event_summaries` + latest stats snapshot; 404 if unknown).
- `GET /events/{event_id}/odds` → latest stored odds snapshot mapped to the existing `OddsResponse` shape plus `{ fetched_at, served_from: "stored" }` (404 if none).
- `GET /events/{event_id}/stats` → latest stored stats snapshot mapped to `MatchStatsResponse` plus `{ fetched_at }` (404 if none).
- `GET /events/{event_id}/picks` → `{ live: PaperBetRow[], backtest: BacktestBetRow & { run_label, model }[] }`.

### 4.3 Picks (additive changes)
- History rows (live **and** backtest) gain `home_team`, `away_team`, `competition`, `country`, `kickoff` (joined from `match_event_summaries`/`upcoming_fixtures`); backtest rows gain `run_id`.
- `/picks/history` accepts the same filters as `/picks/stats` (date_from/date_to/model/market/competition/country/selection/edge_min/edge_max/price_min/price_max/status) and returns `count` = total matching rows (not page size), newest first, with `offset`.
- Stats rows: `hit_rate`, `roi`, `brier`, `mean_clv` are `null` when `n == 0`; backtest `mean_clv` is `null` (CLV is undefined when bets are priced at the close). Backtest stats accept `group_by=run_id` and expose `run_id` + `run_label`.
- `/picks/summary` gains `last_recommended_at`, `last_settled_at`, `oldest_pending_kickoff`.

### 4.4 Backtests
- `POST /backtest/runs/{id}/cancel` (queued → cancelled immediately; running → cancelled at next checkpoint).
- Run summary gains `n_train_events` and `mlflow_ui_url` (backend-built deep link, null if not logged).
- A completed run is never flipped to failed by a post-completion (MLflow) error.

### 4.5 MLflow (`frontend/src/types/mlflow.ts`)
- `GET /mlflow/status` → `MlflowStatus`. `GET /mlflow/runs?purpose=&model=&limit=` → `MlflowRunsResponse`. `GET /mlflow/runs/{run_id}` → `MlflowRun`.
- `GET /mlflow/registry` → `RegistryResponse` (one entry per `picks-<model>` with versions, aliases, source-run metrics, `servable`).
- `POST /mlflow/registry/register {run_id, alias?, description?}` → registers the run's `picks_model` as a new version of `picks-<model_name>`; optional alias.
- `POST /mlflow/registry/{model_name}/aliases {version, alias}`; `DELETE /mlflow/registry/{model_name}/aliases/{alias}`. Setting `champion` reloads serving.
- `POST /ml/reload` → reload served models; returns the `ServedModel[]` list.
- All endpoints degrade: when MLflow is disabled/unreachable they return `status` with `reachable=false` and empty lists (HTTP 200), mutations return 503 with a clear message.

## 5. MLflow Phase C-lite (backend)

- `tracking.py`: lazy `mlflow` import; fast reachability probe (`GET {uri}/health`, 2 s timeout) cached with a 60 s TTL instead of a permanent latch; `MLFLOW_HTTP_REQUEST_MAX_RETRIES`/`TIMEOUT` kept small for our calls; only connectivity failures disable (temporarily), data errors are logged and the run is marked failed; batch logging (`log_params`/`log_metrics`/`set_tags`); default URI `http://127.0.0.1:5050`; experiment id resolved once and exposed; hyper-parameters logged again via an `extra_params` slot.
- Backtest runs log the fitted model as `picks_model` (pyfunc, `code_paths=["app"]`, signature) so they can be registered; analytic baselines log their tiny wrapper.
- Metric honesty: `sharpe_adjusted` computed on unit-stake returns (as the spec defines); `mean_clv` not logged when undefined; tag `clv_available`.
- `registry.py`: register/alias/list helpers with `picks-<model>` naming; `servable` = logistic/hgb/hgb_pca (Dixon–Coles stays on the file path until its artifact bundles team rates — documented limitation).
- `serving.py`: resolve `@champion` per model from the registry, fall back to `$APP_ML_MODELS_DIR`; record `source/version/run_id/loaded_at`; `reload_models()` used by `/ml/reload` and alias changes; `paper_bets.model_version` (nullable) records which version produced each pick.
- `scripts/backfill_mlflow_backtests.py`: log pre-Phase-A `backtest_runs` (metrics/params only, `purpose=backfill`) and write back `mlflow_run_id`.
- `Makefile`/docs: port 5050, `uvx --from 'mlflow>=3,<4' mlflow server …` (isolated from the broken system interpreter), proxied artifacts (`--artifacts-destination`).

## 6. Page requirements (abridged; agents get the full audit)

- **Today:** HealthBanner (full); KPI strip with real windows (P&L 30 d with n, open picks, pending/overdue, last refresh); today's slate → falls back to "next 72 h" with team names, edge filter (SegmentedControl), links to matches; served-model card (champion versions, source registry/file); recent settled with names and links; no fabricated numbers.
- **Matches:** URL-state filters (search, sport, country, league, status, has picks), sortable, team names, responsive; `?id=` style event lookup resolved via search.
- **Match detail:** header (teams, competition, kick-off, status, score, provenance "stored · as of …"), model view (predictions per model: model prob, market prob, edge, fair odds; best price), picks/bets on the event (live + backtest) linking to model/run, odds by market with tab/index navigation, implied prob + margin row, best-price only with ≥2 books, ≤1.01 treated as suspended; stats; snapshot strip; explicit confirmed "fetch latest from FlashScore" only for non-terminal events.
- **Performance:** live leaderboard (n, hit rate ± CI, ROI ± CI, P&L, CLV, Brier, drawdown) with min-n gating, date window anchored to data (default all-time when the last 90 d are empty), P&L over time (time axis), ROI by competition (HBar), CLV distribution; explore with filters applied to every panel incl. the table, edge-decile chart, paginated bets table with teams.
- **Model page:** KPIs (live), calibration with n per bucket, bets list, registry versions (champion/challenger + metrics + MLflow links), backtest runs for this model (links).
- **Lab · Backtests:** runs table (label, model, train/test window, status/stage, bets, ROI, hit, Brier, Sharpe-adj, MLflow link), multi-select → compare, run dialog (model, train/test window, min edge, Kelly, force bets) with validation, cancel/delete with confirm, polling only while active. **Run detail:** header, KPI strip, reliability, cumulative P&L, bets table with teams, MLflow link, "Register model" action. **Compare:** per-run columns/series, warns when windows/scopes differ.
- **Lab · Experiments:** MLflow runs table (purpose, model, train_until, key metrics, registered versions, links), filters, status callout when MLflow is down with how to start it.
- **Lab · Registry:** per model: champion/challenger cards with evidence, version list, promote/demote with ConfirmDialog stating the serving consequence, served-model status.
- **Data ops:** pipeline stage table with freshness thresholds, refresh-all with confirm + progress, bulk jobs (status incl. completed_with_errors, error summary with expandable detail, confirm before start, no fake KILL), MLflow + served models status, backtest queue.
- **Settings:** language, density, scanlines, (shared store; applies immediately).

## 7. Out of scope (reported, not fixed here)

ML-pipeline correctness bugs found during the audit — Dixon–Coles walk-forward predicts uniform 1/3 for every test event (all 306 bets have p=0.333); the uniform fallback places draw bets (all 17 live 1X2 paper bets are draws because upcoming fixtures lack home/away prices); live closing line frozen before kick-off; archive closing builder takes an arbitrary (likely earliest) snapshot; Brier/log-loss computed only on placed bets; full-Kelly live vs ¼-Kelly backtest staking — and the stale VPS-migration PR #9. These change model semantics and get their own tasks.
