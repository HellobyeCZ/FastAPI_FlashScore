-- CreateTable
CREATE TABLE IF NOT EXISTS "odds_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event_id" TEXT NOT NULL,
    "fetched_at" DATETIME NOT NULL,
    "source" TEXT,
    "correlation_id" TEXT,
    "odds_payload_json" TEXT NOT NULL,
    "upstream_payload_json" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_odds_snapshots_event_fetched" ON "odds_snapshots"("event_id", "fetched_at");

-- CreateTable
CREATE TABLE IF NOT EXISTS "match_stats_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event_id" TEXT NOT NULL,
    "fetched_at" DATETIME NOT NULL,
    "source" TEXT,
    "correlation_id" TEXT,
    "match_stats_payload_json" TEXT NOT NULL,
    "feed_payloads_json" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_match_stats_snapshots_event_fetched" ON "match_stats_snapshots"("event_id", "fetched_at");
