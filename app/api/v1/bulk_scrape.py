"""Bulk scrape job control plane. Job execution lives in app/workers/tasks.py."""
from __future__ import annotations

import os
from datetime import UTC, datetime

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import ScrapeJob, ScrapeJobEvent
from app.schemas.bulk_scrape import (
    BulkScrapeJob,
    BulkScrapeJobCreateRequest,
    BulkScrapeJobDetail,
    BulkScrapeJobEvent,
    BulkScrapeJobListResponse,
)

router = APIRouter(prefix="/bulk-scrape", tags=["bulk-scrape"])


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _job_to_schema(
    row: ScrapeJob, counters: dict[str, int] | None = None
) -> BulkScrapeJob:
    counters = counters or {}
    return BulkScrapeJob(
        id=row.id,
        competition_path=row.competition_path,
        seasons=row.seasons,
        include_stats=row.include_stats,
        include_odds=row.include_odds,
        max_concurrency=row.max_concurrency,
        status=row.status,
        created_at=row.created_at.isoformat(),
        started_at=_iso(row.started_at),
        updated_at=row.updated_at.isoformat(),
        finished_at=_iso(row.finished_at),
        last_error=row.last_error,
        total_events=row.total_events,
        pending_events=counters.get("pending", 0),
        running_events=counters.get("running", 0),
        succeeded_events=counters.get("succeeded", 0),
        failed_events=counters.get("failed", 0),
        skipped_events=counters.get("skipped", 0),
    )


async def _counters_for_jobs(
    session: AsyncSession, job_ids: list[int]
) -> dict[int, dict[str, int]]:
    if not job_ids:
        return {}
    stmt = (
        select(
            ScrapeJobEvent.job_id,
            ScrapeJobEvent.status,
            func.count().label("n"),
        )
        .where(ScrapeJobEvent.job_id.in_(job_ids))
        .group_by(ScrapeJobEvent.job_id, ScrapeJobEvent.status)
    )
    result: dict[int, dict[str, int]] = {jid: {} for jid in job_ids}
    for job_id, status, n in (await session.execute(stmt)).all():
        result[job_id][status] = n
    return result


def _event_to_schema(row: ScrapeJobEvent) -> BulkScrapeJobEvent:
    return BulkScrapeJobEvent(
        event_id=row.event_id,
        season_path=row.season_path,
        status=row.status,
        attempts=row.attempts,
        skipped_reason=row.skipped_reason,
        last_error=row.last_error,
        created_at=row.created_at.isoformat(),
        started_at=_iso(row.started_at),
        updated_at=row.updated_at.isoformat(),
        finished_at=_iso(row.finished_at),
    )


async def _redis_pool() -> ArqRedis:
    return await create_pool(
        RedisSettings.from_dsn(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    )


@router.post("/jobs", response_model=BulkScrapeJob)
async def create_bulk_scrape_job(
    payload: BulkScrapeJobCreateRequest,
    session: AsyncSession = Depends(get_session),
) -> BulkScrapeJob:
    if not payload.include_stats and not payload.include_odds:
        raise HTTPException(422, "At least one of include_stats/include_odds must be true.")

    now = datetime.now(UTC)
    job = ScrapeJob(
        competition_path=payload.competition_path,
        seasons=payload.seasons,
        include_stats=payload.include_stats,
        include_odds=payload.include_odds,
        max_concurrency=payload.max_concurrency,
        status="queued",
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    await session.flush()
    await session.commit()
    await session.refresh(job)

    redis = await _redis_pool()
    try:
        await redis.enqueue_job(
            "run_bulk_scrape_job",
            job_id=job.id,
            competition_path=job.competition_path,
            seasons=job.seasons,
            include_stats=job.include_stats,
            include_odds=job.include_odds,
            max_concurrency=job.max_concurrency,
        )
    finally:
        await redis.close()

    # Return the full job schema so the frontend's normaliser (which expects
    # competition_path, created_at, updated_at, etc.) accepts the response.
    # Counters are 0 — the worker hasn't started yet.
    return _job_to_schema(job)


@router.get("/jobs", response_model=BulkScrapeJobListResponse)
async def list_bulk_scrape_jobs(
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> BulkScrapeJobListResponse:
    rows = (
        await session.execute(select(ScrapeJob).order_by(ScrapeJob.id.desc()).limit(limit))
    ).scalars().all()
    counters = await _counters_for_jobs(session, [r.id for r in rows])
    return BulkScrapeJobListResponse(
        total=len(rows),
        jobs=[_job_to_schema(r, counters.get(r.id)) for r in rows],
    )


@router.get("/jobs/{job_id}", response_model=BulkScrapeJobDetail)
async def get_bulk_scrape_job(
    job_id: int,
    include_events: bool = Query(default=True),
    event_limit: int = Query(default=500, ge=1, le=5000),
    session: AsyncSession = Depends(get_session),
) -> BulkScrapeJobDetail:
    job = await session.get(ScrapeJob, job_id)
    if job is None:
        raise HTTPException(404, "Bulk scrape job not found.")
    events: list[BulkScrapeJobEvent] = []
    if include_events:
        rows = (
            await session.execute(
                select(ScrapeJobEvent)
                .where(ScrapeJobEvent.job_id == job_id)
                .order_by(ScrapeJobEvent.id.asc())
                .limit(event_limit)
            )
        ).scalars().all()
        events = [_event_to_schema(e) for e in rows]
    counters = await _counters_for_jobs(session, [job_id])
    base = _job_to_schema(job, counters.get(job_id))
    return BulkScrapeJobDetail(**base.model_dump(), events=events)
