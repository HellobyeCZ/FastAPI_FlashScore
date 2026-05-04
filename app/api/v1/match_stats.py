"""Match-stats endpoints. Mirrors the /match-stats and /storage/match-stats
handlers from pre-Task-13 src.py, with SnapshotStore swapped for SnapshotRepo."""
from __future__ import annotations

import time

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.dependencies import get_match_stats_client, get_snapshot_repo
from app.observability import (
    get_correlation_id,
    match_stats_error_counter,
    match_stats_latency_histogram,
    tracer,
)
from app.schemas.match_stats import MatchStatsResponse
from app.services.match_stats import map_match_stats_payload
from app.services.snapshot_repo import SnapshotRepo
from app.services.stats_client import (
    MatchPageMetadata,
    MatchStatsClient,
    StatsAPIError,
)

router = APIRouter(tags=["match-stats"])

logger = structlog.get_logger("match_stats_client")


@router.get("/match-stats/{event_id}", response_model=MatchStatsResponse)
async def get_match_stats(
    event_id: str,
    match_stats_client: MatchStatsClient = Depends(get_match_stats_client),
    snapshot_repo: SnapshotRepo = Depends(get_snapshot_repo),
) -> MatchStatsResponse:
    cached_terminal_stats = await snapshot_repo.get_terminal_match_stats_snapshot(
        event_id=event_id
    )
    if cached_terminal_stats is not None:
        logger.info(
            "match_stats_request_served_from_cache",
            event_id=event_id,
            reason="terminal_snapshot",
        )
        return cached_terminal_stats

    settings = get_settings()
    url = settings.build_match_stats_url(event_id)
    match_metadata = MatchPageMetadata()

    with tracer.start_as_current_span(
        "match_stats.client.request",
        attributes={
            "match_stats.event_id": event_id,
            "http.method": "GET",
            "http.url": url,
        },
    ):
        start_time = time.perf_counter()
        try:
            logger.info(
                "match_stats_request_started",
                event_id=event_id,
                url=url,
            )
            response_feeds = await match_stats_client.get_match_stats_feeds(event_id)
            try:
                match_metadata = await match_stats_client.get_match_metadata(event_id)
            except Exception:
                logger.warning(
                    "match_stats_page_metadata_unavailable",
                    event_id=event_id,
                )
        except StatsAPIError as exc:
            latency_ms = (time.perf_counter() - start_time) * 1000
            match_stats_latency_histogram.record(
                latency_ms,
                attributes={"event_id": event_id, "outcome": "error"},
            )
            match_stats_error_counter.add(
                1,
                attributes={"event_id": event_id, "error_type": exc.code},
            )
            logger.warning(
                "match_stats_request_upstream_error",
                event_id=event_id,
                code=exc.code,
                status_code=exc.upstream_status,
                latency_ms=latency_ms,
            )
            raise
        except Exception:
            latency_ms = (time.perf_counter() - start_time) * 1000
            match_stats_error_counter.add(
                1,
                attributes={"event_id": event_id, "error_type": "unexpected"},
            )
            logger.exception(
                "match_stats_request_unexpected_error",
                event_id=event_id,
                latency_ms=latency_ms,
            )
            raise HTTPException(
                status_code=500,
                detail="Unexpected internal error while retrieving match stats.",
            ) from None

        latency_ms = (time.perf_counter() - start_time) * 1000
        match_stats_latency_histogram.record(
            latency_ms,
            attributes={"event_id": event_id, "outcome": "success"},
        )
        logger.info(
            "match_stats_request_completed",
            event_id=event_id,
            latency_ms=latency_ms,
        )

    match_stats_response = map_match_stats_payload(
        event_id=event_id,
        feed_payloads=response_feeds,
        home_team=match_metadata.home_team,
        away_team=match_metadata.away_team,
        sport=match_metadata.sport,
        country=match_metadata.country,
        competition=match_metadata.competition,
        competition_stage=match_metadata.competition_stage,
        competition_path=match_metadata.competition_path,
    )
    try:
        await snapshot_repo.save_match_stats_snapshot(
            event_id=event_id,
            response=match_stats_response,
            feed_payloads=response_feeds,
            correlation_id=get_correlation_id(),
        )
    except Exception:
        logger.exception(
            "match_stats_snapshot_store_failed",
            event_id=event_id,
        )

    return match_stats_response


@router.get("/storage/match-stats/{event_id}")
async def list_match_stats_snapshots(
    event_id: str,
    limit: int = Query(default=25, ge=1, le=200),
    snapshot_repo: SnapshotRepo = Depends(get_snapshot_repo),
) -> dict[str, object]:
    snapshots = await snapshot_repo.list_match_stats_snapshots(event_id=event_id, limit=limit)
    return {"event_id": event_id, "count": len(snapshots), "snapshots": snapshots}
