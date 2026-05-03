"""Logging, telemetry, and correlation-id middleware.

Extracted from src.py during Task 13 of the VPS migration. Owns:

- Structured-logging configuration (`configure_logging`).
- OpenTelemetry tracer/meter singletons with no-op fallbacks for environments
  where the SDK is not installed.
- The OTLP exporter wiring driven by `OTEL_EXPORTER_OTLP_ENDPOINT`
  (`configure_telemetry`).
- Correlation-id ContextVars and the FastAPI middleware that binds them.
- Latency histograms / error counters used by the route handlers.
"""

from __future__ import annotations

import logging
import logging.config
import os
import time
import uuid
from contextvars import ContextVar
from typing import Any

import structlog
from fastapi import FastAPI, Request

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
    FastAPIInstrumentor = None  # type: ignore[assignment,misc]
    HTTPXClientInstrumentor = None  # type: ignore[assignment,misc]
    MeterProvider = None  # type: ignore[assignment,misc]
    PeriodicExportingMetricReader = None  # type: ignore[assignment,misc]
    Resource = None  # type: ignore[assignment,misc]
    TracerProvider = None  # type: ignore[assignment,misc]
    BatchSpanProcessor = None  # type: ignore[assignment,misc]


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
    def __enter__(self) -> _NoopSpan:
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None


class _NoopTracer:
    def start_as_current_span(self, *args: Any, **kwargs: Any) -> _NoopSpan:
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


CORRELATION_ID_HEADER = "x-correlation-id"
CORRELATION_ID_RESPONSE_HEADER = "X-Correlation-ID"
TRACEPARENT_HEADER = "traceparent"

correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)
traceparent_var: ContextVar[str | None] = ContextVar("traceparent", default=None)


_telemetry_instrumented = False


def configure_telemetry(app: FastAPI) -> None:
    """Initialise OpenTelemetry instrumentation. OTLP exporter is configured via env vars."""
    telemetry_logger = structlog.get_logger("telemetry")
    if not _OPENTELEMETRY_AVAILABLE:
        telemetry_logger.info("telemetry_disabled", reason="opentelemetry_not_installed")
        return

    global _telemetry_instrumented
    if not _telemetry_instrumented:
        FastAPIInstrumentor.instrument_app(app, excluded_urls="/health,/health/ready")
        HTTPXClientInstrumentor().instrument()
        _telemetry_instrumented = True

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        telemetry_logger.info("otlp_disabled", reason="no_endpoint")
        return

    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    resource = Resource.create(
        {"service.name": os.getenv("OTEL_SERVICE_NAME", "fastapi-flashscore")}
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(provider)
    telemetry_logger.info("otlp_configured", endpoint=endpoint)


# Module-level tracer/meter — used by route handlers via `from app.observability import tracer`.
if _OPENTELEMETRY_AVAILABLE:
    tracer = trace.get_tracer(__name__)
    meter = metrics.get_meter("fastapi_flashscore.odds_client")
else:
    tracer = _NoopTracer()  # type: ignore[assignment]
    meter = _NoopMeter()  # type: ignore[assignment]

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


def get_correlation_id() -> str | None:
    return correlation_id_var.get()


def get_traceparent() -> str | None:
    return traceparent_var.get()


async def correlation_id_middleware(request: Request, call_next: Any) -> Any:
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
