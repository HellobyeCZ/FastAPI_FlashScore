from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

import httpx

from app.config import get_settings


RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


@dataclass
class CachedStats:
    payload: str
    expires_at: datetime


class StatsAPIError(Exception):
    """Base exception for upstream stats service failures."""

    def __init__(
        self,
        *,
        message: str,
        status_code: int,
        code: str,
        upstream_status: Optional[int] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.upstream_status = upstream_status
        self.retry_after = retry_after

    def to_dict(self) -> Dict[str, object]:
        payload: Dict[str, object] = {
            "code": self.code,
            "message": self.message,
        }
        if self.upstream_status is not None:
            payload["upstream_status"] = self.upstream_status
        if self.retry_after is not None:
            payload["retry_after"] = self.retry_after
        return payload


class MatchStatsClient:
    def __init__(
        self,
        *,
        base_url: str,
        feed_sign: str,
        timeout: Optional[httpx.Timeout] = None,
        max_retries: int = 3,
        backoff_factor: float = 0.5,
        max_backoff: float = 8.0,
        cache_ttl: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._feed_sign = feed_sign
        self._timeout = timeout or httpx.Timeout(connect=3.0, read=10.0, write=5.0, pool=3.0)
        self._max_retries = max_retries
        self._backoff_factor = backoff_factor
        self._max_backoff = max_backoff
        self._cache_ttl = cache_ttl
        self._cache: Dict[str, CachedStats] = {}
        self._cache_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=self._timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_match_stats(self, event_id: str) -> str:
        cached = await self._get_cached(event_id)
        if cached is not None:
            return cached

        last_error: Optional[Exception] = None
        url = f"{self._base_url}/df_st_1_{event_id}"
        headers = {"x-fsign": self._feed_sign}

        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.get(url, headers=headers)
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == self._max_retries:
                    raise StatsAPIError(
                        message="Unable to contact upstream match stats service.",
                        status_code=504,
                        code="upstream_connection_error",
                    ) from exc
                await asyncio.sleep(self._compute_backoff(attempt))
                continue

            if response.status_code == httpx.codes.OK:
                payload = response.text
                if not payload:
                    raise StatsAPIError(
                        message="Upstream match stats service returned an empty payload.",
                        status_code=502,
                        code="upstream_empty_payload",
                        upstream_status=response.status_code,
                    )

                await self._set_cache(event_id, payload)
                return payload

            retry_after_seconds = self._parse_retry_after(response)
            if response.status_code in {429, 503}:
                if attempt == self._max_retries:
                    raise StatsAPIError(
                        message="Upstream match stats service temporarily unavailable.",
                        status_code=response.status_code,
                        code="upstream_unavailable",
                        upstream_status=response.status_code,
                        retry_after=retry_after_seconds,
                    )
                await asyncio.sleep(self._compute_backoff(attempt, retry_after_seconds))
                continue

            if response.status_code in RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                await asyncio.sleep(self._compute_backoff(attempt, retry_after_seconds))
                continue

            raise StatsAPIError(
                message="Upstream match stats service responded with an error.",
                status_code=502,
                code="upstream_http_error",
                upstream_status=response.status_code,
                retry_after=retry_after_seconds,
            )

        raise StatsAPIError(
            message="Failed to retrieve match stats after retries.",
            status_code=502,
            code="upstream_retry_exhausted",
        ) from last_error

    async def _get_cached(self, event_id: str) -> Optional[str]:
        if self._cache_ttl <= 0:
            return None
        async with self._cache_lock:
            cached = self._cache.get(event_id)
            if not cached:
                return None
            now = datetime.now(timezone.utc)
            if cached.expires_at < now:
                del self._cache[event_id]
                return None
            return cached.payload

    async def _set_cache(self, event_id: str, payload: str) -> None:
        if self._cache_ttl <= 0:
            return
        async with self._cache_lock:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._cache_ttl)
            self._cache[event_id] = CachedStats(payload=payload, expires_at=expires_at)

    def _compute_backoff(self, attempt: int, retry_after: Optional[float] = None) -> float:
        if retry_after is not None:
            return min(retry_after, self._max_backoff)
        backoff = self._backoff_factor * (2**attempt)
        return min(backoff, self._max_backoff)

    @staticmethod
    def _parse_retry_after(response: httpx.Response) -> Optional[float]:
        header = response.headers.get("retry-after")
        if not header:
            return None
        try:
            return float(header)
        except ValueError:
            from email.utils import parsedate_to_datetime

            try:
                dt = parsedate_to_datetime(header)
            except (TypeError, ValueError):
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = dt - datetime.now(timezone.utc)
            return max(delta.total_seconds(), 0.0)


def build_match_stats_client() -> MatchStatsClient:
    settings = get_settings()
    stats_feed_base = settings._resolve_value(settings.stats_feed_base)
    stats_feed_sign = settings._resolve_value(settings.stats_feed_sign)
    timeout = httpx.Timeout(connect=3.0, read=15.0, write=5.0, pool=3.0)
    return MatchStatsClient(
        base_url=str(stats_feed_base),
        feed_sign=str(stats_feed_sign),
        timeout=timeout,
        max_retries=3,
        backoff_factor=0.75,
        max_backoff=10.0,
        cache_ttl=30.0,
    )
