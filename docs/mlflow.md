# MLflow runbook (Phase A — local)

## Starting the server

```
make mlflow
```

Opens on `http://127.0.0.1:5000`. Backend: SQLite at `mlflow/mlflow.db`. Artifacts: `mlflow/artifacts/`. Both gitignored.

## What lives where

- Experiment: `picks` — every model fit, both offline-training and walk-forward-backtest runs.
- Run tag `purpose` distinguishes `offline_training` vs `walk_forward_backtest`. A third value `scheduled_retrain` is reserved for Phase D.
- Each backtest run carries tag `backtest_run_id = <SQLite backtest_runs.id>` so you can cross-jump from the MLflow UI to the app's BacktestRunsPanel (and vice versa via the `mlflow_run_id` column on `backtest_runs`).

## Disabling logging

Set `APP_MLFLOW_DISABLED=1` in the environment. All MLflow writes become no-ops; the rest of the pipeline (SQLite writes, FastAPI responses) is unaffected. The pytest suite sets this automatically.

## Disabled because server is down

If `make mlflow` isn't running when an offline script or UI backtest tries to log, the first call logs one structured warning `mlflow_disabled_for_process` and disables logging for the rest of the process. No retries. Restart the affected process after starting the server.

## Browsing runs

Open `http://127.0.0.1:5000`. Sort the runs table by `sharpe_adjusted` desc to rank rules. Filter by `tags.purpose = "walk_forward_backtest"` to see only backtests.

## Phase B preview

Phase B replaces the SQLite backend with Postgres and the local artifact directory with S3. Code calls and schema do not change.
