import json
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
from app.services.bulk_scrape import (
    BulkScrapeJobConfig,
    BulkScrapeManager,
    LiveOddsScheduler,
    build_live_odds_scheduler_from_settings,
)
from app.services.refresh_now import RefreshNowManager
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
from app.services.backtest_manager import BacktestManager, CreateRunParams
from app.schemas.backtest import (
    CreateBacktestRunRequest,
    BacktestRunSummary,
    BacktestRunDetail,
    BacktestRunListResponse,
    BacktestBetDTO,
    BacktestBetListResponse,
    ReliabilityBucketDTO,
)
from app.ml.models import names as analytic_model_names
from app.ml.trainable import TRAINABLE

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

try:
    from azure.monitor.opentelemetry.exporter import (
        AzureMonitorLogExporter,
        AzureMonitorMetricExporter,
        AzureMonitorTraceExporter,
    )
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler, set_logger_provider
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
except ImportError:  # pragma: no cover - optional dependency guard
    AzureMonitorLogExporter = None
    AzureMonitorMetricExporter = None
    AzureMonitorTraceExporter = None
    LoggerProvider = None
    LoggingHandler = None
    set_logger_provider = None
    BatchLogRecordProcessor = None


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

    connection_string = os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING")
    if not connection_string:
        telemetry_logger.info("azure_monitor_disabled", reason="missing_connection_string")
        return

    if not all(
        (
            AzureMonitorTraceExporter,
            AzureMonitorMetricExporter,
            AzureMonitorLogExporter,
            LoggerProvider,
            LoggingHandler,
            set_logger_provider,
            BatchLogRecordProcessor,
        )
    ):
        telemetry_logger.warning(
            "azure_monitor_unavailable",
            reason="azure-monitor-opentelemetry-exporter not installed",
        )
        return

    resource = Resource.create({"service.name": "fastapi-flashscore"})

    tracer_provider = TracerProvider(resource=resource)
    trace.set_tracer_provider(tracer_provider)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(AzureMonitorTraceExporter(connection_string=connection_string))
    )

    metric_exporter = AzureMonitorMetricExporter(connection_string=connection_string)
    metric_reader = PeriodicExportingMetricReader(metric_exporter)
    metrics_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(metrics_provider)

    log_exporter = AzureMonitorLogExporter(connection_string=connection_string)
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
    set_logger_provider(logger_provider)

    root_logger = logging.getLogger()
    if not any(isinstance(handler, LoggingHandler) for handler in root_logger.handlers):
        root_logger.addHandler(LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider))

    telemetry_logger.info("azure_monitor_configured")


app = FastAPI(title="FastAPI Project", version="0.1.0")
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


@lru_cache()
def _get_live_odds_scheduler() -> LiveOddsScheduler:
    return build_live_odds_scheduler_from_settings(
        snapshot_store=_get_snapshot_store(),
        odds_client=_get_odds_client(),
    )


def odds_client_dependency() -> OddsClient:
    return _get_odds_client()


def match_stats_client_dependency() -> MatchStatsClient:
    return _get_match_stats_client()


def snapshot_store_dependency() -> SnapshotStore:
    return _get_snapshot_store()


def bulk_scrape_manager_dependency() -> BulkScrapeManager:
    return _get_bulk_scrape_manager()


@lru_cache()
def _get_refresh_now_manager() -> RefreshNowManager:
    return RefreshNowManager()


def refresh_now_manager_dependency() -> RefreshNowManager:
    return _get_refresh_now_manager()


@lru_cache()
def _get_ml_artifacts():
    """Load Phase 3 trained models from $APP_ML_MODELS_DIR. Cached so
    repeated /predict calls don't re-load from disk."""
    from app.ml.serving import load_models
    return load_models()


@lru_cache(maxsize=1)
def _get_backtest_manager() -> BacktestManager:
    return BacktestManager()


def backtest_manager_dependency() -> BacktestManager:
    return _get_backtest_manager()


@app.on_event("startup")
async def startup_snapshot_store() -> None:
    await _get_snapshot_store().initialize()
    await _get_bulk_scrape_manager().start()
    await _get_live_odds_scheduler().start()
    await _get_backtest_manager().start()
    # Pre-warm the model artifacts so the first /predict request doesn't
    # pay the load latency. Failing to load is non-fatal — the endpoint
    # returns the available subset.
    try:
        _get_ml_artifacts()
    except Exception:
        structlog.get_logger("ml").exception("ml_artifacts_load_failed_at_startup")


@app.on_event("shutdown")
async def shutdown_odds_client() -> None:
    await _get_live_odds_scheduler().shutdown()
    await _get_bulk_scrape_manager().shutdown()
    await _get_backtest_manager().shutdown()
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


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Hello World"}


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


# ---------------------------------------------------------------------------
# Backtest routes
# ---------------------------------------------------------------------------

def _run_row_to_summary(row) -> BacktestRunSummary:
    return BacktestRunSummary(
        id=row.id,
        label=row.label,
        model=row.model,
        status=row.status,
        created_at=row.created_at,
        train_until=row.train_until,
        test_until=row.test_until,
        started_at=row.started_at,
        finished_at=row.finished_at,
        error=row.error,
        test_events=row.test_events,
        total_bets=row.total_bets,
        hit_rate=row.hit_rate,
        roi=row.roi,
        mean_clv=row.mean_clv,
        brier=row.brier,
        log_loss=row.log_loss,
        max_drawdown=row.max_drawdown,
        stage=row.stage,
        market_spec=row.market_spec,
    )


@app.get("/backtest/models")
async def list_backtest_models() -> dict:
    items = [
        {"name": name, "kind": "analytic"} for name in analytic_model_names()
    ]
    items.extend(
        {"name": name, "kind": "trainable"} for name in sorted(TRAINABLE.keys())
    )
    return {"items": items}


@app.post("/backtest/runs")
async def create_backtest_run(
    body: CreateBacktestRunRequest,
    mgr: BacktestManager = Depends(backtest_manager_dependency),
) -> dict:
    params_kwargs = dict(
        model=body.model,
        train_until=body.train_until,
        test_until=body.test_until,
        min_edge=body.min_edge,
        kelly_fraction=body.kelly_fraction,
        force_bets=body.force_bets,
        label=body.label,
        scope=body.scope,
    )
    if body.market_spec is not None:
        params_kwargs["market_spec"] = body.market_spec
    run_id = await mgr.create_run(CreateRunParams(**params_kwargs))
    return {"id": run_id}


@app.get("/backtest/runs", response_model=BacktestRunListResponse)
async def list_backtest_runs(
    limit: int = 50,
    mgr: BacktestManager = Depends(backtest_manager_dependency),
) -> BacktestRunListResponse:
    rows = await mgr.list_runs(limit=limit)
    return BacktestRunListResponse(items=[_run_row_to_summary(r) for r in rows])


@app.get("/backtest/runs/{run_id}", response_model=BacktestRunDetail)
async def get_backtest_run(
    run_id: str,
    mgr: BacktestManager = Depends(backtest_manager_dependency),
) -> BacktestRunDetail:
    row = await mgr.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    summary = _run_row_to_summary(row).model_dump()
    reliability = []
    if row.reliability_json:
        reliability = [ReliabilityBucketDTO(**b) for b in json.loads(row.reliability_json)]
    scope = [tuple(x) for x in json.loads(row.scope_json)]
    return BacktestRunDetail(
        **summary,
        min_edge=row.min_edge,
        kelly_fraction=row.kelly_fraction,
        force_bets=bool(row.force_bets),
        scope=scope,
        reliability_buckets=reliability,
    )


@app.get("/backtest/runs/{run_id}/bets", response_model=BacktestBetListResponse)
async def list_backtest_bets(
    run_id: str,
    offset: int = 0,
    limit: int = 200,
    mgr: BacktestManager = Depends(backtest_manager_dependency),
) -> BacktestBetListResponse:
    rows, total = await mgr.list_bets(run_id, offset=offset, limit=limit)
    return BacktestBetListResponse(
        items=[BacktestBetDTO(
            run_id=r.run_id, event_id=r.event_id, bet_ts=r.bet_ts,
            kickoff_ts=r.kickoff_ts, market=r.market, selection=r.selection,
            price_taken=r.price_taken, closing_price=r.closing_price,
            model_prob=r.model_prob, implied_prob=r.implied_prob,
            devigged_prob=r.devigged_prob, edge=r.edge,
            stake_kelly_fraction=r.stake_kelly_fraction,
            result=r.result, pnl=r.pnl, clv=r.clv,
        ) for r in rows],
        total=total,
        offset=offset,
        limit=limit,
    )


@app.delete("/backtest/runs/{run_id}")
async def delete_backtest_run(
    run_id: str,
    mgr: BacktestManager = Depends(backtest_manager_dependency),
) -> dict:
    row = await mgr.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    if row.status in ("queued", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"cannot delete a run with status={row.status!r}; cancel first",
        )
    await mgr.delete_run(run_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# One-button refresh: scrape upcoming → settle pending → predict + record
# ---------------------------------------------------------------------------

@app.post("/refresh-now")
async def start_refresh_now(
    window_days: int = Query(default=7, ge=1, le=30),
    max_concurrency: int = Query(default=4, ge=1, le=16),
    hours_ahead: int = Query(default=72, ge=1, le=240),
    min_edge: float = Query(default=0.02, ge=0.0, le=1.0),
    manager: RefreshNowManager = Depends(refresh_now_manager_dependency),
) -> dict[str, object]:
    """Kick off the scrape → settle → predict pipeline in the background.

    Returns immediately with a ``run_id`` the caller can poll. If a refresh is
    already running, returns that run instead of starting a second one.
    """
    run = manager.start(
        window_days=window_days,
        max_concurrency=max_concurrency,
        hours_ahead=hours_ahead,
        min_edge=min_edge,
    )
    return run.to_dict()


@app.get("/refresh-now")
async def list_refresh_now(
    manager: RefreshNowManager = Depends(refresh_now_manager_dependency),
) -> dict[str, object]:
    runs = manager.recent(limit=10)
    active = manager.active_run()
    return {
        "active_run_id": active.run_id if active is not None else None,
        "runs": [r.to_dict() for r in runs],
    }


@app.get("/refresh-now/{run_id}")
async def get_refresh_now(
    run_id: str,
    manager: RefreshNowManager = Depends(refresh_now_manager_dependency),
) -> dict[str, object]:
    run = manager.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Refresh run not found.")
    return run.to_dict()


# ---------------------------------------------------------------------------
# Phase 4: serving endpoints — /predict and /picks/upcoming
# ---------------------------------------------------------------------------

def _serialize_prediction(record) -> dict:
    return {
        "model": record.model,
        "market": record.market,
        "selection": record.selection,
        "model_prob": record.model_prob,
        "market_price": record.market_price,
        "market_implied": record.market_implied,
        "market_devigged": record.market_devigged,
        "edge": record.edge,
        "kelly_full": record.kelly_full,
        "notes": record.notes,
    }


@app.get("/predict/{event_id}")
async def predict_event(event_id: str) -> dict:
    """Run every loaded model on the given event and return per
    (model, market, selection) predictions. ``market_*`` fields reflect
    the freshest live_odds_snapshot — None if no live snapshot exists
    yet for the event."""
    from app.ml.serving import predict_event as run_predict

    artifacts = _get_ml_artifacts()
    records = run_predict(event_id, artifacts)
    return {
        "event_id": event_id,
        "predictions": [_serialize_prediction(r) for r in records],
        "available_models": {
            "logistic": artifacts.logistic is not None,
            "hgb": artifacts.hgb is not None,
            "dixon_coles": artifacts.dc_rates is not None,
        },
    }


@app.get("/picks/upcoming")
async def picks_upcoming(
    hours_ahead: int = Query(default=72, ge=1, le=336),
    min_edge: float = Query(default=0.02, ge=0.0, le=1.0),
    model: Optional[str] = Query(default=None,
                                 description="Filter to one model (logistic|hgb|dixon_coles)"),
    market: Optional[str] = Query(default=None,
                                  description="Filter to one market (1X2_FT|OVER_UNDER_2.5_FT|BTTS_FT)"),
) -> dict:
    """List edge-positive picks across all loaded models for events
    kicking off in the next ``hours_ahead``. Only selections where
    ``edge >= min_edge`` are returned."""
    from app.ml.serving import list_upcoming_events, predict_event as run_predict

    artifacts = _get_ml_artifacts()
    upcoming = list_upcoming_events(hours_ahead=hours_ahead)
    picks: list = []
    for fx in upcoming:
        event_id = fx["event_id"]
        records = run_predict(event_id, artifacts)
        for r in records:
            if r.edge is None or r.edge < min_edge:
                continue
            if model and r.model != model:
                continue
            if market and r.market != market:
                continue
            picks.append({
                **_serialize_prediction(r),
                "event_id": event_id,
                "kickoff": fx["start_time_utc"],
                "competition_path": fx["competition_path"],
                "home_team_raw": fx["home_team_raw"],
                "away_team_raw": fx["away_team_raw"],
            })
    return {
        "hours_ahead": hours_ahead,
        "min_edge": min_edge,
        "events_considered": len(upcoming),
        "pick_count": len(picks),
        "picks": picks,
    }


@app.get("/picks/history")
async def picks_history(
    status: Optional[str] = Query(default=None, description="pending|settled|voided"),
    limit: int = Query(default=200, ge=1, le=5000),
    source: str = Query(default="live"),
    run_id: Optional[str] = Query(default=None),
    run_ids: Optional[str] = Query(default=None),
) -> dict:
    """Return paper_bets rows for the dashboard. Filterable by status.

    Pass ``source=backtest`` plus ``run_ids=<csv>`` (or single ``run_id=<id>``)
    to read from one or more backtest runs instead of live paper bets.
    Each row is stamped with its run's model name. ``source=both`` mixes
    live with the named backtest runs.
    """
    ids = _resolve_run_ids(run_ids, run_id)
    if source in ("backtest", "both"):
        if not ids:
            raise HTTPException(status_code=400, detail="run_ids required when source=backtest|both")
        mgr = _get_backtest_manager()
        all_rows: list = []
        per_run_limit = max(1, limit // len(ids))  # roughly even share across runs
        for rid in ids:
            run = await mgr.get_run(rid)
            if run is None:
                raise HTTPException(status_code=404, detail=f"backtest run {rid!r} not found")
            bets, _total = await mgr.list_bets(rid, offset=0, limit=per_run_limit)
            for b in bets:
                all_rows.append({
                    "id": f"{rid}_{b.event_id}_{b.market}_{b.selection}",
                    "event_id": b.event_id,
                    "market": b.market,
                    "selection": b.selection,
                    "recommended_at": b.bet_ts,
                    "price_at_recommendation": b.price_taken,
                    "model_prob": b.model_prob,
                    "edge": b.edge,
                    "result": b.result,
                    "pnl": b.pnl,
                    "clv": b.clv,
                    "status": "settled",
                    "model": run.model,
                })
        return {"count": len(all_rows), "rows": all_rows[:limit]}

    from app.ml.paper_trade import fetch_paper_bets

    rows = fetch_paper_bets(status=status, limit=limit)
    return {"count": len(rows), "rows": rows}


@app.get("/picks/summary")
async def picks_summary() -> dict:
    """Aggregate paper_bets stats: totals, per-model and per-market
    breakdowns, settled time-series for the cumulative P&L / CLV
    dashboard chart."""
    from app.ml.paper_trade import fetch_summary

    return fetch_summary()


@app.get("/picks/stats")
async def picks_stats(
    group_by: Optional[str] = Query(default=None),
    status: str = Query(default="settled"),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    model: Optional[str] = Query(default=None),
    market: Optional[str] = Query(default=None),
    sport: Optional[str] = Query(default=None),
    country: Optional[str] = Query(default=None),
    competition: Optional[str] = Query(default=None),
    selection: Optional[str] = Query(default=None),
    edge_min: Optional[float] = Query(default=None),
    edge_max: Optional[float] = Query(default=None),
    price_min: Optional[float] = Query(default=None),
    price_max: Optional[float] = Query(default=None),
    min_n_per_group: int = Query(default=1, ge=1),
    source: str = Query(default="live"),
    run_id: Optional[str] = Query(default=None),
    run_ids: Optional[str] = Query(default=None),
) -> dict:
    """Aggregation over paper_bets. ``group_by`` is a comma-separated
    list of dimensions; multi-value filters are comma-separated too.

    Pass ``source=backtest`` plus ``run_ids=<csv>`` (or ``run_id=<id>`` for a
    single run) to aggregate over one or more backtest runs instead of live
    paper bets. ``source=both`` overlays live with the named backtest runs.
    When multiple backtest runs are selected, include ``"model"`` in
    ``group_by`` so the response carries a model name per row.
    """
    def _csv(value: Optional[str]) -> tuple:
        if not value:
            return ()
        return tuple(v.strip() for v in value.split(",") if v.strip())

    if source == "backtest":
        ids = _resolve_run_ids(run_ids, run_id)
        if not ids:
            raise HTTPException(status_code=400, detail="run_ids required when source=backtest")
        from app.ml.backtest_stats import (
            aggregate_backtest,
            BacktestStatsRequest,
            BacktestStatsFilter,
        )
        gb_tuple = _csv(group_by)
        try:
            bt_req = BacktestStatsRequest(
                run_ids=ids,
                filters=BacktestStatsFilter(
                    market=_csv(market),
                    sport=_csv(sport),
                    country=_csv(country),
                    competition=_csv(competition),
                    selection=_csv(selection),
                    edge_min=edge_min,
                    edge_max=edge_max,
                    price_min=price_min,
                    price_max=price_max,
                    date_from=date_from,
                    date_to=date_to,
                ),
                group_by=gb_tuple,
                min_n_per_group=min_n_per_group,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        rows = aggregate_backtest(bt_req)
        # When model is not in group_by but exactly one run is selected,
        # stamp the run's model so legacy single-run callers still get a
        # labelled leaderboard row. Multi-run callers must include
        # "model" in group_by.
        if "model" not in gb_tuple and len(ids) == 1:
            mgr = _get_backtest_manager()
            run = await mgr.get_run(ids[0])
            if run is not None:
                for r in rows:
                    r["model"] = run.model
        return {
            "group_by": list(bt_req.group_by),
            "filters": {
                "status": "settled",
                "date_from": date_from,
                "date_to": date_to,
                "model": [],
                "market": list(bt_req.filters.market),
                "sport": list(bt_req.filters.sport),
                "country": list(bt_req.filters.country),
                "competition": list(bt_req.filters.competition),
                "selection": list(bt_req.filters.selection),
                "edge_min": edge_min,
                "edge_max": edge_max,
                "price_min": price_min,
                "price_max": price_max,
            },
            "rows": rows,
        }

    from app.ml.paper_trade_stats import StatsFilter, StatsRequest, aggregate

    if source == "both":
        ids = _resolve_run_ids(run_ids, run_id)
        if not ids:
            raise HTTPException(status_code=400, detail="run_ids required when source=both")

        # Live side
        try:
            live_req = StatsRequest(
                group_by=_csv(group_by),
                filters=StatsFilter(
                    status=status,
                    date_from=date_from,
                    date_to=date_to,
                    model=_csv(model),
                    market=_csv(market),
                    sport=_csv(sport),
                    country=_csv(country),
                    competition=_csv(competition),
                    selection=_csv(selection),
                    edge_min=edge_min,
                    edge_max=edge_max,
                    price_min=price_min,
                    price_max=price_max,
                ),
                min_n_per_group=min_n_per_group,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        live_rows = aggregate(live_req)
        for r in live_rows:
            r["origin"] = "live"

        # Backtest side
        from app.ml.backtest_stats import (
            aggregate_backtest,
            BacktestStatsRequest,
            BacktestStatsFilter,
        )
        gb_tuple = _csv(group_by)
        try:
            bt_req = BacktestStatsRequest(
                run_ids=ids,
                filters=BacktestStatsFilter(
                    market=_csv(market),
                    sport=_csv(sport),
                    country=_csv(country),
                    competition=_csv(competition),
                    selection=_csv(selection),
                    edge_min=edge_min,
                    edge_max=edge_max,
                    price_min=price_min,
                    price_max=price_max,
                    date_from=date_from,
                    date_to=date_to,
                ),
                group_by=gb_tuple,
                min_n_per_group=min_n_per_group,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        bt_rows = aggregate_backtest(bt_req)
        # Suffix " (backtest)" onto model labels so the same model name
        # appearing in both live and backtest rows is visually distinct.
        single_run_model: Optional[str] = None
        if "model" not in gb_tuple and len(ids) == 1:
            mgr = _get_backtest_manager()
            single_run = await mgr.get_run(ids[0])
            if single_run is not None:
                single_run_model = single_run.model
        for r in bt_rows:
            r["origin"] = "backtest"
            if "model" in gb_tuple and r.get("model"):
                r["model"] = f"{r['model']} (backtest)"
            elif single_run_model is not None:
                r["model"] = f"{single_run_model} (backtest)"

        return {
            "group_by": list(_csv(group_by)),
            "filters": {
                "status": status,
                "date_from": date_from,
                "date_to": date_to,
                "model": list(_csv(model)),
                "market": list(_csv(market)),
                "sport": list(_csv(sport)),
                "country": list(_csv(country)),
                "competition": list(_csv(competition)),
                "selection": list(_csv(selection)),
                "edge_min": edge_min,
                "edge_max": edge_max,
                "price_min": price_min,
                "price_max": price_max,
            },
            "rows": live_rows + bt_rows,
        }

    try:
        request = StatsRequest(
            group_by=_csv(group_by),
            filters=StatsFilter(
                status=status,
                date_from=date_from,
                date_to=date_to,
                model=_csv(model),
                market=_csv(market),
                sport=_csv(sport),
                country=_csv(country),
                competition=_csv(competition),
                selection=_csv(selection),
                edge_min=edge_min,
                edge_max=edge_max,
                price_min=price_min,
                price_max=price_max,
            ),
            min_n_per_group=min_n_per_group,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    rows = aggregate(request)
    return {
        "group_by": list(request.group_by),
        "filters": {
            "status": status, "date_from": date_from, "date_to": date_to,
            "model": list(request.filters.model),
            "market": list(request.filters.market),
            "sport": list(request.filters.sport),
            "country": list(request.filters.country),
            "competition": list(request.filters.competition),
            "selection": list(request.filters.selection),
            "edge_min": edge_min, "edge_max": edge_max,
            "price_min": price_min, "price_max": price_max,
        },
        "rows": rows,
    }


@app.get("/picks/stats/calibration")
async def picks_stats_calibration(
    model: str = Query(...),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    market: Optional[str] = Query(default=None),
    competition: Optional[str] = Query(default=None),
    n_buckets: int = Query(default=10, ge=2, le=50),
) -> dict:
    """Calibration buckets for ``model``. Settled bets only."""
    from app.ml.paper_trade_stats import StatsFilter, calibration_buckets

    def _csv(value: Optional[str]) -> tuple:
        if not value:
            return ()
        return tuple(v.strip() for v in value.split(",") if v.strip())

    filters = StatsFilter(
        status="settled",
        date_from=date_from, date_to=date_to,
        market=_csv(market),
        competition=_csv(competition),
    )
    buckets = calibration_buckets(model=model, filters=filters, n_buckets=n_buckets)
    return {"model": model, "n_buckets": n_buckets, "buckets": buckets}


from app.ml.picks_facets import (  # noqa: E402
    FacetsResponse,
    facets_for_live,
    facets_for_backtest,
    facets_for_both,
)


def _resolve_run_ids(run_ids: Optional[str], run_id: Optional[str]) -> tuple:
    """Pick ``run_ids`` (CSV) if present, else fall back to single ``run_id``."""
    if run_ids:
        return tuple(v.strip() for v in run_ids.split(",") if v.strip())
    if run_id:
        return (run_id,)
    return ()


@app.get("/picks/facets")
async def picks_facets(
    source: str = "live",
    run_id: Optional[str] = None,
    run_ids: Optional[str] = None,
) -> dict:
    """Return distinct filter-dimension values for the picks filter bar.

    ``source`` controls which data is scanned:
    - ``live`` — ``paper_bets`` (default)
    - ``backtest`` — ``backtest_bets`` for the given run(s)
    - ``both`` — union of live + backtest (run(s) required)

    Accepts either ``run_ids=<csv>`` (preferred) or single ``run_id=<id>``
    for back-compat.
    """
    ids = _resolve_run_ids(run_ids, run_id)
    if source == "live":
        f = facets_for_live()
    elif source == "backtest":
        if not ids:
            raise HTTPException(status_code=400, detail="run_ids required when source=backtest")
        f = facets_for_backtest(ids)
    elif source == "both":
        if not ids:
            raise HTTPException(status_code=400, detail="run_ids required when source=both")
        f = facets_for_both(ids)
    else:
        raise HTTPException(status_code=400, detail=f"unknown source={source!r}")
    return {
        "models": f.models,
        "markets": f.markets,
        "sports": f.sports,
        "countries": f.countries,
        "competitions": f.competitions,
        "selections": f.selections,
    }


# You can include routers here
# from app.routers import items_router
# app.include_router(items_router.router, prefix="/items", tags=["items"])

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
