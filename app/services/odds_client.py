import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import httpx


RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


@dataclass
class CachedOdds:
    payload: Any
    expires_at: datetime


class OddsAPIError(Exception):
    """Base exception for upstream odds service failures."""

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

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
        }
        if self.upstream_status is not None:
            payload["upstream_status"] = self.upstream_status
        if self.retry_after is not None:
            payload["retry_after"] = self.retry_after
        return payload


class OddsClient:
    """HTTP client responsible for retrieving odds from the upstream service.

    The client centralises timeout configuration, retry semantics and short-term
    caching so that the FastAPI layer can remain thin. The in-memory cache keeps
    recent responses for a configurable TTL, but it can be replaced with an
    external store such as Redis or Azure Cache if the deployment environment
    requires horizontal scaling.
    """

    def __init__(
        self,
        *,
        base_url: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[httpx.Timeout] = None,
        default_params: Optional[Dict[str, Any]] = None,
        max_retries: int = 3,
        backoff_factor: float = 0.5,
        max_backoff: float = 8.0,
        cache_ttl: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = headers or {}
        self._timeout = timeout or httpx.Timeout(connect=3.0, read=10.0, write=5.0, pool=3.0)
        self._max_retries = max_retries
        self._backoff_factor = backoff_factor
        self._max_backoff = max_backoff
        self._cache_ttl = cache_ttl
        self._default_params = default_params or {}
        self._cache: Dict[str, CachedOdds] = {}
        self._cache_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=self._timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_odds(self, event_id: str) -> Any:
        cached = await self._get_cached(event_id)
        if cached is not None:
            return cached

        last_error: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            try:
                params = {**self._default_params, "eventId": event_id}
                response = await self._client.get(
                    self._base_url,
                    headers=self._headers,
                    params=params,
                )
            except httpx.RequestError as exc:  # network issue, retry if possible
                last_error = exc
                if attempt == self._max_retries:
                    raise OddsAPIError(
                        message="Unable to contact upstream odds service.",
                        status_code=504,
                        code="upstream_connection_error",
                    ) from exc
                await asyncio.sleep(self._compute_backoff(attempt))
                continue

            if response.status_code == httpx.codes.OK:
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise OddsAPIError(
                        message="Upstream odds service returned invalid JSON.",
                        status_code=502,
                        code="upstream_invalid_payload",
                        upstream_status=response.status_code,
                    ) from exc

                await self._set_cache(event_id, payload)
                return payload

            retry_after_seconds = self._parse_retry_after(response)

            if response.status_code in {429, 503}:
                message = "Upstream odds service temporarily unavailable."
                if attempt == self._max_retries:
                    raise OddsAPIError(
                        message=message,
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

            # Non-retryable error from upstream
            raise OddsAPIError(
                message="Upstream odds service responded with an error.",
                status_code=502,
                code="upstream_http_error",
                upstream_status=response.status_code,
                retry_after=retry_after_seconds,
            )

        # If loop exits without returning or raising, raise final error
        raise OddsAPIError(
            message="Failed to retrieve odds after retries.",
            status_code=502,
            code="upstream_retry_exhausted",
        ) from last_error

    async def _get_cached(self, event_id: str) -> Optional[Any]:
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

    async def _set_cache(self, event_id: str, payload: Any) -> None:
        if self._cache_ttl <= 0:
            return
        async with self._cache_lock:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._cache_ttl)
            self._cache[event_id] = CachedOdds(payload=payload, expires_at=expires_at)

    def _compute_backoff(self, attempt: int, retry_after: Optional[float] = None) -> float:
        if retry_after is not None:
            return min(retry_after, self._max_backoff)
        backoff = self._backoff_factor * (2 ** attempt)
        return min(backoff, self._max_backoff)

    @staticmethod
    def _parse_retry_after(response: httpx.Response) -> Optional[float]:
        header = response.headers.get("retry-after")
        if not header:
            return None
        try:
            return float(header)
        except ValueError:
            # Support HTTP-date formatted values (RFC 7231)
            from email.utils import parsedate_to_datetime

            try:
                dt = parsedate_to_datetime(header)
            except (TypeError, ValueError):
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = dt - datetime.now(timezone.utc)
            return max(delta.total_seconds(), 0.0)


def build_odds_client() -> OddsClient:
    """Factory used by FastAPI dependency injection.

    This factory keeps the configuration in one place so it can be swapped for
    a different caching backend or alternate retry policy without touching the
    FastAPI route layer.
    """
    headers = {
        "Accept": "*/*",
        "Sec-Fetch-Site": "cross-site",
        "Origin": "https://www.livesport.cz",
        "Sec-Fetch-Dest": "empty",
        "Accept-Language": "cs-CZ,cs;q=0.9",
        "Sec-Fetch-Mode": "cors",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15"
        ),
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.livesport.cz/",
        "Priority": "u=3, i",
    }
    timeout = httpx.Timeout(connect=3.0, read=15.0, write=5.0, pool=3.0)

    default_params = {
        "_hash": "oce",
        "projectId": "1",
        "geoIpCode": "CZ",
        "geoIpSubdivisionCode": "CZ10",
    }

    return OddsClient(
        base_url="https://global.ds.lsapp.eu/odds/pq_graphql",
        headers=headers,
        timeout=timeout,
        default_params=default_params,
        max_retries=3,
        backoff_factor=0.75,
        max_backoff=10.0,
        cache_ttl=30.0,
    )
