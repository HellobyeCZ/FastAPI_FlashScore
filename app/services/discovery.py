"""FlashScore season/event discovery — lifted from the legacy bulk_scrape module.

The discovery client scrapes the FlashScore archive page for a competition,
extracts season URLs, and pulls the per-season `results/` page (and pagination
data parts) to enumerate match event IDs. This is the read-only side of bulk
scraping; per-event scraping itself runs as Arq tasks (see app/workers/tasks.py).
"""
from __future__ import annotations

import contextlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import TypeVar
from urllib.parse import urljoin, urlparse

import httpx

from app.config import get_settings

_FLASHSCORE_BASE_URL = "https://www.flashscore.com"
_EVENT_ID_PATTERN = re.compile(r"AA÷([A-Za-z0-9]{8})")
_ARCHIVE_SEASON_LINK_PATTERN = re.compile(
    r'<a[^>]*class="[^"]*archiveLatte__text--clickable[^"]*"[^>]*href="([^"]+)"',
    flags=re.IGNORECASE,
)
_RESULTS_SPORT_ID_PATTERN = re.compile(r"sportId:\s*(\d+)")
_RESULTS_COUNTRY_ID_PATTERN = re.compile(r"country_id:\s*(\d+)")
_RESULTS_TOURNAMENT_ID_PATTERN = re.compile(r'tournament_id:\s*"([A-Za-z0-9]+)"')
_RESULTS_ALL_EVENTS_COUNT_PATTERN = re.compile(r"allEventsCount:\s*(\d+)")
_RESULTS_SEASON_ID_PATTERN = re.compile(r"seasonId:\s*(\d+)")
_HTML_LANG_PATTERN = re.compile(r'<html[^>]*\blang="([a-zA-Z-]+)"', flags=re.IGNORECASE)
_PROJECT_TYPE_ID_PATTERN = re.compile(r'"project_type"\s*:\s*\{\s*"id"\s*:\s*(\d+)')
_MAX_RESULTS_DATA_PARTS = 250
_DEFAULT_PROJECT_TYPE_ID = 1

_T = TypeVar("_T")


class BulkScrapeDiscoveryError(Exception):
    pass


@dataclass(frozen=True)
class _ResultsFeedDescriptor:
    sport_id: int
    country_id: int
    tournament_id: str
    season_id: int
    all_events_count: int
    timezone_hour: int
    language: str
    project_type_id: int


@dataclass(frozen=True)
class _ResultsFeedVariant:
    timezone_hour: int
    language: str
    project_type_id: int


class FlashscoreDiscoveryClient:
    def __init__(self) -> None:
        timeout = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)
        settings = get_settings()
        stats_feed_base = settings._resolve_value(settings.stats_feed_base)
        stats_feed_sign = settings._resolve_value(settings.stats_feed_sign)
        default_headers = settings._resolve_value(settings.default_headers)

        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers=default_headers,
        )
        self._stats_feed_base = str(stats_feed_base).rstrip("/")
        self._stats_feed_sign = str(stats_feed_sign)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def discover_event_ids(
        self,
        *,
        competition_path: str,
        seasons: int,
    ) -> list[tuple[str, str | None]]:
        normalized_path = self._normalize_competition_path(competition_path)
        archive_url = f"{_FLASHSCORE_BASE_URL}/{normalized_path}/archive/"
        archive_html = await self._fetch_html(archive_url)
        season_paths = self._extract_season_paths(archive_html, fallback_path=normalized_path)

        selected_paths = season_paths[:seasons]
        if not selected_paths:
            raise BulkScrapeDiscoveryError(
                f"No season paths found for '{competition_path}'."
            )

        results: list[tuple[str, str | None]] = []
        seen_event_ids: set[str] = set()

        for season_path in selected_paths:
            results_url = self._build_results_url(season_path)
            season_html = await self._fetch_html(results_url)
            season_event_ids = self._extract_event_ids(season_html)
            if season_event_ids:
                season_event_ids = await self._expand_results_event_ids(
                    initial_event_ids=season_event_ids,
                    results_html=season_html,
                )

            for event_id in season_event_ids:
                if event_id in seen_event_ids:
                    continue
                seen_event_ids.add(event_id)
                results.append((event_id, season_path))

        if not results:
            raise BulkScrapeDiscoveryError(
                f"No match event IDs found for '{competition_path}' within {seasons} season(s)."
            )

        return results

    async def _fetch_html(self, url: str) -> str:
        try:
            response = await self._client.get(url)
        except httpx.RequestError as exc:
            raise BulkScrapeDiscoveryError(f"Could not fetch '{url}': {exc}") from exc

        if response.status_code != httpx.codes.OK:
            raise BulkScrapeDiscoveryError(
                f"Unexpected status {response.status_code} while fetching '{url}'."
            )

        return response.text

    @staticmethod
    def _normalize_competition_path(raw_path: str) -> str:
        candidate = (raw_path or "").strip()
        if not candidate:
            raise BulkScrapeDiscoveryError("Competition path is required.")

        if "://" in candidate:
            parsed = urlparse(candidate)
            candidate = parsed.path or ""

        candidate = candidate.strip("/")
        if not candidate:
            raise BulkScrapeDiscoveryError("Competition path is required.")

        for suffix in ("/archive", "/results", "/fixtures", "/standings"):
            if candidate.endswith(suffix):
                candidate = candidate[: -len(suffix)]
                break

        return candidate.strip("/")

    @staticmethod
    def _extract_season_paths(html: str, *, fallback_path: str) -> list[str]:
        season_paths: list[str] = []
        seen: set[str] = set()

        for href in _ARCHIVE_SEASON_LINK_PATTERN.findall(html):
            if not href or "/team/" in href or "/player/" in href:
                continue
            normalized = href.strip()
            if not normalized.startswith("/"):
                continue
            normalized = normalized.rstrip("/") + "/"
            if normalized in seen:
                continue
            seen.add(normalized)
            season_paths.append(normalized)

        if season_paths:
            return season_paths

        fallback = "/" + fallback_path.strip("/") + "/"
        return [fallback]

    @staticmethod
    def _build_results_url(season_path: str) -> str:
        clean_path = season_path.strip()
        if not clean_path:
            raise BulkScrapeDiscoveryError("Season path is empty.")
        if not clean_path.endswith("/"):
            clean_path += "/"
        return urljoin(_FLASHSCORE_BASE_URL, f"{clean_path.lstrip('/')}results/")

    @staticmethod
    def _extract_event_ids(html: str) -> list[str]:
        event_ids: list[str] = []
        seen: set[str] = set()
        for event_id in _EVENT_ID_PATTERN.findall(html):
            if event_id in seen:
                continue
            seen.add(event_id)
            event_ids.append(event_id)
        return event_ids

    async def _expand_results_event_ids(
        self,
        *,
        initial_event_ids: Sequence[str],
        results_html: str,
    ) -> list[str]:
        descriptor = self._extract_results_feed_descriptor(results_html)
        ordered_ids = list(initial_event_ids)
        seen_ids = set(ordered_ids)
        if descriptor is None:
            return ordered_ids

        if descriptor.all_events_count <= len(ordered_ids):
            return ordered_ids

        selected_variant: _ResultsFeedVariant | None = None
        for data_part in range(2, _MAX_RESULTS_DATA_PARTS + 1):
            payload, selected_variant = await self._fetch_results_data_part(
                descriptor=descriptor,
                data_part=data_part,
                selected_variant=selected_variant,
            )
            if not payload:
                break

            part_event_ids = self._extract_event_ids(payload)
            if not part_event_ids:
                break

            added = 0
            for event_id in part_event_ids:
                if event_id in seen_ids:
                    continue
                seen_ids.add(event_id)
                ordered_ids.append(event_id)
                added += 1

            if added == 0:
                break
            if len(ordered_ids) >= descriptor.all_events_count:
                break

        return ordered_ids

    async def _fetch_results_data_part(
        self,
        *,
        descriptor: _ResultsFeedDescriptor,
        data_part: int,
        selected_variant: _ResultsFeedVariant | None,
    ) -> tuple[str, _ResultsFeedVariant | None]:
        variants = (
            [selected_variant]
            if selected_variant is not None
            else self._build_results_feed_variants(descriptor)
        )

        for variant in variants:
            if variant is None:
                continue
            payload = await self._request_results_data_part(
                descriptor=descriptor,
                variant=variant,
                data_part=data_part,
            )
            if payload:
                return payload, variant

        return "", selected_variant

    async def _request_results_data_part(
        self,
        *,
        descriptor: _ResultsFeedDescriptor,
        variant: _ResultsFeedVariant,
        data_part: int,
    ) -> str:
        feed_path = (
            f"tr_{descriptor.sport_id}_{descriptor.country_id}_{descriptor.tournament_id}_"
            f"{descriptor.season_id}_{data_part}_{variant.timezone_hour}_{variant.language}_"
            f"{variant.project_type_id}"
        )
        url = f"{self._stats_feed_base}/{feed_path}"
        headers = {
            "x-fsign": self._stats_feed_sign,
            "Accept": "*/*",
            "Referer": f"{_FLASHSCORE_BASE_URL}/",
            "Origin": _FLASHSCORE_BASE_URL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        }

        try:
            response = await self._client.get(url, headers=headers)
        except httpx.RequestError:
            return ""

        if response.status_code != httpx.codes.OK:
            return ""
        return response.text or ""

    def _build_results_feed_variants(
        self, descriptor: _ResultsFeedDescriptor
    ) -> list[_ResultsFeedVariant]:
        local_timezone = self._system_timezone_hour()
        timezone_candidates = self._dedupe_preserve_order(
            [
                descriptor.timezone_hour,
                local_timezone,
                0,
                1,
                2,
                -1,
                -2,
                3,
            ]
        )
        language_candidates = self._dedupe_preserve_order([descriptor.language, "en"])
        project_type_candidates = self._dedupe_preserve_order(
            [descriptor.project_type_id, _DEFAULT_PROJECT_TYPE_ID, 2]
        )

        variants: list[_ResultsFeedVariant] = []
        for timezone_hour in timezone_candidates:
            for language in language_candidates:
                for project_type_id in project_type_candidates:
                    variants.append(
                        _ResultsFeedVariant(
                            timezone_hour=timezone_hour,
                            language=language,
                            project_type_id=project_type_id,
                        )
                    )
        return variants

    @staticmethod
    def _extract_results_feed_descriptor(html: str) -> _ResultsFeedDescriptor | None:
        sport_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_SPORT_ID_PATTERN, html)
        country_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_COUNTRY_ID_PATTERN, html)
        season_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_SEASON_ID_PATTERN, html)
        all_events_count = FlashscoreDiscoveryClient._extract_int(
            _RESULTS_ALL_EVENTS_COUNT_PATTERN, html
        )
        tournament_match = _RESULTS_TOURNAMENT_ID_PATTERN.search(html)
        tournament_id = tournament_match.group(1).strip() if tournament_match else ""
        if (
            sport_id is None
            or country_id is None
            or season_id is None
            or all_events_count is None
            or not tournament_id
        ):
            return None

        language_match = _HTML_LANG_PATTERN.search(html)
        language = (
            FlashscoreDiscoveryClient._normalize_language(language_match.group(1))
            if language_match
            else "en"
        )
        project_type_id = (
            FlashscoreDiscoveryClient._extract_int(_PROJECT_TYPE_ID_PATTERN, html)
            or _DEFAULT_PROJECT_TYPE_ID
        )

        return _ResultsFeedDescriptor(
            sport_id=sport_id,
            country_id=country_id,
            tournament_id=tournament_id,
            season_id=season_id,
            all_events_count=all_events_count,
            timezone_hour=0,
            language=language,
            project_type_id=project_type_id,
        )

    @staticmethod
    def _extract_int(pattern: re.Pattern[str], text: str) -> int | None:
        match = pattern.search(text)
        if not match:
            return None
        with contextlib.suppress(ValueError):
            return int(match.group(1))
        return None

    @staticmethod
    def _normalize_language(value: str) -> str:
        token = (value or "").strip().lower()
        if not token:
            return "en"
        return token.split("-", 1)[0]

    @staticmethod
    def _system_timezone_hour() -> int:
        now = datetime.now().astimezone()
        offset = now.utcoffset()
        if offset is None:
            return 0
        return int(offset.total_seconds() // 3600)

    @staticmethod
    def _dedupe_preserve_order(values: Sequence[_T]) -> list[_T]:
        deduped: list[_T] = []
        seen: set[_T] = set()
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            deduped.append(value)
        return deduped
