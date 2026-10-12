-- Migration: ux_overhaul_indexes
-- Mirrors schema changes FastAPI applies on startup (app/services/storage.py):
-- the backtest_runs.n_train_events column and the indexes behind /ops/status
-- and the Matches list. Indexes use IF NOT EXISTS because FastAPI may have
-- created them first. If FastAPI already added n_train_events, the ALTER
-- fails with "duplicate column": mark this migration applied with
--   npx prisma migrate resolve --applied 20261011000000_ux_overhaul_indexes
-- and run the CREATE INDEX statements below by hand if any are missing.

ALTER TABLE "backtest_runs" ADD COLUMN "n_train_events" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_match_event_summaries_kickoff" ON "match_event_summaries"("start_time_utc", "event_id");
CREATE INDEX IF NOT EXISTS "idx_match_event_summaries_sport_kickoff" ON "match_event_summaries"("sport", "start_time_utc", "event_id");
CREATE INDEX IF NOT EXISTS "idx_match_event_summaries_country_kickoff" ON "match_event_summaries"("country", "start_time_utc", "event_id");
CREATE INDEX IF NOT EXISTS "idx_match_event_summaries_competition_kickoff" ON "match_event_summaries"("competition", "start_time_utc", "event_id");
CREATE INDEX IF NOT EXISTS "idx_live_odds_snapshots_fetched" ON "live_odds_snapshots"("fetched_at");
