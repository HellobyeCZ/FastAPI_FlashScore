from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, Type, TypeVar

from app.config import get_settings
from app.schemas.match_stats import MatchStatsResponse
from app.schemas.odds import OddsResponse
from app.services._terminality import TERMINAL_MATCH_STATUSES as _TERMINAL_MATCH_STATUSES

ModelT = TypeVar("ModelT")


class SnapshotStore:
    """Persist odds and match stats snapshots for every successful fetch."""

    _REQUIRED_TABLES = ("odds_snapshots", "match_stats_snapshots")
    _RESUMABLE_JOB_STATUSES = ("queued", "running")

    def __init__(self, db_path: str) -> None:
        self._db_path = Path(db_path)
        self._init_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._initialised = False

    async def initialize(self) -> None:
        if self._initialised:
            return
        async with self._init_lock:
            if self._initialised:
                return
            await asyncio.to_thread(self._initialize_sync)
            self._initialised = True

    async def aclose(self) -> None:
        # A new SQLite connection is opened per operation, nothing to close here.
        return None

    async def save_odds_snapshot(
        self,
        *,
        event_id: str,
        response: OddsResponse,
        upstream_payload: Any,
        correlation_id: Optional[str] = None,
    ) -> None:
        await self.initialize()
        fetched_at = response.retrieved_at.astimezone(timezone.utc).isoformat()
        response_payload_json = self._dump_payload(self._model_to_payload(response))
        upstream_payload_json = self._dump_payload(upstream_payload)

        async with self._write_lock:
            await asyncio.to_thread(
                self._insert_odds_snapshot_sync,
                event_id,
                fetched_at,
                response.source,
                correlation_id,
                response_payload_json,
                upstream_payload_json,
            )

    async def save_match_stats_snapshot(
        self,
        *,
        event_id: str,
        response: MatchStatsResponse,
        feed_payloads: Dict[str, str],
        correlation_id: Optional[str] = None,
    ) -> None:
        await self.initialize()
        fetched_at = response.retrieved_at.astimezone(timezone.utc).isoformat()
        response_payload_json = self._dump_payload(self._model_to_payload(response))
        feed_payloads_json = self._dump_payload(feed_payloads)
        is_terminal = self._is_terminal_match_response(response)

        async with self._write_lock:
            await asyncio.to_thread(
                self._insert_match_stats_snapshot_sync,
                event_id,
                fetched_at,
                response.source,
                correlation_id,
                response_payload_json,
                feed_payloads_json,
                is_terminal,
            )

    async def list_odds_snapshots(self, *, event_id: str, limit: int = 25) -> List[Dict[str, Any]]:
        await self.initialize()
        safe_limit = max(1, min(limit, 200))
        return await asyncio.to_thread(self._list_odds_snapshots_sync, event_id, safe_limit)

    async def list_match_stats_snapshots(self, *, event_id: str, limit: int = 25) -> List[Dict[str, Any]]:
        await self.initialize()
        safe_limit = max(1, min(limit, 200))
        return await asyncio.to_thread(self._list_match_stats_snapshots_sync, event_id, safe_limit)

    async def get_terminal_match_stats_snapshot(
        self, *, event_id: str
    ) -> Optional[MatchStatsResponse]:
        await self.initialize()
        return await asyncio.to_thread(self._get_terminal_match_stats_snapshot_sync, event_id)

    async def get_latest_odds_snapshot_for_terminal_event(
        self, *, event_id: str
    ) -> Optional[OddsResponse]:
        await self.initialize()
        return await asyncio.to_thread(
            self._get_latest_odds_snapshot_for_terminal_event_sync,
            event_id,
        )

    async def is_event_terminal(self, *, event_id: str) -> bool:
        await self.initialize()
        return await asyncio.to_thread(self._is_event_terminal_sync, event_id)

    async def create_bulk_scrape_job(
        self,
        *,
        competition_path: str,
        seasons: int,
        include_stats: bool,
        include_odds: bool,
        max_concurrency: int,
    ) -> int:
        await self.initialize()
        return await asyncio.to_thread(
            self._create_bulk_scrape_job_sync,
            competition_path,
            seasons,
            include_stats,
            include_odds,
            max_concurrency,
        )

    async def list_bulk_scrape_jobs(self, *, limit: int = 20) -> List[Dict[str, Any]]:
        await self.initialize()
        safe_limit = max(1, min(limit, 100))
        return await asyncio.to_thread(self._list_bulk_scrape_jobs_sync, safe_limit)

    async def get_bulk_scrape_job(
        self,
        *,
        job_id: int,
        include_events: bool = False,
        event_limit: int = 500,
    ) -> Optional[Dict[str, Any]]:
        await self.initialize()
        safe_event_limit = max(1, min(event_limit, 5000))
        return await asyncio.to_thread(
            self._get_bulk_scrape_job_sync,
            job_id,
            include_events,
            safe_event_limit,
        )

    async def get_bulk_scrape_job_params(self, *, job_id: int) -> Optional[Dict[str, Any]]:
        await self.initialize()
        return await asyncio.to_thread(self._get_bulk_scrape_job_params_sync, job_id)

    async def mark_bulk_scrape_job_running(self, *, job_id: int) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(self._mark_bulk_scrape_job_running_sync, job_id)

    async def mark_bulk_scrape_job_failed(self, *, job_id: int, error: str) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(self._mark_bulk_scrape_job_failed_sync, job_id, error)

    async def mark_bulk_scrape_job_finished(
        self,
        *,
        job_id: int,
        status: str,
        error: Optional[str] = None,
    ) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(
                self._mark_bulk_scrape_job_finished_sync,
                job_id,
                status,
                error,
            )

    async def replace_bulk_scrape_job_events(
        self,
        *,
        job_id: int,
        events: Iterable[Tuple[str, Optional[str]]],
    ) -> int:
        await self.initialize()
        events_list = list(events)
        async with self._write_lock:
            return await asyncio.to_thread(
                self._replace_bulk_scrape_job_events_sync,
                job_id,
                events_list,
            )

    async def reset_running_bulk_scrape_job_events(self, *, job_id: int) -> int:
        await self.initialize()
        async with self._write_lock:
            return await asyncio.to_thread(self._reset_running_bulk_scrape_job_events_sync, job_id)

    async def list_bulk_scrape_pending_events(self, *, job_id: int) -> List[Dict[str, Any]]:
        await self.initialize()
        return await asyncio.to_thread(self._list_bulk_scrape_pending_events_sync, job_id)

    async def mark_bulk_scrape_event_running(self, *, job_id: int, event_id: str) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(self._mark_bulk_scrape_event_running_sync, job_id, event_id)

    async def mark_bulk_scrape_event_succeeded(
        self,
        *,
        job_id: int,
        event_id: str,
        skipped_reason: Optional[str] = None,
    ) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(
                self._mark_bulk_scrape_event_succeeded_sync,
                job_id,
                event_id,
                skipped_reason,
            )

    async def mark_bulk_scrape_event_failed(
        self,
        *,
        job_id: int,
        event_id: str,
        error: str,
    ) -> None:
        await self.initialize()
        async with self._write_lock:
            await asyncio.to_thread(
                self._mark_bulk_scrape_event_failed_sync,
                job_id,
                event_id,
                error,
            )

    async def list_resumable_bulk_scrape_job_ids(self) -> List[int]:
        await self.initialize()
        return await asyncio.to_thread(self._list_resumable_bulk_scrape_job_ids_sync)

    def _initialize_sync(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL;")
            connection.execute("PRAGMA synchronous=NORMAL;")
            existing_tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            missing_tables = [table for table in self._REQUIRED_TABLES if table not in existing_tables]
            if missing_tables:
                missing = ", ".join(missing_tables)
                raise RuntimeError(
                    "Snapshot DB schema is missing required tables "
                    f"({missing}). Run `cd frontend && cp .env.example .env && npm run prisma:deploy`."
                )
            self._ensure_column(
                connection,
                table_name="match_stats_snapshots",
                column_name="is_terminal",
                column_sql="INTEGER NOT NULL DEFAULT 0",
            )
            self._ensure_bulk_scrape_tables(connection)

    def _insert_odds_snapshot_sync(
        self,
        event_id: str,
        fetched_at: str,
        source: Optional[str],
        correlation_id: Optional[str],
        odds_payload_json: str,
        upstream_payload_json: str,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO odds_snapshots (
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    odds_payload_json,
                    upstream_payload_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    odds_payload_json,
                    upstream_payload_json,
                ),
            )
            connection.commit()

    def _insert_match_stats_snapshot_sync(
        self,
        event_id: str,
        fetched_at: str,
        source: Optional[str],
        correlation_id: Optional[str],
        match_stats_payload_json: str,
        feed_payloads_json: str,
        is_terminal: bool,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO match_stats_snapshots (
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    match_stats_payload_json,
                    feed_payloads_json,
                    is_terminal
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    match_stats_payload_json,
                    feed_payloads_json,
                    1 if is_terminal else 0,
                ),
            )
            connection.commit()

    def _list_odds_snapshots_sync(self, event_id: str, limit: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    odds_payload_json
                FROM odds_snapshots
                WHERE event_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (event_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def _list_match_stats_snapshots_sync(self, event_id: str, limit: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    event_id,
                    fetched_at,
                    source,
                    correlation_id,
                    match_stats_payload_json,
                    is_terminal
                FROM match_stats_snapshots
                WHERE event_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (event_id, limit),
            ).fetchall()
        snapshots = [dict(row) for row in rows]
        for snapshot in snapshots:
            snapshot["is_terminal"] = bool(snapshot.get("is_terminal"))
        return snapshots

    def _get_terminal_match_stats_snapshot_sync(
        self,
        event_id: str,
    ) -> Optional[MatchStatsResponse]:
        resolved = self._resolve_latest_match_stats_snapshot_sync(event_id)
        if not resolved:
            return None
        return resolved["response"] if resolved["is_terminal"] else None

    def _get_latest_odds_snapshot_for_terminal_event_sync(
        self,
        event_id: str,
    ) -> Optional[OddsResponse]:
        resolved = self._resolve_latest_match_stats_snapshot_sync(event_id)
        if not resolved or not resolved["is_terminal"]:
            return None

        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT odds_payload_json
                FROM odds_snapshots
                WHERE event_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (event_id,),
            ).fetchone()

        if row is None:
            return None

        return self._load_model_from_json(OddsResponse, row["odds_payload_json"])

    def _is_event_terminal_sync(self, event_id: str) -> bool:
        resolved = self._resolve_latest_match_stats_snapshot_sync(event_id)
        return bool(resolved and resolved["is_terminal"])

    def _create_bulk_scrape_job_sync(
        self,
        competition_path: str,
        seasons: int,
        include_stats: bool,
        include_odds: bool,
        max_concurrency: int,
    ) -> int:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO scrape_jobs (
                    competition_path,
                    seasons,
                    include_stats,
                    include_odds,
                    max_concurrency,
                    status,
                    created_at,
                    started_at,
                    updated_at,
                    finished_at,
                    last_error,
                    total_events
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    competition_path,
                    seasons,
                    1 if include_stats else 0,
                    1 if include_odds else 0,
                    max_concurrency,
                    "queued",
                    now_iso,
                    None,
                    now_iso,
                    None,
                    None,
                    0,
                ),
            )
            connection.commit()
            return int(cursor.lastrowid)

    def _list_bulk_scrape_jobs_sync(self, limit: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    j.id,
                    j.competition_path,
                    j.seasons,
                    j.include_stats,
                    j.include_odds,
                    j.max_concurrency,
                    j.status,
                    j.created_at,
                    j.started_at,
                    j.updated_at,
                    j.finished_at,
                    j.last_error,
                    j.total_events,
                    COUNT(e.id) AS total_count,
                    SUM(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE WHEN e.status = 'running' THEN 1 ELSE 0 END) AS running_count,
                    SUM(CASE WHEN e.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
                    SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                    SUM(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
                FROM scrape_jobs j
                LEFT JOIN scrape_job_events e ON e.job_id = j.id
                GROUP BY j.id
                ORDER BY j.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._serialize_job_row(row) for row in rows]

    def _get_bulk_scrape_job_sync(
        self,
        job_id: int,
        include_events: bool,
        event_limit: int,
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    j.id,
                    j.competition_path,
                    j.seasons,
                    j.include_stats,
                    j.include_odds,
                    j.max_concurrency,
                    j.status,
                    j.created_at,
                    j.started_at,
                    j.updated_at,
                    j.finished_at,
                    j.last_error,
                    j.total_events,
                    COUNT(e.id) AS total_count,
                    SUM(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE WHEN e.status = 'running' THEN 1 ELSE 0 END) AS running_count,
                    SUM(CASE WHEN e.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
                    SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                    SUM(CASE WHEN e.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
                FROM scrape_jobs j
                LEFT JOIN scrape_job_events e ON e.job_id = j.id
                WHERE j.id = ?
                GROUP BY j.id
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                return None

            payload = self._serialize_job_row(row)
            if include_events:
                event_rows = connection.execute(
                    """
                    SELECT
                        event_id,
                        season_path,
                        status,
                        attempts,
                        skipped_reason,
                        last_error,
                        created_at,
                        started_at,
                        updated_at,
                        finished_at
                    FROM scrape_job_events
                    WHERE job_id = ?
                    ORDER BY id ASC
                    LIMIT ?
                    """,
                    (job_id, event_limit),
                ).fetchall()
                payload["events"] = [self._serialize_job_event_row(event_row) for event_row in event_rows]

            return payload

    def _get_bulk_scrape_job_params_sync(self, job_id: int) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    competition_path,
                    seasons,
                    include_stats,
                    include_odds,
                    max_concurrency,
                    status,
                    total_events
                FROM scrape_jobs
                WHERE id = ?
                LIMIT 1
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                return None
        return {
            "id": int(row["id"]),
            "competition_path": row["competition_path"],
            "seasons": int(row["seasons"]),
            "include_stats": bool(row["include_stats"]),
            "include_odds": bool(row["include_odds"]),
            "max_concurrency": int(row["max_concurrency"]),
            "status": row["status"],
            "total_events": int(row["total_events"] or 0),
        }

    def _mark_bulk_scrape_job_running_sync(self, job_id: int) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_jobs
                SET
                    status = 'running',
                    started_at = COALESCE(started_at, ?),
                    updated_at = ?,
                    finished_at = NULL
                WHERE id = ?
                """,
                (now_iso, now_iso, job_id),
            )
            connection.commit()

    def _mark_bulk_scrape_job_failed_sync(self, job_id: int, error: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_jobs
                SET
                    status = 'failed',
                    updated_at = ?,
                    finished_at = ?,
                    last_error = ?
                WHERE id = ?
                """,
                (now_iso, now_iso, error, job_id),
            )
            connection.commit()

    def _mark_bulk_scrape_job_finished_sync(
        self,
        job_id: int,
        status: str,
        error: Optional[str],
    ) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_jobs
                SET
                    status = ?,
                    updated_at = ?,
                    finished_at = ?,
                    last_error = ?
                WHERE id = ?
                """,
                (status, now_iso, now_iso, error, job_id),
            )
            connection.commit()

    def _replace_bulk_scrape_job_events_sync(
        self,
        job_id: int,
        events: List[Tuple[str, Optional[str]]],
    ) -> int:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM scrape_job_events WHERE job_id = ?",
                (job_id,),
            )
            if events:
                connection.executemany(
                    """
                    INSERT INTO scrape_job_events (
                        job_id,
                        event_id,
                        season_path,
                        status,
                        attempts,
                        skipped_reason,
                        last_error,
                        created_at,
                        started_at,
                        updated_at,
                        finished_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            job_id,
                            event_id,
                            season_path,
                            "pending",
                            0,
                            None,
                            None,
                            now_iso,
                            None,
                            now_iso,
                            None,
                        )
                        for event_id, season_path in events
                    ],
                )
            connection.execute(
                """
                UPDATE scrape_jobs
                SET total_events = ?, updated_at = ?, last_error = NULL
                WHERE id = ?
                """,
                (len(events), now_iso, job_id),
            )
            connection.commit()
        return len(events)

    def _reset_running_bulk_scrape_job_events_sync(self, job_id: int) -> int:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE scrape_job_events
                SET
                    status = 'pending',
                    updated_at = ?,
                    started_at = NULL
                WHERE job_id = ? AND status = 'running'
                """,
                (now_iso, job_id),
            )
            connection.commit()
            return int(cursor.rowcount)

    def _list_bulk_scrape_pending_events_sync(self, job_id: int) -> List[Dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT event_id, season_path, status
                FROM scrape_job_events
                WHERE job_id = ? AND status IN ('pending', 'running')
                ORDER BY id ASC
                """,
                (job_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _mark_bulk_scrape_event_running_sync(self, job_id: int, event_id: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_job_events
                SET
                    status = 'running',
                    attempts = attempts + 1,
                    skipped_reason = NULL,
                    last_error = NULL,
                    started_at = ?,
                    updated_at = ?,
                    finished_at = NULL
                WHERE job_id = ? AND event_id = ?
                """,
                (now_iso, now_iso, job_id, event_id),
            )
            connection.commit()

    def _mark_bulk_scrape_event_succeeded_sync(
        self,
        job_id: int,
        event_id: str,
        skipped_reason: Optional[str],
    ) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        status = "skipped" if skipped_reason else "succeeded"
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_job_events
                SET
                    status = ?,
                    skipped_reason = ?,
                    last_error = NULL,
                    updated_at = ?,
                    finished_at = ?
                WHERE job_id = ? AND event_id = ?
                """,
                (status, skipped_reason, now_iso, now_iso, job_id, event_id),
            )
            connection.commit()

    def _mark_bulk_scrape_event_failed_sync(self, job_id: int, event_id: str, error: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE scrape_job_events
                SET
                    status = 'failed',
                    skipped_reason = NULL,
                    last_error = ?,
                    updated_at = ?,
                    finished_at = ?
                WHERE job_id = ? AND event_id = ?
                """,
                (error, now_iso, now_iso, job_id, event_id),
            )
            connection.commit()

    def _list_resumable_bulk_scrape_job_ids_sync(self) -> List[int]:
        placeholders = ",".join("?" for _ in self._RESUMABLE_JOB_STATUSES)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT id
                FROM scrape_jobs
                WHERE status IN ({placeholders})
                ORDER BY id ASC
                """,
                self._RESUMABLE_JOB_STATUSES,
            ).fetchall()
        return [int(row["id"]) for row in rows]

    def _resolve_latest_match_stats_snapshot_sync(
        self,
        event_id: str,
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, match_stats_payload_json, is_terminal
                FROM match_stats_snapshots
                WHERE event_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (event_id,),
            ).fetchone()

            if row is None:
                return None

            response = self._load_model_from_json(MatchStatsResponse, row["match_stats_payload_json"])
            if response is None:
                return None

            is_terminal = bool(row["is_terminal"])
            if not is_terminal:
                is_terminal = self._is_terminal_match_response(response)
                if is_terminal:
                    connection.execute(
                        """
                        UPDATE match_stats_snapshots
                        SET is_terminal = 1
                        WHERE id = ?
                        """,
                        (row["id"],),
                    )
                    connection.commit()

            return {
                "response": response,
                "is_terminal": is_terminal,
            }

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self._db_path), timeout=30.0)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _model_to_payload(model: Any) -> Any:
        if hasattr(model, "model_dump"):
            return model.model_dump(mode="json")
        if hasattr(model, "dict"):
            return model.dict()
        return model

    @staticmethod
    def _load_model_from_json(
        model_cls: Type[ModelT],
        payload_json: str,
    ) -> Optional[ModelT]:
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            return None

        model_validate = getattr(model_cls, "model_validate", None)
        if callable(model_validate):
            try:
                return model_validate(payload)
            except Exception:
                return None

        parse_obj = getattr(model_cls, "parse_obj", None)
        if callable(parse_obj):
            try:
                return parse_obj(payload)
            except Exception:
                return None

        return None

    @staticmethod
    def _ensure_column(
        connection: sqlite3.Connection,
        *,
        table_name: str,
        column_name: str,
        column_sql: str,
    ) -> None:
        existing_columns = {
            row[1]
            for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        if column_name in existing_columns:
            return
        connection.execute(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}"
        )
        connection.commit()

    @staticmethod
    def _ensure_bulk_scrape_tables(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scrape_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                competition_path TEXT NOT NULL,
                seasons INTEGER NOT NULL,
                include_stats INTEGER NOT NULL DEFAULT 1,
                include_odds INTEGER NOT NULL DEFAULT 1,
                max_concurrency INTEGER NOT NULL DEFAULT 4,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                last_error TEXT,
                total_events INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scrape_job_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                season_path TEXT,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                skipped_reason TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(job_id, event_id),
                FOREIGN KEY(job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status
            ON scrape_jobs(status, id DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_scrape_job_events_job_status
            ON scrape_job_events(job_id, status, id ASC)
            """
        )
        connection.commit()

    @staticmethod
    def _safe_int(value: Any) -> int:
        try:
            if value is None:
                return 0
            return int(value)
        except (TypeError, ValueError):
            return 0

    def _serialize_job_row(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": int(row["id"]),
            "competition_path": row["competition_path"],
            "seasons": int(row["seasons"]),
            "include_stats": bool(row["include_stats"]),
            "include_odds": bool(row["include_odds"]),
            "max_concurrency": int(row["max_concurrency"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "started_at": row["started_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
            "last_error": row["last_error"],
            "total_events": max(self._safe_int(row["total_events"]), self._safe_int(row["total_count"])),
            "pending_events": self._safe_int(row["pending_count"]),
            "running_events": self._safe_int(row["running_count"]),
            "succeeded_events": self._safe_int(row["succeeded_count"]),
            "failed_events": self._safe_int(row["failed_count"]),
            "skipped_events": self._safe_int(row["skipped_count"]),
        }

    @staticmethod
    def _serialize_job_event_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "event_id": row["event_id"],
            "season_path": row["season_path"],
            "status": row["status"],
            "attempts": int(row["attempts"] or 0),
            "skipped_reason": row["skipped_reason"],
            "last_error": row["last_error"],
            "created_at": row["created_at"],
            "started_at": row["started_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
        }

    @staticmethod
    def _is_terminal_match_response(response: MatchStatsResponse) -> bool:
        status = (response.event.status or "").strip().lower()
        if status in _TERMINAL_MATCH_STATUSES or status.startswith("finished"):
            return True

        # Keep non-terminal events refreshable (scheduled/live/interrupted/postponed).
        if status in {"scheduled", "live", "interrupted", "postponed"}:
            return False

        status_detail = (response.event.status_detail or "").strip().lower()
        if response.event.outcome and any(
            token in status_detail
            for token in ("after extra time", "after penalties", "penalties", "final")
        ):
            return True

        return False

    @staticmethod
    def _dump_payload(payload: Any) -> str:
        return json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            default=SnapshotStore._json_default,
        )

    @staticmethod
    def _json_default(value: Any) -> str:
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        return str(value)


def build_snapshot_store() -> SnapshotStore:
    settings = get_settings()
    db_path = settings._resolve_value(settings.storage_db_path)
    return SnapshotStore(db_path=str(db_path))
