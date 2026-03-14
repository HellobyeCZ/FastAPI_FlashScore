import logging
import logging.config
import os
import time
import uuid
from contextvars import ContextVar
from functools import lru_cache
from typing import Any, Optional

import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.schemas.bulk_scrape import (
    BulkScrapeJobCreateRequest,
    BulkScrapeJobDetail,
    BulkScrapeJobListResponse,
)
from app.schemas.match_stats import MatchStatsResponse
from app.schemas.odds import OddsResponse
from app.services.bulk_scrape import BulkScrapeJobConfig, BulkScrapeManager
from app.services.match_stats import map_match_stats_payload
from app.services.odds import map_odds_payload
from app.services.odds_client import OddsAPIError, OddsClient, build_odds_client
from app.services.storage import SnapshotStore, build_snapshot_store
from app.services.stats_client import (
    MatchPageMetadata,
    MatchStatsClient,
    StatsAPIError,
    build_match_stats_client,
)

try:
    from opentelemetry import metrics, trace
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
except ImportError:  # pragma: no cover - optional dependency guard
    metrics = None  # type: ignore[assignment]
    trace = None  # type: ignore[assignment]
    FastAPIInstrumentor = None  # type: ignore[assignment]
    HTTPXClientInstrumentor = None  # type: ignore[assignment]
    MeterProvider = None  # type: ignore[assignment]
    PeriodicExportingMetricReader = None  # type: ignore[assignment]
    Resource = None  # type: ignore[assignment]
    TracerProvider = None  # type: ignore[assignment]
    BatchSpanProcessor = None  # type: ignore[assignment]




_OPENTELEMETRY_AVAILABLE = all(
    item is not None
    for item in (
        metrics,
        trace,
        FastAPIInstrumentor,
        HTTPXClientInstrumentor,
        MeterProvider,
        PeriodicExportingMetricReader,
        Resource,
        TracerProvider,
        BatchSpanProcessor,
    )
)


class _NoopSpan:
    def __enter__(self) -> "_NoopSpan":
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False


class _NoopTracer:
    def start_as_current_span(self, *args: Any, **kwargs: Any) -> "_NoopSpan":
        return _NoopSpan()


class _NoopHistogram:
    def record(self, *args: Any, **kwargs: Any) -> None:
        return None


class _NoopCounter:
    def add(self, *args: Any, **kwargs: Any) -> None:
        return None


class _NoopMeter:
    def create_histogram(self, *args: Any, **kwargs: Any) -> _NoopHistogram:
        return _NoopHistogram()

    def create_counter(self, *args: Any, **kwargs: Any) -> _NoopCounter:
        return _NoopCounter()


def configure_logging() -> None:
    """Configure structured logging with JSON output."""

    timestamper = structlog.processors.TimeStamper(fmt="iso", key="timestamp")
    logging_config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "structlog": {
                "()": structlog.stdlib.ProcessorFormatter,
                "processor": structlog.processors.JSONRenderer(),
                "foreign_pre_chain": [
                    structlog.contextvars.merge_contextvars,
                    structlog.processors.add_log_level,
                    timestamper,
                ],
            }
        },
        "handlers": {
            "default": {
                "class": "logging.StreamHandler",
                "formatter": "structlog",
            }
        },
        "root": {
            "handlers": ["default"],
            "level": os.getenv("LOG_LEVEL", "INFO"),
        },
    }

    logging.config.dictConfig(logging_config)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            timestamper,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


configure_logging()


CORRELATION_ID_HEADER = "x-correlation-id"
CORRELATION_ID_RESPONSE_HEADER = "X-Correlation-ID"
TRACEPARENT_HEADER = "traceparent"

correlation_id_var: ContextVar[Optional[str]] = ContextVar("correlation_id", default=None)
traceparent_var: ContextVar[Optional[str]] = ContextVar("traceparent", default=None)


_telemetry_instrumented = False


def _configure_telemetry(app: FastAPI) -> None:
    """Initialise OpenTelemetry exporters and instrumentation."""

    telemetry_logger = structlog.get_logger("telemetry")

    if not _OPENTELEMETRY_AVAILABLE:
        telemetry_logger.info("telemetry_disabled", reason="opentelemetry_not_installed")
        return

    global _telemetry_instrumented
    if not _telemetry_instrumented:
        # Instrument FastAPI and HTTPX to automatically create spans.
        FastAPIInstrumentor.instrument_app(app, excluded_urls="/health")  # type: ignore[union-attr]
        HTTPXClientInstrumentor().instrument()  # type: ignore[union-attr]
        _telemetry_instrumented = True


app = FastAPI(title="FlashScore Dashboard API", version="0.2.0")
settings = get_settings()


@lru_cache()
def _get_odds_client() -> OddsClient:
    return build_odds_client()


@lru_cache()
def _get_match_stats_client() -> MatchStatsClient:
    return build_match_stats_client()


@lru_cache()
def _get_snapshot_store() -> SnapshotStore:
    return build_snapshot_store()


@lru_cache()
def _get_bulk_scrape_manager() -> BulkScrapeManager:
    return BulkScrapeManager(
        snapshot_store=_get_snapshot_store(),
        odds_client=_get_odds_client(),
        match_stats_client=_get_match_stats_client(),
    )


def odds_client_dependency() -> OddsClient:
    return _get_odds_client()


def match_stats_client_dependency() -> MatchStatsClient:
    return _get_match_stats_client()


def snapshot_store_dependency() -> SnapshotStore:
    return _get_snapshot_store()


def bulk_scrape_manager_dependency() -> BulkScrapeManager:
    return _get_bulk_scrape_manager()


@app.on_event("startup")
async def startup_snapshot_store() -> None:
    await _get_snapshot_store().initialize()
    await _get_bulk_scrape_manager().start()


@app.on_event("shutdown")
async def shutdown_odds_client() -> None:
    await _get_bulk_scrape_manager().shutdown()
    await _get_odds_client().aclose()
    await _get_match_stats_client().aclose()
    await _get_snapshot_store().aclose()


@app.exception_handler(OddsAPIError)
async def odds_error_handler(_: Request, exc: OddsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


@app.exception_handler(StatsAPIError)
async def stats_error_handler(_: Request, exc: StatsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})

_configure_telemetry(app)

logger = structlog.get_logger("odds_client")
if _OPENTELEMETRY_AVAILABLE:
    tracer = trace.get_tracer(__name__)  # type: ignore[union-attr]
    meter = metrics.get_meter("fastapi_flashscore.odds_client")  # type: ignore[union-attr]
else:
    tracer = _NoopTracer()
    meter = _NoopMeter()
odds_latency_histogram = meter.create_histogram(
    name="odds_client_latency_ms",
    unit="ms",
    description="Latency of calls to the upstream odds provider.",
)
odds_error_counter = meter.create_counter(
    name="odds_client_errors",
    description="Number of errors encountered while calling the upstream odds provider.",
)
match_stats_latency_histogram = meter.create_histogram(
    name="match_stats_client_latency_ms",
    unit="ms",
    description="Latency of calls to the upstream match stats provider.",
)
match_stats_error_counter = meter.create_counter(
    name="match_stats_client_errors",
    description="Number of errors encountered while calling the upstream match stats provider.",
)


def get_correlation_id() -> Optional[str]:
    return correlation_id_var.get()


def get_traceparent() -> Optional[str]:
    return traceparent_var.get()


@app.middleware("http")
async def correlation_id_middleware(request: Request, call_next):
    """Extract correlation identifiers and bind them into the logging context."""

    incoming_traceparent = request.headers.get(TRACEPARENT_HEADER)
    incoming_correlation_id = request.headers.get(CORRELATION_ID_HEADER)

    if not incoming_correlation_id and incoming_traceparent:
        # traceparent format: "00-<trace-id>-<span-id>-<trace-flags>"
        parts = incoming_traceparent.split("-")
        if len(parts) >= 3:
            incoming_correlation_id = parts[1]

    if not incoming_correlation_id:
        incoming_correlation_id = str(uuid.uuid4())

    correlation_token = correlation_id_var.set(incoming_correlation_id)
    traceparent_token = traceparent_var.set(incoming_traceparent)

    structlog.contextvars.bind_contextvars(correlation_id=incoming_correlation_id)

    request_logger = structlog.get_logger("request")
    start_time = time.perf_counter()
    request_logger.info(
        "request_started",
        method=request.method,
        path=str(request.url.path),
    )

    try:
        response = await call_next(request)
    except Exception:
        request_logger.exception("request_failed")
        raise
    else:
        duration_ms = (time.perf_counter() - start_time) * 1000
        request_logger.info(
            "request_completed",
            status_code=response.status_code,
            duration_ms=duration_ms,
        )
        response.headers[CORRELATION_ID_RESPONSE_HEADER] = incoming_correlation_id
        return response
    finally:
        structlog.contextvars.unbind_contextvars("correlation_id")
        correlation_id_var.reset(correlation_token)
        traceparent_var.reset(traceparent_token)


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/odds/{event_id}", response_model=OddsResponse)
async def get_odds(
    event_id: str,
    odds_client: OddsClient = Depends(odds_client_dependency),
    snapshot_store: SnapshotStore = Depends(snapshot_store_dependency),
) -> OddsResponse:
    cached_terminal_odds = await snapshot_store.get_latest_odds_snapshot_for_terminal_event(
        event_id=event_id
    )
    if cached_terminal_odds is not None:
        logger.info(
            "odds_request_served_from_cache",
            event_id=event_id,
            reason="terminal_match_snapshot",
        )
        return cached_terminal_odds
    if await snapshot_store.is_event_terminal(event_id=event_id):
        logger.info(
            "odds_request_not_scraped",
            event_id=event_id,
            reason="terminal_match_without_cached_odds",
        )
        raise HTTPException(
            status_code=404,
            detail="No cached odds snapshot found for terminal match.",
        )

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
            odds_latency_histogram.record(latency_ms, attributes={"event_id": event_id, "outcome": "error"})
            odds_error_counter.add(1, attributes={"event_id": event_id, "error_type": exc.code})
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
            odds_error_counter.add(1, attributes={"event_id": event_id, "error_type": "unexpected"})
            logger.exception(
                "odds_request_unexpected_error",
                event_id=event_id,
                latency_ms=latency_ms,
            )
            raise HTTPException(
                status_code=500,
                detail="Unexpected internal error while retrieving odds.",
            )

        latency_ms = (time.perf_counter() - start_time) * 1000
        odds_latency_histogram.record(latency_ms, attributes={"event_id": event_id, "outcome": "success"})
        logger.info(
            "odds_request_completed",
            event_id=event_id,
            latency_ms=latency_ms,
        )

    odds_response = map_odds_payload(event_id=event_id, payload=response_json)
    try:
        await snapshot_store.save_odds_snapshot(
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


@app.get("/match-stats/{event_id}", response_model=MatchStatsResponse)
async def get_match_stats(
    event_id: str,
    match_stats_client: MatchStatsClient = Depends(match_stats_client_dependency),
    snapshot_store: SnapshotStore = Depends(snapshot_store_dependency),
) -> MatchStatsResponse:
    cached_terminal_stats = await snapshot_store.get_terminal_match_stats_snapshot(
        event_id=event_id
    )
    if cached_terminal_stats is not None:
        logger.info(
            "match_stats_request_served_from_cache",
            event_id=event_id,
            reason="terminal_snapshot",
        )
        return cached_terminal_stats

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
            )

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
        await snapshot_store.save_match_stats_snapshot(
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


@app.get("/storage/odds/{event_id}")
async def list_odds_snapshots(
    event_id: str,
    limit: int = Query(default=25, ge=1, le=200),
    snapshot_store: SnapshotStore = Depends(snapshot_store_dependency),
) -> dict[str, object]:
    snapshots = await snapshot_store.list_odds_snapshots(event_id=event_id, limit=limit)
    return {"event_id": event_id, "count": len(snapshots), "snapshots": snapshots}


@app.get("/storage/match-stats/{event_id}")
async def list_match_stats_snapshots(
    event_id: str,
    limit: int = Query(default=25, ge=1, le=200),
    snapshot_store: SnapshotStore = Depends(snapshot_store_dependency),
) -> dict[str, object]:
    snapshots = await snapshot_store.list_match_stats_snapshots(event_id=event_id, limit=limit)
    return {"event_id": event_id, "count": len(snapshots), "snapshots": snapshots}


@app.post("/bulk-scrape/jobs")
async def create_bulk_scrape_job(
    payload: BulkScrapeJobCreateRequest,
    bulk_scrape_manager: BulkScrapeManager = Depends(bulk_scrape_manager_dependency),
) -> dict[str, object]:
    if not payload.include_stats and not payload.include_odds:
        raise HTTPException(
            status_code=422,
            detail="At least one of include_stats/include_odds must be true.",
        )

    try:
        job = await bulk_scrape_manager.create_job(
            config=BulkScrapeJobConfig(
                competition_path=payload.competition_path,
                seasons=payload.seasons,
                include_stats=payload.include_stats,
                include_odds=payload.include_odds,
                max_concurrency=payload.max_concurrency,
            )
        )
        return job
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("bulk_scrape_job_create_failed", error=str(exc))
        raise HTTPException(
            status_code=500,
            detail="Failed to create bulk scrape job.",
        ) from exc


@app.get("/bulk-scrape/jobs", response_model=BulkScrapeJobListResponse)
async def list_bulk_scrape_jobs(
    limit: int = Query(default=20, ge=1, le=100),
    bulk_scrape_manager: BulkScrapeManager = Depends(bulk_scrape_manager_dependency),
) -> BulkScrapeJobListResponse:
    jobs = await bulk_scrape_manager.list_jobs(limit=limit)
    return BulkScrapeJobListResponse(total=len(jobs), jobs=jobs)


@app.get("/bulk-scrape/jobs/{job_id}", response_model=BulkScrapeJobDetail)
async def get_bulk_scrape_job(
    job_id: int,
    include_events: bool = Query(default=True),
    event_limit: int = Query(default=500, ge=1, le=5000),
    bulk_scrape_manager: BulkScrapeManager = Depends(bulk_scrape_manager_dependency),
) -> BulkScrapeJobDetail:
    job = await bulk_scrape_manager.get_job(
        job_id=job_id,
        include_events=include_events,
        event_limit=event_limit,
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Bulk scrape job not found.")

    if not include_events:
        job["events"] = []

    return BulkScrapeJobDetail(**job)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
