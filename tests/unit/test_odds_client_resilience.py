"""Tests for rate limiting and circuit breaker behavior on OddsClient."""
from __future__ import annotations

import asyncio
import time

import pytest
import respx

from app.services.odds_client import OddsAPIError, OddsClient


async def test_rate_limiter_caps_requests_per_second() -> None:
    """5 requests with rate=2/sec must take at least ~2 seconds."""
    client = OddsClient(
        base_url="https://example.com",
        rate_limit_per_second=2,
        max_retries=0,
        cache_ttl=0,
    )
    with respx.mock:
        respx.get("https://example.com").respond(json={"ok": True})
        start = time.perf_counter()
        await asyncio.gather(*(client.get_odds(f"e{i}") for i in range(5)))
        elapsed = time.perf_counter() - start
    await client.aclose()
    assert elapsed >= 1.5, f"rate limit not enforced (elapsed={elapsed:.2f}s)"


async def test_circuit_breaker_opens_after_consecutive_5xx() -> None:
    """After breaker_failure_threshold consecutive 500s, further calls fail fast."""
    client = OddsClient(
        base_url="https://example.com",
        max_retries=0,
        cache_ttl=0,
        breaker_failure_threshold=3,
        breaker_reset_after_seconds=10,
    )
    with respx.mock:
        respx.get("https://example.com").respond(status_code=500)
        for _ in range(3):
            with pytest.raises(OddsAPIError):
                await client.get_odds("e1")
        # Breaker should now be open. Next call raises immediately without HTTP request.
        respx.get("https://example.com").respond(status_code=200, json={"ok": True})
        with pytest.raises(OddsAPIError) as exc_info:
            await client.get_odds("e1")
        assert "circuit_open" in exc_info.value.code
    await client.aclose()
