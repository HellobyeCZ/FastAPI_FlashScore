"""Odds endpoints. Mirrors the /odds and /storage/odds handlers from the
pre-Task-13 src.py, with SnapshotStore swapped for SnapshotRepo."""
from __future__ import annotations

import time

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.dependencies import get_odds_client, get_snapshot_repo
from app.observability import (
    get_correlation_id,
    odds_error_counter,
    odds_latency_histogram,
    tracer,
)
from app.schemas.odds import OddsResponse
from app.services.odds import map_odds_payload
from app.services.odds_client import OddsAPIError, OddsClient
from app.services.snapshot_repo import SnapshotRepo

router = APIRouter(tags=["odds"])

logger = structlog.get_logger("odds_client")


@router.get("/odds/{event_id}", response_model=OddsResponse)
async def get_odds(
    event_id: str,
    odds_client: OddsClient = Depends(get_odds_client),
    snapshot_repo: SnapshotRepo = Depends(get_snapshot_repo),
) -> OddsResponse:
    cached_terminal_odds = await snapshot_repo.get_latest_odds_snapshot_for_terminal_event(
        event_id=event_id
    )
    if cached_terminal_odds is not None:
        logger.info(
            "odds_request_served_from_cache",
            event_id=event_id,
            reason="terminal_match_snapshot",
        )
        return cached_terminal_odds
    if await snapshot_repo.is_event_terminal(event_id=event_id):
        logger.info(
            "odds_request_not_scraped",
            event_id=event_id,
            reason="terminal_match_without_cached_odds",
        )
        raise HTTPException(
            status_code=404,
            detail="No cached odds snapshot found for terminal match.",
        )

    settings = get_settings()
    url = settings.build_odds_url(event_id)

    with tracer.start_as_current_span(
        "odds.client.request",
        attributes={
            "odds.event_id": event_id,
            "http.method": "GET",
            "http.url": url,
        },
    ):
        start_time = time.perf_counter()
        try:
            logger.info(
                "odds_request_started",
                event_id=event_id,
                url=url,
            )
            response_json = await odds_client.get_odds(event_id)
        except OddsAPIError as exc:
            latency_ms = (time.perf_counter() - start_time) * 1000
            odds_latency_histogram.record(
                latency_ms, attributes={"event_id": event_id, "outcome": "error"}
            )
            odds_error_counter.add(
                1, attributes={"event_id": event_id, "error_type": exc.code}
            )
            logger.warning(
                "odds_request_upstream_error",
                event_id=event_id,
                code=exc.code,
                status_code=exc.upstream_status,
                latency_ms=latency_ms,
            )
            raise
        except Exception:
            latency_ms = (time.perf_counter() - start_time) * 1000
            odds_error_counter.add(
                1, attributes={"event_id": event_id, "error_type": "unexpected"}
            )
            logger.exception(
                "odds_request_unexpected_error",
                event_id=event_id,
                latency_ms=latency_ms,
            )
            raise HTTPException(
                status_code=500,
                detail="Unexpected internal error while retrieving odds.",
            ) from None

        latency_ms = (time.perf_counter() - start_time) * 1000
        odds_latency_histogram.record(
            latency_ms, attributes={"event_id": event_id, "outcome": "success"}
        )
        logger.info(
            "odds_request_completed",
            event_id=event_id,
            latency_ms=latency_ms,
        )

    odds_response = map_odds_payload(event_id=event_id, payload=response_json)
    try:
        await snapshot_repo.save_odds_snapshot(
            event_id=event_id,
            response=odds_response,
            upstream_payload=response_json,
            correlation_id=get_correlation_id(),
        )
    except Exception:
        logger.exception(
            "odds_snapshot_store_failed",
            event_id=event_id,
        )

    return odds_response


@router.get("/storage/odds/{event_id}")
async def list_odds_snapshots(
    event_id: str,
    limit: int = Query(default=25, ge=1, le=200),
    snapshot_repo: SnapshotRepo = Depends(get_snapshot_repo),
) -> dict[str, object]:
    snapshots = await snapshot_repo.list_odds_snapshots(event_id=event_id, limit=limit)
    return {"event_id": event_id, "count": len(snapshots), "snapshots": snapshots}
