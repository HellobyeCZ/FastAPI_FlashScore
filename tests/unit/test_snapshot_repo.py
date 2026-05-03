"""Unit tests for SnapshotRepo. Uses tmp_path blob store + in-memory SQLite for speed."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.blob_store import LocalBlobStore
from app.db.models import Base
from app.schemas.match_stats import MatchStatsEvent, MatchStatsResponse
from app.schemas.odds import EventOdds, OddsResponse
from app.services.snapshot_repo import SnapshotRepo


@pytest.fixture
async def repo(tmp_path: Path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    blobs = LocalBlobStore(root=tmp_path / "blobs")
    yield SnapshotRepo(session_factory=factory, blob_store=blobs)
    await engine.dispose()


async def test_save_odds_snapshot_persists_row_and_blob(repo: SnapshotRepo) -> None:
    response = OddsResponse(
        event=EventOdds(event_id="ABCD1234", bookmakers=[]),
        retrieved_at=datetime.now(timezone.utc),
        source="test",
    )
    upstream = {"raw": "payload"}
    await repo.save_odds_snapshot(
        event_id="ABCD1234",
        response=response,
        upstream_payload=upstream,
        correlation_id="corr-1",
    )
    rows = await repo.list_odds_snapshots(event_id="ABCD1234", limit=10)
    assert len(rows) == 1
    assert rows[0]["correlation_id"] == "corr-1"


async def test_terminal_short_circuit(repo: SnapshotRepo) -> None:
    response = MatchStatsResponse(
        event=MatchStatsEvent(event_id="ABCD1234", status="finished", periods=[]),
        retrieved_at=datetime.now(timezone.utc),
        source="test",
    )
    await repo.save_match_stats_snapshot(
        event_id="ABCD1234",
        response=response,
        feed_payloads={"a": "b"},
        correlation_id=None,
    )
    cached = await repo.get_terminal_match_stats_snapshot(event_id="ABCD1234")
    assert cached is not None
    assert cached.event.event_id == "ABCD1234"
