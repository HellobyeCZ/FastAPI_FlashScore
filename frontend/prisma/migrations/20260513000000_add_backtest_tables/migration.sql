-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "train_until" TEXT NOT NULL,
    "test_until" TEXT,
    "min_edge" REAL NOT NULL,
    "kelly_fraction" REAL NOT NULL,
    "force_bets" INTEGER NOT NULL,
    "scope_json" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "started_at" TEXT,
    "finished_at" TEXT,
    "error" TEXT,
    "test_events" INTEGER,
    "total_bets" INTEGER,
    "hit_rate" REAL,
    "roi" REAL,
    "mean_clv" REAL,
    "brier" REAL,
    "log_loss" REAL,
    "max_drawdown" REAL,
    "reliability_json" TEXT
);

-- CreateTable
CREATE TABLE "backtest_bets" (
    "run_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "bet_ts" TEXT NOT NULL,
    "kickoff_ts" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "price_taken" REAL NOT NULL,
    "closing_price" REAL NOT NULL,
    "model_prob" REAL NOT NULL,
    "implied_prob" REAL NOT NULL,
    "devigged_prob" REAL NOT NULL,
    "edge" REAL NOT NULL,
    "stake_kelly_fraction" REAL NOT NULL,
    "result" REAL NOT NULL,
    "pnl" REAL NOT NULL,
    "clv" REAL,

    PRIMARY KEY ("run_id", "event_id", "market", "selection"),
    CONSTRAINT "backtest_bets_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "backtest_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "idx_backtest_runs_status_time" ON "backtest_runs"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_backtest_bets_run" ON "backtest_bets"("run_id");

-- CreateIndex
CREATE INDEX "idx_backtest_bets_event" ON "backtest_bets"("event_id");
