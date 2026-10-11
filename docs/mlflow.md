# MLflow runbook (local tracking + model registry)

Full operator manual: [docs/mlflow/README.md](mlflow/README.md).

## Starting the server

```
make mlflow
```

Opens on `http://127.0.0.1:5050` (not :5000 — macOS AirPlay Receiver owns that port). Backend: SQLite at `mlflow/mlflow.db`. Artifacts are proxied by the server and stored under `mlflow/artifacts/`. Both gitignored. The target runs MLflow 3 through `uvx`, isolated from the system interpreter (whose mlflow install is broken).

The backend talks to `MLFLOW_TRACKING_URI` (default `http://127.0.0.1:5050`). Browser links use `APP_MLFLOW_UI_URL` (default: the tracking URI).

## What lives where

- Experiment `picks` — every model fit. Tag `purpose` ∈ `offline_training`, `walk_forward_backtest`, `backfill` (`scheduled_retrain` reserved).
- Backtest runs carry tag `backtest_run_id = <backtest_runs.id>`; the SQLite row carries `mlflow_run_id` and the API returns a ready-made `mlflow_ui_url`.
- Training runs and backtests of fitted models log the model as `picks_model` (tag `has_model=true`). That is what gets registered.
- Registered models are named `picks-<model>`. Alias `@champion` is what live serving uses; `@challenger` is tracked only.

## Promote a model

1. Run a backtest (Model lab › Backtests) or a training script.
2. Register it: Model lab › Backtests › run › **Register model**, or `POST /mlflow/registry/register {"run_id": "...", "alias": "challenger"}`.
3. Promote: Model lab › Registry (promote to champion, confirmed), or `POST /mlflow/registry/picks-<model>/aliases {"version": "N", "alias": "champion"}`. Serving reloads immediately; Data ops shows the served version.

Only `logistic`, `hgb` and `hgb_pca` are servable from the registry. Dixon–Coles is always served from `$APP_ML_MODELS_DIR`.

## When MLflow is down or disabled

- `APP_MLFLOW_DISABLED=1` makes every MLflow call a no-op (the pytest suite sets it).
- If the server is unreachable, logging is skipped and the server is re-probed every 60 s — no restart needed once it's back. Backtests always complete and persist to SQLite.
- Serving falls back to `$APP_ML_MODELS_DIR/<label>/model.pkl`.
- `/mlflow/*` GETs return `status.reachable=false` with empty lists; registry mutations return 503.

## Backfill old backtests

```
PYTHONPATH=. APP_STORAGE_DB_PATH=$PWD/data/flashscore_snapshots.sqlite3 \
  python scripts/backfill_mlflow_backtests.py --dry-run   # then without --dry-run
```

Logs completed backtests that have no `mlflow_run_id` as `purpose=backfill` runs (metrics/params only, no model) and writes the id back. Idempotent.
