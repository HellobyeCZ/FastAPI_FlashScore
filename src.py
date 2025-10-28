import logging
import logging.config
import os
import time
import uuid
from contextvars import ContextVar
from typing import Optional

import json
import httpx  # Replaced pycurl and io
import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from opentelemetry import metrics, trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

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

    global _telemetry_instrumented
    if not _telemetry_instrumented:
        # Instrument FastAPI and HTTPX to automatically create spans.
        FastAPIInstrumentor.instrument_app(app, excluded_urls="/health")
        HTTPXClientInstrumentor().instrument()
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


def odds_client_dependency() -> OddsClient:
    return _get_odds_client()


@app.on_event("shutdown")
async def shutdown_odds_client() -> None:
    await _get_odds_client().aclose()


@app.exception_handler(OddsAPIError)
async def odds_error_handler(_: Request, exc: OddsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})

_configure_telemetry(app)

logger = structlog.get_logger("odds_client")
tracer = trace.get_tracer(__name__)
meter = metrics.get_meter("fastapi_flashscore.odds_client")
odds_latency_histogram = meter.create_histogram(
    name="odds_client_latency_ms",
    unit="ms",
    description="Latency of calls to the upstream odds provider.",
)
odds_error_counter = meter.create_counter(
    name="odds_client_errors",
    description="Number of errors encountered while calling the upstream odds provider.",
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
async def get_odds(event_id: str):  # Changed to async def
    url = f'https://global.ds.lsapp.eu/odds/pq_graphql?_hash=oce&eventId={event_id}&projectId=1&geoIpCode=CZ&geoIpSubdivisionCode=CZ10'
    headers = {
        'Accept': '*/*',
        'Sec-Fetch-Site': 'cross-site',
        'Origin': 'https://www.livesport.cz',
        'Sec-Fetch-Dest': 'empty',
        'Accept-Language': 'cs-CZ,cs;q=0.9',
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.livesport.cz/',
        'Priority': 'u=3, i'
    }

    correlation_id = get_correlation_id()
    traceparent = get_traceparent()
    if correlation_id:
        headers[CORRELATION_ID_RESPONSE_HEADER] = correlation_id
    if traceparent:
        headers[TRACEPARENT_HEADER] = traceparent

    with tracer.start_as_current_span(
        "odds.client.request",
        attributes={
            "odds.event_id": event_id,
            "http.method": "GET",
            "http.url": url,
        },
    ):
        start_time = time.perf_counter()
        async with httpx.AsyncClient() as client:
            try:
                logger.info(
                    "odds_request_started",
                    event_id=event_id,
                    url=url,
                )
                response = await client.get(url, headers=headers)
                latency_ms = (time.perf_counter() - start_time) * 1000
                response.raise_for_status()  # Raises an exception for 4XX/5XX responses
                odds_latency_histogram.record(latency_ms, attributes={"event_id": event_id})
                logger.info(
                    "odds_request_completed",
                    event_id=event_id,
                    status_code=response.status_code,
                    latency_ms=latency_ms,
                )
                response_json = response.json()
            except httpx.HTTPStatusError as e:
                latency_ms = (time.perf_counter() - start_time) * 1000
                odds_latency_histogram.record(latency_ms, attributes={"event_id": event_id, "outcome": "error"})
                odds_error_counter.add(1, attributes={"event_id": event_id, "error_type": "http_status"})
                logger.error(
                    "odds_request_http_error",
                    event_id=event_id,
                    status_code=e.response.status_code,
                    latency_ms=latency_ms,
                    exc_info=True,
                )
                raise HTTPException(status_code=e.response.status_code, detail=f"HTTP error from external API: {e}")
            except httpx.RequestError as e:
                latency_ms = (time.perf_counter() - start_time) * 1000
                odds_error_counter.add(1, attributes={"event_id": event_id, "error_type": "request"})
                logger.error(
                    "odds_request_transport_error",
                    event_id=event_id,
                    latency_ms=latency_ms,
                    exc_info=True,
                )
                raise HTTPException(status_code=500, detail=f"Request error to external API: {e}")
            except json.JSONDecodeError as e:
                odds_error_counter.add(1, attributes={"event_id": event_id, "error_type": "json_decode"})
                logger.error(
                    "odds_request_decode_error",
                    event_id=event_id,
                    exc_info=True,
                )
                raise HTTPException(status_code=500, detail=f"JSON decode error from external API: {e}")

    odds_response = map_odds_payload(event_id=event_id, payload=response_json)
    return JSONResponse(content=jsonable_encoder(odds_response))


# You can include routers here
# from app.routers import items_router
# app.include_router(items_router.router, prefix="/items", tags=["items"])

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
