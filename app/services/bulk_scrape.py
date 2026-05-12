from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urljoin, urlparse

import httpx

from app.config import get_settings
from app.services.match_stats import map_match_stats_payload
from app.services.odds import map_odds_payload
from app.services.odds_client import OddsAPIError, OddsClient
from app.services.stats_client import MatchPageMetadata, MatchStatsClient
from app.services.storage import SnapshotStore

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


@dataclass(frozen=True)
class BulkScrapeJobConfig:
    competition_path: str
    seasons: int
    include_stats: bool
    include_odds: bool
    max_concurrency: int


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

        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15"
                ),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
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
    ) -> List[Tuple[str, Optional[str]]]:
        normalized_path = self._normalize_competition_path(competition_path)
        archive_url = f"{_FLASHSCORE_BASE_URL}/{normalized_path}/archive/"
        archive_html = await self._fetch_html(archive_url)
        season_paths = self._extract_season_paths(archive_html, fallback_path=normalized_path)

        selected_paths = season_paths[:seasons]
        if not selected_paths:
            raise BulkScrapeDiscoveryError(
                f"No season paths found for '{competition_path}'."
            )

        results: List[Tuple[str, Optional[str]]] = []
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
    def _extract_season_paths(html: str, *, fallback_path: str) -> List[str]:
        season_paths: List[str] = []
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
    def _extract_event_ids(html: str) -> List[str]:
        event_ids: List[str] = []
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
    ) -> List[str]:
        descriptor = self._extract_results_feed_descriptor(results_html)
        ordered_ids = list(initial_event_ids)
        seen_ids = set(ordered_ids)
        if descriptor is None:
            return ordered_ids

        if descriptor.all_events_count <= len(ordered_ids):
            return ordered_ids

        selected_variant: Optional[_ResultsFeedVariant] = None
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
        selected_variant: Optional[_ResultsFeedVariant],
    ) -> Tuple[str, Optional[_ResultsFeedVariant]]:
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

    def _build_results_feed_variants(self, descriptor: _ResultsFeedDescriptor) -> List[_ResultsFeedVariant]:
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

        variants: List[_ResultsFeedVariant] = []
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
    def _extract_results_feed_descriptor(html: str) -> Optional[_ResultsFeedDescriptor]:
        sport_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_SPORT_ID_PATTERN, html)
        country_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_COUNTRY_ID_PATTERN, html)
        season_id = FlashscoreDiscoveryClient._extract_int(_RESULTS_SEASON_ID_PATTERN, html)
        all_events_count = FlashscoreDiscoveryClient._extract_int(_RESULTS_ALL_EVENTS_COUNT_PATTERN, html)
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
    def _extract_int(pattern: re.Pattern[str], text: str) -> Optional[int]:
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
    def _dedupe_preserve_order(values: Sequence[int | str]) -> List[int | str]:
        deduped: List[int | str] = []
        seen: set[int | str] = set()
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            deduped.append(value)
        return deduped


class BulkScrapeManager:
    def __init__(
        self,
        *,
        snapshot_store: SnapshotStore,
        odds_client: OddsClient,
        match_stats_client: MatchStatsClient,
    ) -> None:
        self._snapshot_store = snapshot_store
        self._odds_client = odds_client
        self._match_stats_client = match_stats_client
        self._discovery_client = FlashscoreDiscoveryClient()
        self._task_lock = asyncio.Lock()
        self._job_tasks: Dict[int, asyncio.Task[None]] = {}
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        resumable_job_ids = await self._snapshot_store.list_resumable_bulk_scrape_job_ids()
        for job_id in resumable_job_ids:
            await self._spawn_job(job_id)

    async def shutdown(self) -> None:
        async with self._task_lock:
            tasks = list(self._job_tasks.values())
            self._job_tasks.clear()

        for task in tasks:
            task.cancel()
        if tasks:
            with contextlib.suppress(Exception):
                await asyncio.gather(*tasks, return_exceptions=True)

        await self._discovery_client.aclose()

    async def create_job(self, *, config: BulkScrapeJobConfig) -> Dict[str, object]:
        if not config.include_stats and not config.include_odds:
            raise ValueError("At least one of include_stats/include_odds must be enabled.")

        job_id = await self._snapshot_store.create_bulk_scrape_job(
            competition_path=config.competition_path,
            seasons=config.seasons,
            include_stats=config.include_stats,
            include_odds=config.include_odds,
            max_concurrency=config.max_concurrency,
        )
        await self._spawn_job(job_id)
        created = await self._snapshot_store.get_bulk_scrape_job(job_id=job_id)
        if created is None:
            raise RuntimeError(f"Failed to load created job {job_id}.")
        return created

    async def list_jobs(self, *, limit: int = 20) -> List[Dict[str, object]]:
        jobs = await self._snapshot_store.list_bulk_scrape_jobs(limit=limit)
        return [dict(job) for job in jobs]

    async def get_job(
        self,
        *,
        job_id: int,
        include_events: bool = False,
        event_limit: int = 500,
    ) -> Optional[Dict[str, object]]:
        job = await self._snapshot_store.get_bulk_scrape_job(
            job_id=job_id,
            include_events=include_events,
            event_limit=event_limit,
        )
        return dict(job) if job else None

    async def _spawn_job(self, job_id: int) -> None:
        async with self._task_lock:
            existing = self._job_tasks.get(job_id)
            if existing and not existing.done():
                return

            task = asyncio.create_task(self._run_job(job_id))
            self._job_tasks[job_id] = task
            task.add_done_callback(lambda _: asyncio.create_task(self._remove_task(job_id)))

    async def _remove_task(self, job_id: int) -> None:
        async with self._task_lock:
            task = self._job_tasks.get(job_id)
            if task and task.done():
                self._job_tasks.pop(job_id, None)

    async def _run_job(self, job_id: int) -> None:
        try:
            params = await self._snapshot_store.get_bulk_scrape_job_params(job_id=job_id)
            if not params:
                return

            await self._snapshot_store.mark_bulk_scrape_job_running(job_id=job_id)
            await self._snapshot_store.reset_running_bulk_scrape_job_events(job_id=job_id)
            pending = await self._snapshot_store.list_bulk_scrape_pending_events(job_id=job_id)

            if not pending:
                events = await self._discovery_client.discover_event_ids(
                    competition_path=str(params["competition_path"]),
                    seasons=int(params["seasons"]),
                )
                await self._snapshot_store.replace_bulk_scrape_job_events(job_id=job_id, events=events)
                pending = await self._snapshot_store.list_bulk_scrape_pending_events(job_id=job_id)

            if not pending:
                await self._snapshot_store.mark_bulk_scrape_job_failed(
                    job_id=job_id,
                    error="No pending events available for scraping.",
                )
                return

            semaphore = asyncio.Semaphore(max(1, int(params["max_concurrency"])))

            async def process_pending(row: Dict[str, object]) -> None:
                event_id = str(row.get("event_id") or "").strip()
                if not event_id:
                    return
                async with semaphore:
                    await self._process_event(
                        job_id=job_id,
                        event_id=event_id,
                        include_stats=bool(params["include_stats"]),
                        include_odds=bool(params["include_odds"]),
                    )

            await asyncio.gather(*(process_pending(row) for row in pending))

            summary = await self._snapshot_store.get_bulk_scrape_job(job_id=job_id)
            if summary is None:
                return

            status = "completed_with_errors" if int(summary.get("failed_events", 0)) > 0 else "completed"
            await self._snapshot_store.mark_bulk_scrape_job_finished(job_id=job_id, status=status)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._snapshot_store.mark_bulk_scrape_job_failed(
                job_id=job_id,
                error=str(exc),
            )

    async def _process_event(
        self,
        *,
        job_id: int,
        event_id: str,
        include_stats: bool,
        include_odds: bool,
    ) -> None:
        await self._snapshot_store.mark_bulk_scrape_event_running(job_id=job_id, event_id=event_id)
        try:
            skipped_reasons, scraped_any = await self._scrape_event(
                job_id=job_id,
                event_id=event_id,
                include_stats=include_stats,
                include_odds=include_odds,
            )
            reason = ", ".join(skipped_reasons) if (skipped_reasons and not scraped_any) else None
            await self._snapshot_store.mark_bulk_scrape_event_succeeded(
                job_id=job_id,
                event_id=event_id,
                skipped_reason=reason,
            )
        except Exception as exc:
            await self._snapshot_store.mark_bulk_scrape_event_failed(
                job_id=job_id,
                event_id=event_id,
                error=str(exc),
            )

    async def _scrape_event(
        self,
        *,
        job_id: int,
        event_id: str,
        include_stats: bool,
        include_odds: bool,
    ) -> Tuple[List[str], bool]:
        skipped_reasons: List[str] = []
        scraped_any = False
        correlation_id = f"bulk-job-{job_id}"

        if include_stats:
            terminal_stats = await self._snapshot_store.get_terminal_match_stats_snapshot(event_id=event_id)
            if terminal_stats is not None:
                skipped_reasons.append("stats_terminal_cached")
            else:
                feed_payloads = await self._match_stats_client.get_match_stats_feeds(event_id)
                metadata = MatchPageMetadata()
                with contextlib.suppress(Exception):
                    metadata = await self._match_stats_client.get_match_metadata(event_id)

                stats_response = map_match_stats_payload(
                    event_id=event_id,
                    feed_payloads=feed_payloads,
                    home_team=metadata.home_team,
                    away_team=metadata.away_team,
                    sport=metadata.sport,
                    country=metadata.country,
                    competition=metadata.competition,
                    competition_stage=metadata.competition_stage,
                    competition_path=metadata.competition_path,
                )
                await self._snapshot_store.save_match_stats_snapshot(
                    event_id=event_id,
                    response=stats_response,
                    feed_payloads=feed_payloads,
                    correlation_id=correlation_id,
                )
                scraped_any = True

        if include_odds:
            is_terminal = await self._snapshot_store.is_event_terminal(event_id=event_id)
            if is_terminal:
                cached_terminal_odds = await self._snapshot_store.get_latest_odds_snapshot_for_terminal_event(
                    event_id=event_id
                )
                if cached_terminal_odds is not None:
                    skipped_reasons.append("odds_terminal_cached")
                    return skipped_reasons, scraped_any

            odds_payload = await self._odds_client.get_odds(event_id)
            odds_response = map_odds_payload(event_id=event_id, payload=odds_payload)
            await self._snapshot_store.save_odds_snapshot(
                event_id=event_id,
                response=odds_response,
                upstream_payload=odds_payload,
                correlation_id=correlation_id,
            )
            scraped_any = True

        return skipped_reasons, scraped_any


_FIXTURES_EVENT_BLOCK_PATTERN = re.compile(
    r"AA[÷=]([A-Za-z0-9]{8})(.*?)(?=~AA[÷=]|$)",
    flags=re.DOTALL,
)
_FIXTURES_FIELD_PATTERN = re.compile(r"([A-Z]{2,4})[÷=]([^¬~]*)")


@dataclass(frozen=True)
class UpcomingFixture:
    event_id: str
    competition_path: str
    sport: Optional[str]
    country: Optional[str]
    competition: Optional[str]
    home_team_raw: Optional[str]
    away_team_raw: Optional[str]
    start_time_utc: datetime
    round_label: Optional[str]


class FlashscoreFixturesClient:
    """Discover upcoming fixtures by scraping the inline event blocks on
    ``flashscore.com/<competition_path>/fixtures/`` pages.

    The fixtures HTML embeds a sequence of pipe-delimited event records using
    ``AA÷<event_id>¬AD÷<unix_seconds>¬…AE÷<away>¬AF÷<home>`` markers — the same
    convention the existing :class:`FlashscoreDiscoveryClient` parses for
    results pages. No paginated feed (``tr_…`` / ``tf_…``) is needed because
    the inline HTML already covers the next ~2 weeks of upcoming fixtures.
    """

    def __init__(self) -> None:
        timeout = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15"
                ),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def discover_upcoming(
        self,
        *,
        competition_path: str,
        window_days: int,
        now: Optional[datetime] = None,
    ) -> List[UpcomingFixture]:
        normalized = FlashscoreDiscoveryClient._normalize_competition_path(competition_path)
        url = f"{_FLASHSCORE_BASE_URL}/{normalized}/fixtures/"
        html = await self._fetch_html(url)
        sport, country, competition = self._derive_path_segments(normalized)
        ref = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        upper_bound = ref + timedelta(days=window_days)

        seen: set[str] = set()
        fixtures: List[UpcomingFixture] = []
        for event_id, body in _FIXTURES_EVENT_BLOCK_PATTERN.findall(html):
            if event_id in seen:
                continue
            fields = self._parse_event_fields(body)
            kickoff_raw = fields.get("AD")
            if not kickoff_raw:
                continue
            try:
                kickoff = datetime.fromtimestamp(int(kickoff_raw), tz=timezone.utc)
            except (TypeError, ValueError):
                continue
            if kickoff < ref or kickoff > upper_bound:
                continue
            seen.add(event_id)
            fixtures.append(
                UpcomingFixture(
                    event_id=event_id,
                    competition_path=normalized,
                    sport=sport,
                    country=country,
                    competition=competition,
                    home_team_raw=(fields.get("AF") or None),
                    away_team_raw=(fields.get("AE") or None),
                    start_time_utc=kickoff,
                    round_label=(fields.get("ER") or None),
                )
            )

        fixtures.sort(key=lambda fx: fx.start_time_utc)
        return fixtures

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
    def _parse_event_fields(body: str) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for key, value in _FIXTURES_FIELD_PATTERN.findall(body):
            if key not in out:
                out[key] = value.strip()
        return out

    @staticmethod
    def _derive_path_segments(
        normalized: str,
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        parts = [p for p in normalized.split("/") if p]
        sport = parts[0].replace("-", " ") if len(parts) >= 1 else None
        country = parts[1].replace("-", " ") if len(parts) >= 2 else None
        competition = parts[2].replace("-", " ") if len(parts) >= 3 else None
        return sport, country, competition


@dataclass(frozen=True)
class LiveOddsSchedulerConfig:
    enabled: bool
    interval_seconds: int
    window_days: int
    max_concurrency: int
    initial_delay_seconds: int = 30


class LiveOddsScheduler:
    """Periodically refreshes ``upcoming_fixtures`` and snapshots live odds
    for every fixture kicking off inside ``window_days`` ahead.

    One flat cadence (default 8 hours). Runs as a single :class:`asyncio.Task`
    started from FastAPI startup; ``shutdown`` cancels and awaits cleanup.
    Disabled by default — opt in via ``APP_LIVE_ODDS_ENABLED``.
    """

    def __init__(
        self,
        *,
        snapshot_store: SnapshotStore,
        odds_client: OddsClient,
        config: LiveOddsSchedulerConfig,
        fixtures_client: Optional[FlashscoreFixturesClient] = None,
    ) -> None:
        self._snapshot_store = snapshot_store
        self._odds_client = odds_client
        self._fixtures_client = fixtures_client or FlashscoreFixturesClient()
        self._config = config
        self._task: Optional[asyncio.Task[None]] = None
        self._stopping = asyncio.Event()
        self._logger = logging.getLogger("live_odds_scheduler")

    async def start(self) -> None:
        if not self._config.enabled or self._task is not None:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._run_forever())

    async def shutdown(self) -> None:
        self._stopping.set()
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(Exception):
                await task
        with contextlib.suppress(Exception):
            await self._fixtures_client.aclose()

    async def run_once(self) -> Dict[str, int]:
        """Run a single discovery + snapshot cycle and return a summary."""

        competition_paths = await self._snapshot_store.list_bulk_scrape_competition_paths()
        discovered_total = 0
        for path in competition_paths:
            discovered_total += await self._refresh_one(path)

        snapshotted_events, snapshotted_rows = await self._snapshot_live_odds_window()
        return {
            "competitions_processed": len(competition_paths),
            "fixtures_discovered_or_updated": discovered_total,
            "events_snapshotted": snapshotted_events,
            "live_rows_written": snapshotted_rows,
        }

    async def _run_forever(self) -> None:
        try:
            await asyncio.wait_for(
                self._stopping.wait(),
                timeout=max(0, self._config.initial_delay_seconds),
            )
            return
        except asyncio.TimeoutError:
            pass
        while not self._stopping.is_set():
            try:
                summary = await self.run_once()
                self._logger.info("live_odds_cycle_completed", extra=summary)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._logger.exception("live_odds_cycle_failed")

            try:
                await asyncio.wait_for(
                    self._stopping.wait(),
                    timeout=self._config.interval_seconds,
                )
            except asyncio.TimeoutError:
                continue

    async def _refresh_one(self, competition_path: str) -> int:
        try:
            fixtures = await self._fixtures_client.discover_upcoming(
                competition_path=competition_path,
                window_days=self._config.window_days,
            )
        except BulkScrapeDiscoveryError as exc:
            await self._snapshot_store.record_upcoming_discovery_run(
                competition_path=competition_path,
                fixtures_found=0,
                status="failed",
                error=str(exc),
            )
            return 0

        status = "ok" if fixtures else "empty"
        if fixtures:
            payloads = [
                {
                    "event_id": fx.event_id,
                    "sport": fx.sport,
                    "country": fx.country,
                    "competition": fx.competition,
                    "home_team_raw": fx.home_team_raw,
                    "away_team_raw": fx.away_team_raw,
                    "start_time_utc": fx.start_time_utc.isoformat(),
                    "round_label": fx.round_label,
                }
                for fx in fixtures
            ]
            await self._snapshot_store.upsert_upcoming_fixtures(
                competition_path=competition_path,
                fixtures=payloads,
            )

        await self._snapshot_store.record_upcoming_discovery_run(
            competition_path=competition_path,
            fixtures_found=len(fixtures),
            status=status,
            error=None,
        )
        return len(fixtures)

    async def _snapshot_live_odds_window(self) -> Tuple[int, int]:
        now = datetime.now(timezone.utc)
        window_end = now + timedelta(days=self._config.window_days)
        fixtures = await self._snapshot_store.list_upcoming_fixtures_for_snapshot(
            window_start_utc=now.isoformat(),
            window_end_utc=window_end.isoformat(),
        )
        if not fixtures:
            return 0, 0

        semaphore = asyncio.Semaphore(max(1, self._config.max_concurrency))
        events_done = 0
        rows_done = 0

        async def process(fixture: Dict[str, Any]) -> Tuple[int, int]:
            event_id = str(fixture["event_id"])
            async with semaphore:
                return await self._snapshot_one_event(event_id)

        for events_inc, rows_inc in await asyncio.gather(
            *(process(fx) for fx in fixtures),
            return_exceptions=False,
        ):
            events_done += events_inc
            rows_done += rows_inc
        return events_done, rows_done

    async def _snapshot_one_event(self, event_id: str) -> Tuple[int, int]:
        try:
            payload = await self._odds_client.get_odds(event_id)
        except OddsAPIError:
            return 0, 0
        except Exception:
            self._logger.exception("live_odds_fetch_unexpected_error", extra={"event_id": event_id})
            return 0, 0

        rows = self._flatten_odds_payload(payload)
        if not rows:
            return 0, 0

        fetched_at = datetime.now(timezone.utc).isoformat()
        written = await self._snapshot_store.save_live_odds_snapshot_rows(
            event_id=event_id,
            fetched_at=fetched_at,
            rows=rows,
        )
        return 1, written

    @staticmethod
    def _flatten_odds_payload(
        payload: Any,
    ) -> List[Tuple[Optional[str], str, str, float, Optional[float]]]:
        """Extract compact (bookmaker, market, selection_key, decimal_price, opening_price)
        rows from the upstream FlashScore GraphQL response.

        Shape (verified against live ``findOddsByEventId``):
            data.findOddsByEventId.odds[]
                .bookmakerId, .bettingType, .bettingScope
                .odds[]
                    .value (decimal as string), .eventParticipantId,
                    .handicap, .position, .selection
            data.findOddsByEventId.settings.bookmakers[]
                .bookmaker.{id, name}

        ``market`` is composed as ``"{bettingType}:{bettingScope}"`` to match
        the convention used by the archived ``odds_snapshots`` rows (e.g.
        ``"HOME_DRAW_AWAY:FULL_TIME"``).

        The ``selection_key`` is whichever of these is most stable:
            - ``selection`` (e.g. ``"OVER"`` / ``"UNDER"``) when present
            - else ``eventParticipantId`` (FlashScore participant ID)
            - else ``position`` (string index)
        Combined with ``handicap`` if present (to disambiguate O/U lines and
        Asian handicap variants), via ``"{base}@{handicap}"``.
        """

        rows: List[Tuple[Optional[str], str, str, float, Optional[float]]] = []
        if not isinstance(payload, dict):
            return rows

        data = payload.get("data")
        if not isinstance(data, dict):
            return rows
        container = data.get("findOddsByEventId") or data.get("findPrematchOddsById")
        if not isinstance(container, dict):
            return rows

        bookmaker_id_to_name: Dict[int, str] = {}
        settings = container.get("settings")
        if isinstance(settings, dict):
            for entry in settings.get("bookmakers") or ():
                if not isinstance(entry, dict):
                    continue
                bk_def = entry.get("bookmaker")
                if not isinstance(bk_def, dict):
                    continue
                bk_id = bk_def.get("id")
                bk_name = bk_def.get("name")
                if isinstance(bk_id, int) and isinstance(bk_name, str):
                    bookmaker_id_to_name[bk_id] = bk_name

        for market_entry in container.get("odds") or ():
            if not isinstance(market_entry, dict):
                continue
            betting_type = market_entry.get("bettingType")
            betting_scope = market_entry.get("bettingScope")
            if not betting_type or not betting_scope:
                continue
            market_key = f"{betting_type}:{betting_scope}"
            bookmaker_id = market_entry.get("bookmakerId")
            bookmaker_name: Optional[str] = None
            if isinstance(bookmaker_id, int):
                bookmaker_name = bookmaker_id_to_name.get(bookmaker_id)
                if bookmaker_name is None:
                    bookmaker_name = str(bookmaker_id)

            for outcome in market_entry.get("odds") or ():
                if not isinstance(outcome, dict):
                    continue
                if outcome.get("active") is False:
                    continue
                # Precedence: selection (OVER/UNDER/YES/NO/HOME/AWAY) →
                # eventParticipantId (participant markets) → position →
                # "DRAW" (1X2 draw row, where all three are None).
                base_selection = (
                    outcome.get("selection")
                    or outcome.get("eventParticipantId")
                    or outcome.get("position")
                    or "DRAW"
                )
                handicap_raw = outcome.get("handicap")
                handicap_value: Optional[str] = None
                if isinstance(handicap_raw, dict):
                    candidate = handicap_raw.get("value")
                    if candidate not in (None, ""):
                        handicap_value = str(candidate)
                elif handicap_raw not in (None, ""):
                    handicap_value = str(handicap_raw)
                if handicap_value is not None:
                    selection_key = f"{base_selection}@{handicap_value}"
                else:
                    selection_key = str(base_selection)

                raw_price = outcome.get("value")
                if raw_price in (None, ""):
                    continue
                try:
                    price_f = float(raw_price)
                except (TypeError, ValueError):
                    continue
                if price_f <= 1.0:
                    continue

                opening_raw = outcome.get("opening")
                opening_f: Optional[float] = None
                if opening_raw not in (None, ""):
                    try:
                        candidate = float(opening_raw)
                    except (TypeError, ValueError):
                        candidate = None
                    if candidate is not None and candidate > 1.0:
                        opening_f = candidate

                rows.append(
                    (bookmaker_name, market_key, selection_key, price_f, opening_f)
                )
        return rows


def build_live_odds_scheduler_from_settings(
    *,
    snapshot_store: SnapshotStore,
    odds_client: OddsClient,
) -> LiveOddsScheduler:
    """Construct a :class:`LiveOddsScheduler` honouring ``APP_LIVE_ODDS_*``
    settings. Defaults to disabled so local ``uvicorn`` runs don't make
    scraping requests."""

    def _bool_env(name: str, default: bool) -> bool:
        raw = os.environ.get(name)
        if raw is None:
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def _int_env(name: str, default: int) -> int:
        raw = os.environ.get(name)
        if raw is None:
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    enabled = _bool_env("APP_LIVE_ODDS_ENABLED", False)
    interval = _int_env("APP_LIVE_ODDS_INTERVAL_SECONDS", 28800)
    window = _int_env("APP_LIVE_ODDS_WINDOW_DAYS", 14)
    concurrency = _int_env("APP_LIVE_ODDS_MAX_CONCURRENCY", 4)
    initial_delay = _int_env("APP_LIVE_ODDS_INITIAL_DELAY_SECONDS", 30)

    return LiveOddsScheduler(
        snapshot_store=snapshot_store,
        odds_client=odds_client,
        config=LiveOddsSchedulerConfig(
            enabled=enabled,
            interval_seconds=max(60, interval),
            window_days=max(1, window),
            max_concurrency=max(1, concurrency),
            initial_delay_seconds=max(0, initial_delay),
        ),
    )
