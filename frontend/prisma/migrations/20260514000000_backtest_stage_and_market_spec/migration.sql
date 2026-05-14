-- AlterTable
ALTER TABLE "backtest_runs" ADD COLUMN "stage" TEXT;
ALTER TABLE "backtest_runs" ADD COLUMN "market_spec" TEXT NOT NULL DEFAULT 'football_1x2_ft';
