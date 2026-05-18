-- Migration: mlflow_phase_a
-- Adds sharpe_adjusted and mlflow_run_id columns to backtest_runs.
-- NOTE: These columns were already added to the SQLite DB by the Task 3 Python
-- migration (idempotent ALTER TABLE). This file is registered as applied so
-- a fresh checkout reproduces the schema via Prisma.

ALTER TABLE "backtest_runs" ADD COLUMN "sharpe_adjusted" REAL;
ALTER TABLE "backtest_runs" ADD COLUMN "mlflow_run_id" TEXT;
