"""BulkScrapeManager.cancel_job, POST /bulk-scrape/jobs/{id}/cancel and
readable job error messages. No test here reaches FlashScore: discovery,
odds and stats clients are fakes."""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Iterator, List

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services.bulk_scrape import (
    BulkScrapeDiscoveryError,
    BulkScrapeJobConfig,
    BulkScrapeJobNotActiveError,
    BulkScrapeManager,
    describe_error,
)
from app.services.odds_client import OddsAPIError
from app.services.storage import SnapshotStore


class _BlockingDiscovery:
    """Discovery that parks until cancelled, so the job task is running."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = False

    async def discover_event_ids(self, *, competition_path: str, seasons: int) -> List[dict]:
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return []

    async def aclose(self) -> None:
        return None


class _UnusedClient:
    def __getattr__(self, name: str):
        raise AssertionError(f"upstream client must not be used ({name})")


def _store(tmp_path: Path) -> SnapshotStore:
    db = tmp_path / "snap.sqlite3"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE odds_snapshots (id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT)")
        c.execute(
            "CREATE TABLE match_stats_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT, is_terminal INTEGER DEFAULT 0)"
        )
    return SnapshotStore(str(db))


def _manager(store: SnapshotStore, discovery: _BlockingDiscovery) -> BulkScrapeManager:
    manager = BulkScrapeManager(
        snapshot_store=store,
        odds_client=_UnusedClient(),  # type: ignore[arg-type]
        match_stats_client=_UnusedClient(),  # type: ignore[arg-type]
    )
    manager._discovery_client = discovery  # type: ignore[assignment]
    return manager


_CONFIG = BulkScrapeJobConfig(
    competition_path="football/spain/laliga",
    seasons=1,
    include_stats=True,
    include_odds=True,
    max_concurrency=1,
)


def test_cancel_running_job(tmp_path: Path):
    async def scenario() -> None:
        store = _store(tmp_path)
        await store.initialize()
        discovery = _BlockingDiscovery()
        manager = _manager(store, discovery)
        try:
            job = await manager.create_job(config=_CONFIG)
            await asyncio.wait_for(discovery.started.wait(), timeout=5)

            cancelled = await manager.cancel_job(job_id=job["id"])
            assert cancelled is not None
            assert cancelled["status"] == "cancelled"
            assert cancelled["finished_at"] is not None
            assert discovery.cancelled is True
            assert job["id"] not in manager._job_tasks

            # A late terminal write from an in-flight worker cannot undo it.
            await store.mark_bulk_scrape_job_finished(job_id=job["id"], status="completed")
            await store.mark_bulk_scrape_job_failed(job_id=job["id"], error="late")
            latest = await store.get_bulk_scrape_job(job_id=job["id"])
            assert latest["status"] == "cancelled"
            assert latest["last_error"] is None

            # Cancelled jobs are not resumed on restart.
            assert job["id"] not in await store.list_resumable_bulk_scrape_job_ids()

            with pytest.raises(BulkScrapeJobNotActiveError) as exc_info:
                await manager.cancel_job(job_id=job["id"])
            assert exc_info.value.status == "cancelled"
        finally:
            await manager.shutdown()

    asyncio.run(scenario())


def test_cancel_unknown_and_finished_jobs(tmp_path: Path):
    async def scenario() -> None:
        store = _store(tmp_path)
        await store.initialize()
        manager = _manager(store, _BlockingDiscovery())
        try:
            assert await manager.cancel_job(job_id=999) is None

            job_id = await store.create_bulk_scrape_job(
                competition_path="football/spain/laliga", seasons=1,
                include_stats=True, include_odds=True, max_concurrency=1,
            )
            await store.mark_bulk_scrape_job_finished(job_id=job_id, status="completed_with_errors")
            with pytest.raises(BulkScrapeJobNotActiveError) as exc_info:
                await manager.cancel_job(job_id=job_id)
            assert exc_info.value.status == "completed_with_errors"
        finally:
            await manager.shutdown()

    asyncio.run(scenario())


def test_cancel_resets_running_events_to_pending(tmp_path: Path):
    async def scenario() -> None:
        store = _store(tmp_path)
        await store.initialize()
        job_id = await store.create_bulk_scrape_job(
            competition_path="football/spain/laliga", seasons=1,
            include_stats=True, include_odds=True, max_concurrency=1,
        )
        await store.replace_bulk_scrape_job_events(
            job_id=job_id,
            events=[("E1", None), ("E2", None)],
        )
        await store.mark_bulk_scrape_job_running(job_id=job_id)
        await store.mark_bulk_scrape_event_running(job_id=job_id, event_id="E1")

        assert await store.cancel_bulk_scrape_job(job_id=job_id) is True
        job = await store.get_bulk_scrape_job(job_id=job_id)
        assert job["status"] == "cancelled"
        assert job["running_events"] == 0
        assert job["pending_events"] == 2

        # A worker that had not started yet cannot flip an event to running.
        await store.mark_bulk_scrape_event_running(job_id=job_id, event_id="E2")
        assert (await store.get_bulk_scrape_job(job_id=job_id))["running_events"] == 0
        assert await store.cancel_bulk_scrape_job(job_id=job_id) is False

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

class _FakeManager:
    def __init__(self) -> None:
        self.calls: List[int] = []

    async def cancel_job(self, *, job_id: int):
        self.calls.append(job_id)
        if job_id == 1:
            return {
                "id": 1, "competition_path": "football/spain/laliga", "seasons": 1,
                "include_stats": True, "include_odds": True, "max_concurrency": 1,
                "status": "cancelled", "created_at": "2026-10-11T10:00:00+00:00",
                "updated_at": "2026-10-11T10:05:00+00:00",
                "finished_at": "2026-10-11T10:05:00+00:00", "total_events": 10,
                "pending_events": 6, "succeeded_events": 3, "failed_events": 0,
                "skipped_events": 1, "running_events": 0,
            }
        if job_id == 2:
            raise BulkScrapeJobNotActiveError(2, "completed")
        return None


@pytest.fixture
def route_client(tmp_path: Path, monkeypatch) -> Iterator[tuple]:
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(tmp_path / "snap.sqlite3"))
    # App startup also starts the backtest manager, which needs its tables.
    asyncio.run(_store(tmp_path).initialize())
    from app.config import get_settings
    get_settings.cache_clear()

    import src

    src._get_backtest_manager.cache_clear()
    fake = _FakeManager()
    src.app.dependency_overrides[src.bulk_scrape_manager_dependency] = lambda: fake
    try:
        with TestClient(src.app) as client:
            yield client, fake
    finally:
        src.app.dependency_overrides.pop(src.bulk_scrape_manager_dependency, None)
        src._get_backtest_manager.cache_clear()


def test_cancel_route_statuses(route_client):
    client, fake = route_client
    ok = client.post("/bulk-scrape/jobs/1/cancel")
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "cancelled"
    assert ok.json()["skipped_events"] == 1

    conflict = client.post("/bulk-scrape/jobs/2/cancel")
    assert conflict.status_code == 409
    assert "already completed" in conflict.json()["detail"]

    assert client.post("/bulk-scrape/jobs/3/cancel").status_code == 404
    assert fake.calls == [1, 2, 3]


# ---------------------------------------------------------------------------
# Error messages
# ---------------------------------------------------------------------------

def test_describe_error_names_the_exception_and_status():
    request = httpx.Request("GET", "https://example.invalid/")
    assert describe_error(httpx.ReadTimeout("", request=request)) == "ReadTimeout"
    assert describe_error(
        BulkScrapeDiscoveryError("Unexpected status 503.", status_code=503)
    ) == "BulkScrapeDiscoveryError (HTTP 503): Unexpected status 503."
    upstream = OddsAPIError(message="rate limited", status_code=502, code="upstream", upstream_status=429)
    assert describe_error(upstream) == "OddsAPIError (HTTP 429): rate limited"
    response = httpx.Response(404, request=request)
    status_error = httpx.HTTPStatusError("not found", request=request, response=response)
    assert describe_error(status_error) == "HTTPStatusError (HTTP 404): not found"
