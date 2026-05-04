"""Arq task handlers for bulk scraping."""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.engine import get_session_factory
from app.db.models import ScrapeJob, ScrapeJobEvent
from app.dependencies import get_match_stats_client, get_odds_client, get_snapshot_repo
from app.services.discovery import FlashscoreDiscoveryClient
from app.services.match_stats import map_match_stats_payload
from app.services.odds import map_odds_payload

logger = logging.getLogger(__name__)


async def _update_job(job_id: int, **fields: Any) -> None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            update(ScrapeJob).where(ScrapeJob.id == job_id).values(**fields)
        )
        await session.commit()


async def _upsert_event_row(
    *,
    job_id: int,
    event_id: str,
    season_path: str | None,
    status: str,
    now: datetime,
) -> None:
    factory = get_session_factory()
    async with factory() as session:
        stmt = pg_insert(ScrapeJobEvent).values(
            job_id=job_id,
            event_id=event_id,
            season_path=season_path,
            status=status,
            attempts=0,
            created_at=now,
            updated_at=now,
        )
        # Job already had this event — leave it alone (idempotent re-discovery).
        # Use index_elements (column list) rather than constraint name: Prisma's
        # @@unique creates a unique INDEX, not a named CONSTRAINT.
        stmt = stmt.on_conflict_do_nothing(index_elements=["job_id", "event_id"])
        await session.execute(stmt)
        await session.commit()


async def _update_event_row(
    *,
    job_id: int,
    event_id: str,
    **fields: Any,
) -> None:
    factory = get_session_factory()
    async with factory() as session:
        await session.execute(
            update(ScrapeJobEvent)
            .where(
                ScrapeJobEvent.job_id == job_id,
                ScrapeJobEvent.event_id == event_id,
            )
            .values(**fields)
        )
        await session.commit()


async def run_bulk_scrape_job(
    ctx: dict[str, Any],
    *,
    job_id: int,
    competition_path: str,
    seasons: int,
    include_stats: bool,
    include_odds: bool,
    max_concurrency: int,
) -> dict[str, int]:
    """Discover events for a competition+seasons, enqueue scrape_event for each."""
    now = datetime.now(UTC)
    await _update_job(job_id, status="running", started_at=now, updated_at=now)

    try:
        discovery = FlashscoreDiscoveryClient()
        try:
            events = await discovery.discover_event_ids(
                competition_path=competition_path, seasons=seasons
            )
        finally:
            await discovery.aclose()

        # Insert one scrape_job_events row per discovered event so the API can
        # aggregate progress counters from this table.
        for event_id, season_path in events:
            await _upsert_event_row(
                job_id=job_id,
                event_id=event_id,
                season_path=season_path,
                status="pending",
                now=datetime.now(UTC),
            )

        redis = ctx["redis"]
        for event_id, season_path in events:
            await redis.enqueue_job(
                "scrape_event",
                job_id=job_id,
                event_id=event_id,
                season_path=season_path,
                include_stats=include_stats,
                include_odds=include_odds,
            )

        finished = datetime.now(UTC)
        # Status reflects discovery + dispatch only. Per-event success/failure is
        # tracked on scrape_job_events; the API aggregates counters from there.
        await _update_job(
            job_id,
            status="completed",
            total_events=len(events),
            finished_at=finished,
            updated_at=finished,
        )
        return {"discovered": len(events)}
    except Exception as exc:
        logger.exception("run_bulk_scrape_job failed", extra={"job_id": job_id})
        finished = datetime.now(UTC)
        await _update_job(
            job_id,
            status="failed",
            last_error=str(exc)[:1000],
            finished_at=finished,
            updated_at=finished,
        )
        raise


async def scrape_event(
    ctx: dict[str, Any],
    *,
    job_id: int,
    event_id: str,
    season_path: str | None,
    include_stats: bool,
    include_odds: bool,
) -> dict[str, str]:
    """Scrape one event (odds + stats) and persist."""
    repo = get_snapshot_repo()
    started = datetime.now(UTC)
    await _update_event_row(
        job_id=job_id,
        event_id=event_id,
        status="running",
        started_at=started,
        updated_at=started,
    )

    try:
        if await repo.is_event_terminal(event_id=event_id):
            finished = datetime.now(UTC)
            await _update_event_row(
                job_id=job_id,
                event_id=event_id,
                status="skipped",
                skipped_reason="terminal_snapshot_exists",
                finished_at=finished,
                updated_at=finished,
            )
            return {"event_id": event_id, "status": "skipped_terminal"}

        if include_odds:
            odds_client = get_odds_client()
            upstream = await odds_client.get_odds(event_id)
            odds_response = map_odds_payload(event_id=event_id, payload=upstream)
            await repo.save_odds_snapshot(
                event_id=event_id,
                response=odds_response,
                upstream_payload=upstream,
                correlation_id=None,
            )

        if include_stats:
            stats_client = get_match_stats_client()
            feeds = await stats_client.get_match_stats_feeds(event_id)
            meta = await stats_client.get_match_metadata(event_id)
            stats_response = map_match_stats_payload(
                event_id=event_id,
                feed_payloads=feeds,
                home_team=meta.home_team,
                away_team=meta.away_team,
                sport=meta.sport,
                country=meta.country,
                competition=meta.competition,
                competition_stage=meta.competition_stage,
                competition_path=meta.competition_path,
            )
            await repo.save_match_stats_snapshot(
                event_id=event_id,
                response=stats_response,
                feed_payloads=feeds,
                correlation_id=None,
            )

        finished = datetime.now(UTC)
        await _update_event_row(
            job_id=job_id,
            event_id=event_id,
            status="succeeded",
            finished_at=finished,
            updated_at=finished,
        )
        return {"event_id": event_id, "status": "ok"}
    except Exception as exc:
        logger.exception(
            "scrape_event failed", extra={"job_id": job_id, "event_id": event_id}
        )
        finished = datetime.now(UTC)
        await _update_event_row(
            job_id=job_id,
            event_id=event_id,
            status="failed",
            last_error=str(exc)[:1000],
            finished_at=finished,
            updated_at=finished,
        )
        raise
