"""FastAPI application factory."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.v1 import bulk_scrape, health, match_stats, odds
from app.observability import (
    configure_logging,
    configure_telemetry,
    correlation_id_middleware,
)
from app.services.odds_client import OddsAPIError
from app.services.stats_client import StatsAPIError

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Eager-init singletons so the first request isn't slow.
    from app.dependencies import (
        get_match_stats_client,
        get_odds_client,
        get_snapshot_repo,
    )

    get_snapshot_repo()
    get_odds_client()
    get_match_stats_client()
    try:
        yield
    finally:
        await get_odds_client().aclose()
        await get_match_stats_client().aclose()


app = FastAPI(title="FastAPI FlashScore", version="0.2.0", lifespan=lifespan)
configure_telemetry(app)
app.middleware("http")(correlation_id_middleware)


@app.exception_handler(OddsAPIError)
async def odds_error_handler(_: Request, exc: OddsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


@app.exception_handler(StatsAPIError)
async def stats_error_handler(_: Request, exc: StatsAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


app.include_router(health.router)
app.include_router(odds.router)
app.include_router(match_stats.router)
app.include_router(bulk_scrape.router)
