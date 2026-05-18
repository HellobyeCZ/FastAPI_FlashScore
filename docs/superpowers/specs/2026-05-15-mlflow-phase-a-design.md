# MLflow Phase A — local tracking discipline

**Status:** Draft
**Date:** 2026-05-15
**Branch:** `claude/epic-saha-1c8754`
**Phase:** A of 4 in the broader MLflow workstream. Phase B (hosted infra), Phase C (Registry + alias-based serving), Phase D (reproducible projects + scheduled retraining) are separate brainstorms.

## Problem

ML/backtest experimentation is currently split across surfaces that don't talk to each other:

- `scripts/train_*.py` already call `app/ml/training.py:log_run_to_mlflow`, but the function logs only training-time metrics (Brier, log-loss on the train/calib slices) and writes to a default `file:./mlruns` directory that nobody serves a UI off of.
- UI-triggered backtests go through `BacktestManager._execute` → `app.ml.backtest.run_backtest`, which does not log to MLflow at all. They write `backtest_runs` + `backtest_bets` rows in SQLite and stop there.
- The frontend's `BacktestRunsPanel` Compare view is the only cross-run aggregation surface, and it's limited to the per-run summary columns we manually materialize on `backtest_runs`.
- The Run-Backtest flow has been reinventing experiment-tracking primitives MLflow handles natively (compare runs, sort by metric, share a URL to a run).

Phase A makes every model fit anywhere in the codebase log to a single local MLflow tracking server with a canonical schema, in the shape an S&P500 ML team would expect: one entry point per run-purpose, controlled params/metrics/tags, packaged model artifacts via `mlflow.pyfunc`, and an explicit cross-link both ways between SQLite and MLflow. Phase A stops short of hosting, registry, alias-based serving, and scheduled retraining — each gets its own phase.

## Goals

- Every UI-triggered backtest and every offline `scripts/train_*.py` invocation logs to MLflow with the same canonical schema. The MLflow UI at `http://127.0.0.1:5000` becomes the canonical cross-run comparison surface.
- One module (`app/ml/tracking.py`) owns all MLflow writes. No MLflow import outside that module + `pyfunc_wrapper.py`.
- A single `mlflow.pyfunc.PythonModel` wrapper (`PicksModelWrapper`) packages all model types — sklearn-native (logistic, hgb, hgb_pca), custom math (dixon_coles), and analytic baselines (market_implied, vig_included) — so Phase C's "serving via Registry" lands without per-model loading code.
- Walk-forward backtests log three new metrics: `return_per_bet`, `rmse_per_bet`, and the custom **Sharpe-adjusted** ratio defined in the project requirements. `sharpe_adjusted` is also persisted to `backtest_runs` so the frontend leaderboard shows it without MLflow access.
- Bidirectional cross-link: SQLite `backtest_runs.mlflow_run_id` ↔ MLflow `tag backtest_run_id`. Frontend renders a clickable link from each backtest row to its MLflow run page.
- Tests pass with MLflow server unavailable. Test suite explicitly disables tracking via `APP_MLFLOW_DISABLED=1`. Backtests continue to complete and write SQLite if the MLflow server is down — one structured warning per process, no further noise.

## Non-goals

- Hosted MLflow on a VPS: Postgres backend, S3-compatible artifact store, nginx + auth, backups. Phase B.
- Model Registry semantics: `mlflow.register_model`, alias-based serving (`models:/<name>@champion`), replacing the `$APP_ML_MODELS_DIR` directory the FastAPI `/predict` path reads from. Phase C.
- `MLproject` files, conda/Docker environment pinning, scheduler-based retraining, auto-promotion gates on KPI thresholds. Phase D.
- Replacing the frontend `BacktestRunsPanel` Compare view with the MLflow UI. The Compare view stays; MLflow is a parallel surface.
- Replacing `backtest_runs` / `backtest_bets` SQLite tables with MLflow queries. They stay. MLflow is the cross-run aggregate surface; SQLite stays the per-bet drilldown surface used by ExploreTab.
- Any change to `scripts/train_hgb.py`'s on-disk-artifact path or to `app/ml/serving.py`'s `$APP_ML_MODELS_DIR` model loading. Both stay until Phase C.
- Multi-user auth on the MLflow server — single-user local, no auth needed.
- Autologging via `mlflow.sklearn.autolog()` — explicit manual `log_param`/`log_metric` calls give us schema discipline that autologging undercuts.

## Architecture

### 1. Local MLflow server

```
mlflow server \
  --backend-store-uri sqlite:///mlflow/mlflow.db \
  --default-artifact-root ./mlflow/artifacts \
  --host 127.0.0.1 --port 5000
```

- Run via `make mlflow`. Foreground process by default; optional `launchd` plist (macOS) and `systemctl --user` unit (Linux) examples in `docs/mlflow.md` for "always on."
- Backend SQLite (`mlflow/mlflow.db`) is indexed and survives multiple concurrent writes — matters when an offline `scripts/train_logistic.py` and a UI-triggered backtest both finish in the same second.
- Artifacts under `mlflow/artifacts/<exp_id>/<run_id>/...`. Plenty of room on a laptop for Phase A; Phase B swaps the artifact root for S3.
- `mlflow/` is gitignored in its entirety.
- Default `MLFLOW_TRACKING_URI` env var: `http://127.0.0.1:5000`. Code falls through to `_DISABLED` mode if unreachable.

### 2. `app/ml/tracking.py` — the single MLflow-write owner

Two public entry points, one shared canonical-params helper, one process-level enable/disable gate. Full code shape:

```python
# Trimmed for the spec — see § 3 of the brainstorm for the full file.
def log_training_run(*, model_name, train_until, market_spec,
                     feature_columns, n_train_events,
                     metrics_uncalibrated, metrics_calibrated,
                     trained_model, artifact_extras=None,
                     git_sha=None) -> Optional[str]: ...

def log_backtest_run(*, report: BacktestReport, model_name, train_until,
                     test_until, market_spec, feature_columns,
                     backtest_run_id: str,
                     git_sha=None) -> Optional[str]: ...
```

Both return `mlflow_run_id` on success, `None` on disabled.

**Canonical params (every run)**: `model_name`, `train_until`, `market_spec_key`, `sport`, `market`, `feature_set_hash`, `n_features`, `n_train_events`, `git_sha`.

**Canonical metrics (training runs)**: `uncal_brier`, `uncal_log_loss`, `cal_brier`, `cal_log_loss` (or any keys the caller passes in the two dicts; `uncal_` / `cal_` prefixes applied automatically).

**Canonical metrics (backtest runs)**: `n_bets`, `hit_rate`, `roi`, `brier`, `log_loss`, `mean_clv`, `max_drawdown`, `return_per_bet`, `rmse_per_bet`, `sharpe_adjusted`.

**Canonical tags**: `purpose` ∈ {`offline_training`, `walk_forward_backtest`, `scheduled_retrain`} (third value reserved for Phase D); `backtest_run_id` (backtest runs only — the SQLite cross-link).

**Experiment name**: `picks` for all model fits. Sub-experiments per sport/market deferred until we have enough variety to need them.

**Process-level enable gate** (a module-level `_DISABLED` global, not thread-local; safe under uvicorn's single-threaded async runtime where MLflow writes happen from the same event loop):

```python
def _ensure_tracking() -> bool:
    global _DISABLED
    if _DISABLED or os.getenv("APP_MLFLOW_DISABLED") == "1":
        return False
    try:
        mlflow.set_tracking_uri(os.getenv("MLFLOW_TRACKING_URI",
                                          "http://127.0.0.1:5000"))
        return True
    except Exception as e:
        _log.warning("mlflow_disabled_for_process", extra={"reason": str(e)})
        _DISABLED = True
        return False
```

### 3. `app/ml/pyfunc_wrapper.py` — one wrapper for every model type

```python
class PicksModelWrapper(PythonModel):
    """One pyfunc for every model in the zoo."""

    def load_context(self, context):
        with open(context.artifacts["model"], "rb") as f:
            self._trained = pickle.load(f)
        self._model_name = Path(context.artifacts["meta"]).read_text().strip()

    def predict(self, context, model_input: pd.DataFrame, params=None):
        from app.ml.models import make_trained_model_fn, get as get_analytic
        if self._model_name in ("market_implied", "vig_included"):
            fn = get_analytic(self._model_name)
        else:
            fn = make_trained_model_fn(self._trained, calibrated=True,
                                       name_prefix=self._model_name)
        rows = []
        for _, row in model_input.iterrows():
            features = {k: row[k] for k in row.index if not k.startswith("market_")}
            market = {k: row[k] for k in row.index if k.startswith("market_")}
            rows.append(fn(features, market))
        return pd.DataFrame(rows, columns=["home", "draw", "away"])


def save_picks_model(*, model_name, trained_model, artifact_extras=None):
    """Pickle the trained model, write meta, log via mlflow.pyfunc.log_model."""
```

- Analytic baselines (`market_implied`, `vig_included`) save `trained_model=None`. Loader handles the None case via `meta.txt` dispatch.
- Input shape: `pd.DataFrame`. Columns matching the model's `feature_columns`, plus a `market_*` block for any model that consumes devigged market probs at predict time.
- Output: `pd.DataFrame[home, draw, away]`, rows aligned to input.
- **Registry registration deferred to Phase C** — `registered_model_name=None` in `log_model` calls for Phase A.

### 4. `BacktestReport` extensions

Additive fields on the dataclass returned by `run_backtest`:

```python
@dataclass(frozen=True)
class BacktestReport:
    # ... existing fields ...
    n_train_events: int            # NEW
    return_per_bet: float          # NEW
    rmse_per_bet: float            # NEW
    sharpe_adjusted: float         # NEW
    reliability_svg: Optional[str] = None  # NEW
```

Computed inside `run_backtest`:

```python
n = len(bet_rows)
pnl_total = sum(b.pnl for b in bet_rows)
return_per_bet = 1.0 + (pnl_total / n) if n else 1.0
rmse_per_bet = math.sqrt(sum(b.pnl ** 2 for b in bet_rows) / n) if n else 0.0
sharpe_adjusted = (return_per_bet - 1.0) / rmse_per_bet if rmse_per_bet > 0 else 0.0
```

**Definition (project-specific Sharpe-adjusted)**:

$$
R_p = \frac{\sum_{i=1}^{n}(y_i \cdot r_i \cdot k_i \cdot b)}{n \cdot b}
$$

with $y_i$ = 1 (every row in `backtest_bets` represents a placed bet by construction), $r_i$ = 1 if won else 0, $k_i$ = price taken, $b$ = unit stake. Per-row return-to-bettor = $r_i \cdot k_i$ for a unit stake; equivalent to $1 + b.\text{pnl}$. So $R_p = 1 + (\text{pnl\_total} / n)$.

$\text{RMSE}_p = \sqrt{\text{mean}(b.\text{pnl}^2)}$ — the spread of per-bet outcomes.

$\text{Sharpe}_{adj} = (R_p - 1) / \text{RMSE}_p$ — the "−1" is the keep-money-in-pocket risk-free baseline.

### 5. SQLite + Prisma migration

Additive, idempotent (same pattern Stage 1 used):

```sql
ALTER TABLE backtest_runs ADD COLUMN sharpe_adjusted REAL;
ALTER TABLE backtest_runs ADD COLUMN mlflow_run_id TEXT;
```

Guarded in `_ensure_backtest_tables` by `PRAGMA table_info` checks. Existing rows: `NULL` for both.

`finalize_run` writes `sharpe_adjusted` from `report.sharpe_adjusted`. New `update_mlflow_run_id(conn, run_id, mlflow_run_id)` helper in `app/ml/backtest_storage.py` is called from `BacktestManager._execute` after `log_backtest_run` returns.

Prisma `schema.prisma` mirrors:

```
sharpeAdjusted Float?  @map("sharpe_adjusted")
mlflowRunId    String? @map("mlflow_run_id")
```

`BacktestRunSummary` / `BacktestRunDetail` Pydantic + TS types gain both fields.

### 6. `BacktestManager._execute` wiring

After the existing `finalize_run(...)` call:

```python
mlflow_run_id = log_backtest_run(
    report=report, model_name=row.model, train_until=row.train_until,
    test_until=row.test_until, market_spec=spec,
    feature_columns=feature_columns,
    backtest_run_id=run_id,
    git_sha=_git_sha_or_none(),
)
if mlflow_run_id is not None:
    update_mlflow_run_id(conn, run_id, mlflow_run_id)
```

`_git_sha_or_none()` returns `subprocess.check_output(["git", "rev-parse", "HEAD"]).strip()` or `None` on error. Same helper used by `tracking.py` for offline training runs.

### 7. Frontend surface

- `BacktestRunsPanel.tsx` adds a column `MLflow`. When `r.mlflowRunId` is set, render `<a href={`${process.env.NEXT_PUBLIC_MLFLOW_URL ?? "http://127.0.0.1:5000"}/#/experiments/0/runs/${r.mlflowRunId}`} target="_blank" rel="noopener noreferrer">view</a>`. Otherwise render `—`. (The env var lets Phase B point this at the hosted server without code changes.)
- `ModelsTab.tsx` leaderboard column for Sharpe-adjusted: header `SHARPE-ADJ`, render `fmtNum(row.sharpe_adjusted, 3)`. Sortable like the existing columns.
- No new pages, no MLflow API calls from the frontend (the proxy stays out of MLflow). The link is the integration surface; users land in the MLflow UI directly.

### 8. Scripts migration

`scripts/train_logistic.py`, `scripts/train_dixon_coles.py`, `scripts/train_hgb.py` each swap:

```python
# Before
log_run_to_mlflow(run_name=..., params=..., metrics_uncalibrated=...,
                  metrics_calibrated=..., reliability_svg_uncalibrated=...,
                  reliability_svg_calibrated=..., model_artifact_path=...)
# After
log_training_run(model_name=..., train_until=..., market_spec=...,
                 feature_columns=..., n_train_events=...,
                 metrics_uncalibrated=..., metrics_calibrated=...,
                 trained_model=trained, artifact_extras={
                     "reliability_uncalibrated.svg": svg_uncal,
                     "reliability_calibrated.svg": svg_cal,
                 },
                 git_sha=_git_sha_or_none())
```

`app/ml/training.py:log_run_to_mlflow` becomes a thin backward-compatible shim that warns once and forwards. One release of overlap, then deletable when no external callers remain.

`--no-mlflow` CLI flag stays; sets `APP_MLFLOW_DISABLED=1` for the script's process.

## Data flow

```
1. Offline training script (e.g. scripts/train_logistic.py)
   → fits TrainedLogistic
   → log_training_run(model_name="logistic", trained_model=...)
     → tracking._ensure_tracking()
     → mlflow.start_run() with run_name="train_logistic_2024-08-01"
     → log canonical params + uncal_/cal_ metrics
     → save_picks_model() → mlflow.pyfunc.log_model with PicksModelWrapper
     → log_text(reliability SVGs as artifacts)
   → MLflow UI: run appears in "picks" experiment, purpose=offline_training

2. UI-triggered backtest (POST /backtest/runs)
   → BacktestManager.create_run inserts queued backtest_runs row (no mlflow_run_id)
   → worker dequeues, resolve_model_for_backtest fits trainable model
   → run_backtest(...) returns BacktestReport with sharpe_adjusted populated
   → finalize_run(conn, run_id, summary={..., sharpe_adjusted})
   → log_backtest_run(report=..., backtest_run_id=run_id)
     → mlflow.start_run() with run_name="bt_logistic_2024-08-01",
       tag purpose=walk_forward_backtest, tag backtest_run_id=<sqlite id>
     → log all 10 backtest metrics including sharpe_adjusted
     → log reliability_svg if present
     → return mlflow_run_id
   → update_mlflow_run_id(conn, run_id, mlflow_run_id)
   → BacktestRunsPanel polls, renders MLflow link column

3. Frontend leaderboard
   → reads /backtest/runs → rows now carry sharpe_adjusted + mlflow_run_id
   → leaderboard column renders Sharpe-adj value
   → MLflow column renders a clickable link to http://127.0.0.1:5000/#/...

4. Test suite
   → conftest.py sets APP_MLFLOW_DISABLED=1 at session start
   → log_training_run() and log_backtest_run() return None without
     attempting any network call
   → update_mlflow_run_id stores NULL — backtest_runs row still completes
   → Existing tests pass without modification.
```

## Testing

**New test files:**

- `tests/ml/test_tracking_schema.py` — per-test temp `sqlite:///<tmp>/mlflow.db` tracking server. Asserts:
  - `log_training_run` writes `purpose=offline_training`, all canonical params, `uncal_*` + `cal_*` metrics.
  - `log_backtest_run` writes `purpose=walk_forward_backtest`, `backtest_run_id` tag, all 10 backtest metrics including `sharpe_adjusted`.
  - `APP_MLFLOW_DISABLED=1` short-circuits both functions to `None` with no network call.
  - Unreachable URI returns `None` after first call and flips `_DISABLED` for the process (assert via a second call making no further network attempts).

- `tests/ml/test_pyfunc_wrapper.py` — round-trip log → load → predict for each model type. Parametrized over `["logistic", "hgb", "hgb_pca", "dixon_coles", "market_implied", "vig_included"]`. Asserts output shape `["home","draw","away"]` and row sums ≈1.0.

**Modified existing test files:**

- `tests/services/test_backtest_manager.py` — assert `update_mlflow_run_id` is called after `finalize_run` with the value `log_backtest_run` returns (`None` under `APP_MLFLOW_DISABLED=1`).
- `tests/ml/test_backtest.py` — assert `BacktestReport` has the four new fields and Sharpe-adjusted math is correct on a fixed 3-bet fixture (one win at odds 2.5, one loss, one win at odds 1.5).

**`conftest.py` addition:**

```python
import os
os.environ.setdefault("APP_MLFLOW_DISABLED", "1")
```

Session-level. Means every existing test runs unchanged with no MLflow calls. The new schema/wrapper test files explicitly `monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)` to opt back in.

## Migration

1. `Makefile` target, `.gitignore` entry, `docs/mlflow.md` runbook. No code change; lets you start the server and validate the UI is reachable before any logging code lands.
2. `app/ml/tracking.py` + `app/ml/pyfunc_wrapper.py` new files, with `test_tracking_schema.py` + `test_pyfunc_wrapper.py` green. Inert (nothing imports them yet).
3. `BacktestReport` extensions + math + test for Sharpe-adjusted.
4. SQLite migration: idempotent ALTERs in `_ensure_backtest_tables` + `finalize_run` writes `sharpe_adjusted` + `update_mlflow_run_id` helper.
5. `BacktestManager._execute` calls `log_backtest_run` then `update_mlflow_run_id`.
6. Prisma schema mirror, `prisma:generate`, `BacktestRunSummary` / `BacktestRunDetail` type updates, frontend column + link.
7. `scripts/train_*.py` swap to `log_training_run`. `log_run_to_mlflow` becomes a deprecated shim.

Each step is independently shippable. SQLite ALTERs are additive; existing rows tolerate `NULL` in both new columns; the frontend renders `—` for any pre-Phase-A backtest run that lacks an `mlflow_run_id`.

## Effort estimate

~1.5 days:

- Runbook + Makefile + gitignore: ~0.1 day.
- `tracking.py` + `pyfunc_wrapper.py` + their tests: ~0.5 day.
- `BacktestReport` extensions + math + test: ~0.2 day.
- SQLite + Prisma migration: ~0.2 day.
- BacktestManager wiring + frontend column + link: ~0.3 day.
- Scripts migration + shim + smoke: ~0.2 day.

## Out of scope (explicit, again)

- Phase B: hosted MLflow on a VPS (Postgres + S3 + nginx + auth + backups).
- Phase C: Model Registry + alias-based serving (`models:/<name>@champion`) replacing `$APP_ML_MODELS_DIR`.
- Phase D: `MLproject` reproducibility + scheduled retraining + auto-promotion.
- Replacing `BacktestRunsPanel` Compare or `backtest_runs`/`backtest_bets` SQLite tables.
- `scripts/train_hgb.py` on-disk artifact path; `app/ml/serving.py` model loading.
- Auth on the local MLflow server.
- Autologging via `mlflow.sklearn.autolog()`.
- Per-sport / per-market sub-experiments (single `picks` experiment for Phase A).
