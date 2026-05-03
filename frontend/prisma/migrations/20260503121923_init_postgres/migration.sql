-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT,
    "correlation_id" TEXT,
    "odds_payload_json" TEXT NOT NULL,
    "upstream_blob_url" TEXT NOT NULL,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_stats_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT,
    "correlation_id" TEXT,
    "match_stats_payload_json" TEXT NOT NULL,
    "feed_payloads_blob_url" TEXT NOT NULL,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "match_stats_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scrape_jobs" (
    "id" BIGSERIAL NOT NULL,
    "competition_path" TEXT NOT NULL,
    "seasons" INTEGER NOT NULL,
    "include_stats" BOOLEAN NOT NULL DEFAULT true,
    "include_odds" BOOLEAN NOT NULL DEFAULT true,
    "max_concurrency" INTEGER NOT NULL DEFAULT 4,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "total_events" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scrape_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scrape_job_events" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "event_id" TEXT NOT NULL,
    "season_path" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "skipped_reason" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "scrape_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_event_summaries" (
    "event_id" TEXT NOT NULL,
    "event_name" TEXT,
    "home_team" TEXT,
    "away_team" TEXT,
    "sport" TEXT,
    "country" TEXT,
    "competition" TEXT,
    "competition_stage" TEXT,
    "competition_path" TEXT,
    "start_time_utc" TIMESTAMPTZ(6),
    "status" TEXT,
    "status_detail" TEXT,
    "outcome" TEXT,
    "odds_snapshot_count" INTEGER NOT NULL DEFAULT 0,
    "stats_snapshot_count" INTEGER NOT NULL DEFAULT 0,
    "latest_odds_fetched_at" TIMESTAMPTZ(6),
    "latest_stats_fetched_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "match_event_summaries_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "idx_odds_snapshots_event_fetched" ON "odds_snapshots"("event_id", "fetched_at");

-- CreateIndex
CREATE INDEX "idx_match_stats_snapshots_event_fetched" ON "match_stats_snapshots"("event_id", "fetched_at");

-- CreateIndex
CREATE INDEX "idx_scrape_jobs_status" ON "scrape_jobs"("status", "id" DESC);

-- CreateIndex
CREATE INDEX "idx_scrape_job_events_job_status" ON "scrape_job_events"("job_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_scrape_job_events_job_event" ON "scrape_job_events"("job_id", "event_id");

-- CreateIndex
CREATE INDEX "idx_match_event_summaries_updated" ON "match_event_summaries"("updated_at" DESC);

-- AddForeignKey
ALTER TABLE "scrape_job_events" ADD CONSTRAINT "scrape_job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scrape_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
