"""Arq worker configuration."""
from __future__ import annotations

import os

from arq.connections import RedisSettings

from app.workers.tasks import run_bulk_scrape_job, scrape_event


class WorkerSettings:
    functions = [run_bulk_scrape_job, scrape_event]
    redis_settings = RedisSettings.from_dsn(
        os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    )
    max_jobs = 10
    job_timeout = 60 * 60  # 1 hour
    keep_result = 60 * 60 * 24  # 24 hours
