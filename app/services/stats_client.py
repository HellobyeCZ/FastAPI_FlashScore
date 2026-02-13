from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from typing import Dict, Optional, Tuple

import httpx

from app.config import get_settings


RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
OPTIONAL_FEEDS = ("df_st", "df_sur", "df_sui", "df_psp")


@dataclass
class CachedStats:
    payload: Dict[str, str]
    expires_at: datetime


@dataclass
class CachedMatchMetadata:
    metadata: MatchPageMetadata
    expires_at: datetime


@dataclass
class MatchPageMetadata:
    home_team: Optional[str] = None
    away_team: Optional[str] = None
    sport: Optional[str] = None
    country: Optional[str] = None
    competition: Optional[str] = None
    competition_stage: Optional[str] = None
    competition_path: Optional[str] = None


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
        self._metadata_cache: Dict[str, CachedMatchMetadata] = {}
        self._cache_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=self._timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_match_stats_feeds(self, event_id: str) -> Dict[str, str]:
        cached = await self._get_cached(event_id)
        if cached is not None:
            return cached

        feeds: Dict[str, str] = {}
        dc_payload = await self._fetch_feed(f"dc_1_{event_id}", required=False)
        if dc_payload:
            feeds["dc"] = dc_payload

        for feed_name in OPTIONAL_FEEDS:
            payload = await self._fetch_feed(f"{feed_name}_1_{event_id}", required=False)
            if payload:
                feeds[feed_name] = payload

        if not feeds:
            raise StatsAPIError(
                message="Upstream match stats service returned no usable payload.",
                status_code=502,
                code="upstream_empty_payload",
            )

        await self._set_cache(event_id, feeds)
        return feeds

    async def get_match_stats(self, event_id: str) -> str:
        """Backwards-compatible accessor returning the primary df_st payload if available."""
        feeds = await self.get_match_stats_feeds(event_id)
        return feeds.get("df_st", "")

    async def get_match_metadata(self, event_id: str) -> MatchPageMetadata:
        cached = await self._get_cached_metadata(event_id)
        if cached is not None:
            return cached

        url = f"https://www.flashscore.com/match/{event_id}/"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15"
            ),
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }

        try:
            response = await self._client.get(url, headers=headers, follow_redirects=True)
        except httpx.RequestError:
            return MatchPageMetadata()

        if response.status_code != httpx.codes.OK:
            return MatchPageMetadata()

        metadata = self._parse_match_page_metadata(
            html=response.text,
            resolved_url=str(response.url),
        )
        await self._set_cached_metadata(event_id, metadata)
        return metadata

    async def get_match_teams(self, event_id: str) -> Tuple[Optional[str], Optional[str]]:
        metadata = await self.get_match_metadata(event_id)
        return metadata.home_team, metadata.away_team

    async def _fetch_feed(self, feed_path: str, *, required: bool) -> Optional[str]:
        headers = {"x-fsign": self._feed_sign}
        url = f"{self._base_url}/{feed_path}"
        last_error: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.get(url, headers=headers)
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == self._max_retries:
                    if required:
                        raise StatsAPIError(
                            message="Unable to contact upstream match stats service.",
                            status_code=504,
                            code="upstream_connection_error",
                        ) from exc
                    return None
                await asyncio.sleep(self._compute_backoff(attempt))
                continue

            if response.status_code == httpx.codes.OK:
                payload = response.text
                return payload if payload else None

            if response.status_code in {404, 410} and not required:
                return None

            retry_after_seconds = self._parse_retry_after(response)
            if response.status_code in {429, 503}:
                if attempt == self._max_retries:
                    if required:
                        raise StatsAPIError(
                            message="Upstream match stats service temporarily unavailable.",
                            status_code=response.status_code,
                            code="upstream_unavailable",
                            upstream_status=response.status_code,
                            retry_after=retry_after_seconds,
                        )
                    return None
                await asyncio.sleep(self._compute_backoff(attempt, retry_after_seconds))
                continue

            if response.status_code in RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                await asyncio.sleep(self._compute_backoff(attempt, retry_after_seconds))
                continue

            if required:
                raise StatsAPIError(
                    message="Upstream match stats service responded with an error.",
                    status_code=502,
                    code="upstream_http_error",
                    upstream_status=response.status_code,
                    retry_after=retry_after_seconds,
                )
            return None

        if required:
            raise StatsAPIError(
                message="Failed to retrieve required match stats feed.",
                status_code=502,
                code="upstream_retry_exhausted",
            ) from last_error
        return None

    async def _get_cached(self, event_id: str) -> Optional[Dict[str, str]]:
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

    async def _set_cache(self, event_id: str, payload: Dict[str, str]) -> None:
        if self._cache_ttl <= 0:
            return
        async with self._cache_lock:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._cache_ttl)
            self._cache[event_id] = CachedStats(payload=payload, expires_at=expires_at)

    async def _get_cached_metadata(self, event_id: str) -> Optional[MatchPageMetadata]:
        if self._cache_ttl <= 0:
            return None
        async with self._cache_lock:
            cached = self._metadata_cache.get(event_id)
            if not cached:
                return None
            now = datetime.now(timezone.utc)
            if cached.expires_at < now:
                del self._metadata_cache[event_id]
                return None
            return cached.metadata

    async def _set_cached_metadata(
        self,
        event_id: str,
        metadata: MatchPageMetadata,
    ) -> None:
        if self._cache_ttl <= 0:
            return
        if not any(
            (
                metadata.home_team,
                metadata.away_team,
                metadata.sport,
                metadata.country,
                metadata.competition,
                metadata.competition_stage,
                metadata.competition_path,
            )
        ):
            return
        async with self._cache_lock:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._cache_ttl)
            self._metadata_cache[event_id] = CachedMatchMetadata(
                metadata=metadata,
                expires_at=expires_at,
            )

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

    @staticmethod
    def _parse_match_page_metadata(html: str, resolved_url: str) -> MatchPageMetadata:
        if not html:
            return MatchPageMetadata()

        title = MatchStatsClient._extract_title(html)
        og_title = MatchStatsClient._extract_meta_content(html, "og:title")
        og_description = MatchStatsClient._extract_meta_content(html, "og:description")

        home_team, away_team = MatchStatsClient._extract_teams(title=title, og_title=og_title)
        sport = MatchStatsClient._extract_sport(resolved_url=resolved_url, title=title)
        country, competition_full = MatchStatsClient._extract_competition_scope(og_description)
        competition, competition_stage = MatchStatsClient._split_competition_stage(competition_full)
        competition_path = MatchStatsClient._build_competition_path(
            sport=sport,
            country=country,
            competition_full=competition_full,
        )

        return MatchPageMetadata(
            home_team=home_team,
            away_team=away_team,
            sport=sport,
            country=country,
            competition=competition,
            competition_stage=competition_stage,
            competition_path=competition_path,
        )

    @staticmethod
    def _extract_title(html: str) -> Optional[str]:
        title_match = re.search(r"<title>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
        if not title_match:
            return None
        title = unescape(title_match.group(1)).strip()
        return title or None

    @staticmethod
    def _extract_meta_content(html: str, property_name: str) -> Optional[str]:
        patterns = (
            rf'<meta[^>]*property="{re.escape(property_name)}"[^>]*content="([^"]+)"',
            rf'<meta[^>]*content="([^"]+)"[^>]*property="{re.escape(property_name)}"',
        )
        for pattern in patterns:
            match = re.search(pattern, html, flags=re.IGNORECASE)
            if match:
                value = unescape(match.group(1)).strip()
                if value:
                    return value
        return None

    @staticmethod
    def _extract_teams(title: Optional[str], og_title: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if title:
            teams = MatchStatsClient._extract_teams_from_title(title)
            if teams != (None, None):
                return teams
        if og_title:
            teams = MatchStatsClient._extract_teams_from_og_title(og_title)
            if teams != (None, None):
                return teams
        return (None, None)

    @staticmethod
    def _extract_teams_from_title(title: str) -> Tuple[Optional[str], Optional[str]]:
        # Example: "Vegas Golden Knights v Los Angeles Kings 06/02/2026 | Hockey - Flashscore"
        title_match = re.match(
            r"^(?P<home>.+?)\s+v(?:s\.)?\s+(?P<away>.+?)\s+\d{1,2}/\d{1,2}/\d{4}(?:\s+\d{1,2}:\d{2})?\s+\|",
            title,
            flags=re.IGNORECASE,
        )
        if not title_match:
            return (None, None)

        home_team = title_match.group("home").strip()
        away_team = title_match.group("away").strip()
        return (home_team or None, away_team or None)

    @staticmethod
    def _extract_teams_from_og_title(og_title: str) -> Tuple[Optional[str], Optional[str]]:
        # Example: "Vegas Golden Knights - Los Angeles Kings 4:1"
        score_suffix = re.search(r"\s+\d+:\d+(?:\s*\([^)]*\))?$", og_title)
        if score_suffix:
            og_title = og_title[: score_suffix.start()].strip()

        separator_index = og_title.find(" - ")
        if separator_index < 0:
            return (None, None)

        home_team = og_title[:separator_index].strip()
        away_team = og_title[separator_index + 3 :].strip()
        return (home_team or None, away_team or None)

    @staticmethod
    def _extract_sport(resolved_url: str, title: Optional[str]) -> Optional[str]:
        path_match = re.search(r"/match/([^/]+)/", resolved_url)
        if path_match:
            return path_match.group(1).replace("-", " ").strip() or None

        if title:
            title_match = re.search(r"\|\s*(?P<sport>.+?)\s*-\s*Flashscore", title, flags=re.IGNORECASE)
            if title_match:
                return title_match.group("sport").strip() or None

        return None

    @staticmethod
    def _extract_competition_scope(og_description: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if not og_description:
            return (None, None)

        if ":" not in og_description:
            return (None, og_description.strip() or None)

        country, competition = og_description.split(":", 1)
        country = country.strip() or None
        competition = competition.strip() or None
        return (country, competition)

    @staticmethod
    def _split_competition_stage(competition_full: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if not competition_full:
            return (None, None)

        if " - " not in competition_full:
            return (competition_full.strip() or None, None)

        competition, stage = competition_full.rsplit(" - ", 1)
        competition = competition.strip() or None
        stage = stage.strip() or None
        if not competition:
            return (competition_full.strip() or None, None)
        return (competition, stage)

    @staticmethod
    def _build_competition_path(
        *,
        sport: Optional[str],
        country: Optional[str],
        competition_full: Optional[str],
    ) -> Optional[str]:
        parts = [part for part in (sport, country, competition_full) if part]
        if not parts:
            return None
        return "/".join(part.upper() for part in parts)


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
