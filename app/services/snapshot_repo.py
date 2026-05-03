"""Postgres-backed snapshot repository. Replaces app/services/storage.py."""
from __future__ import annotations

import json
from datetime import timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.blob_store import BlobStore
from app.db.models import (
    MatchStatsSnapshot as MatchStatsRow,
)
from app.db.models import (
    OddsSnapshot as OddsRow,
)
from app.schemas.match_stats import MatchStatsResponse
from app.schemas.odds import OddsResponse
from app.services._terminality import TERMINAL_MATCH_STATUSES


class SnapshotRepo:
    """Snapshot reads/writes against Postgres, with payload bodies in a blob store."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        blob_store: BlobStore,
    ) -> None:
        self._sessions = session_factory
        self._blobs = blob_store

    # ----- lifecycle no-ops --------------------------------------------------
    # Task 13's main.py wiring calls .initialize() / .aclose() on the legacy
    # SnapshotStore at startup/shutdown. SnapshotRepo doesn't need either
    # (the engine owns its pool, sessions are per-request), but keeping the
    # methods means the swap in Task 13 is a one-liner instead of changing
    # the lifecycle code too.

    async def initialize(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    async def save_odds_snapshot(
        self,
        *,
        event_id: str,
        response: OddsResponse,
        upstream_payload: Any,
        correlation_id: str | None,
    ) -> None:
        fetched_at = response.retrieved_at.astimezone(timezone.utc)
        upstream_bytes = json.dumps(upstream_payload).encode("utf-8")
        blob_url = await self._blobs.put(
            namespace="odds",
            key=f"{event_id}/{fetched_at.isoformat()}",
            payload=upstream_bytes,
        )
        async with self._sessions() as session:
            session.add(
                OddsRow(
                    event_id=event_id,
                    fetched_at=fetched_at,
                    source=response.source,
                    correlation_id=correlation_id,
                    odds_payload_json=response.model_dump_json(),
                    upstream_blob_url=blob_url,
                )
            )
            await session.commit()

    async def save_match_stats_snapshot(
        self,
        *,
        event_id: str,
        response: MatchStatsResponse,
        feed_payloads: dict[str, str],
        correlation_id: str | None,
    ) -> None:
        fetched_at = response.retrieved_at.astimezone(timezone.utc)
        feed_bytes = json.dumps(feed_payloads).encode("utf-8")
        blob_url = await self._blobs.put(
            namespace="match_stats",
            key=f"{event_id}/{fetched_at.isoformat()}",
            payload=feed_bytes,
        )
        is_terminal = (response.event.status or "").lower() in TERMINAL_MATCH_STATUSES
        async with self._sessions() as session:
            session.add(
                MatchStatsRow(
                    event_id=event_id,
                    fetched_at=fetched_at,
                    source=response.source,
                    correlation_id=correlation_id,
                    match_stats_payload_json=response.model_dump_json(),
                    feed_payloads_blob_url=blob_url,
                    is_terminal=is_terminal,
                )
            )
            await session.commit()

    async def list_odds_snapshots(
        self, *, event_id: str, limit: int = 25
    ) -> list[dict[str, Any]]:
        async with self._sessions() as session:
            result = await session.execute(
                select(OddsRow)
                .where(OddsRow.event_id == event_id)
                .order_by(OddsRow.id.desc())
                .limit(limit)
            )
            rows = result.scalars().all()
        return [
            {
                "id": row.id,
                "event_id": row.event_id,
                "fetched_at": row.fetched_at.isoformat(),
                "source": row.source,
                "correlation_id": row.correlation_id,
                "odds_payload_json": row.odds_payload_json,
            }
            for row in rows
        ]

    async def list_match_stats_snapshots(
        self, *, event_id: str, limit: int = 25
    ) -> list[dict[str, Any]]:
        async with self._sessions() as session:
            result = await session.execute(
                select(MatchStatsRow)
                .where(MatchStatsRow.event_id == event_id)
                .order_by(MatchStatsRow.id.desc())
                .limit(limit)
            )
            rows = result.scalars().all()
        return [
            {
                "id": row.id,
                "event_id": row.event_id,
                "fetched_at": row.fetched_at.isoformat(),
                "source": row.source,
                "correlation_id": row.correlation_id,
                "match_stats_payload_json": row.match_stats_payload_json,
                "is_terminal": row.is_terminal,
            }
            for row in rows
        ]

    async def get_terminal_match_stats_snapshot(
        self, *, event_id: str
    ) -> MatchStatsResponse | None:
        async with self._sessions() as session:
            result = await session.execute(
                select(MatchStatsRow)
                .where(MatchStatsRow.event_id == event_id)
                .where(MatchStatsRow.is_terminal.is_(True))
                .order_by(MatchStatsRow.id.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
        if row is None:
            return None
        return MatchStatsResponse.model_validate_json(row.match_stats_payload_json)

    async def get_latest_odds_snapshot_for_terminal_event(
        self, *, event_id: str
    ) -> OddsResponse | None:
        if not await self.is_event_terminal(event_id=event_id):
            return None
        async with self._sessions() as session:
            result = await session.execute(
                select(OddsRow)
                .where(OddsRow.event_id == event_id)
                .order_by(OddsRow.id.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
        if row is None:
            return None
        return OddsResponse.model_validate_json(row.odds_payload_json)

    async def is_event_terminal(self, *, event_id: str) -> bool:
        async with self._sessions() as session:
            result = await session.execute(
                select(MatchStatsRow.id)
                .where(MatchStatsRow.event_id == event_id)
                .where(MatchStatsRow.is_terminal.is_(True))
                .limit(1)
            )
            row = result.scalar_one_or_none()
        return row is not None
