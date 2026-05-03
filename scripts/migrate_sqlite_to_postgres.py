"""One-shot migration: SQLite -> Postgres (rows) + filesystem blob store (payloads).

Reads from data/flashscore_snapshots.sqlite3, writes rows into the running
docker-compose Postgres at localhost:5432, and stores the JSON payloads as
gzipped blobs under data/blobs/.

Idempotent: safe to re-run. On second run, truncates target tables first
(asks for confirmation in interactive mode).

Tables migrated (IDs preserved, sequences bumped after):
  - scrape_jobs                  (control-plane state)
  - scrape_job_events            (control-plane state, FK to scrape_jobs)
  - odds_snapshots               (52,348 rows expected, raw upstream -> blob)
  - match_stats_snapshots        (52,348 rows expected, feeds -> blob)
  - match_event_summaries        (denormalized index, PK is event_id)

For odds_snapshots: SQLite has `upstream_payload_json` (TEXT). Each row's
upstream payload is gzipped to data/blobs/odds/<event_id>/<fetched_at>.json.gz,
and the file:// URL is written to the Postgres `upstream_blob_url` column.

For match_stats_snapshots: SQLite has `feed_payloads_json` (TEXT). Each row's
feed payload is gzipped to data/blobs/match_stats/<event_id>/<fetched_at>.json.gz,
and the file:// URL is written to the Postgres `feed_payloads_blob_url` column.

Run from worktree root:
    uv run python scripts/migrate_sqlite_to_postgres.py
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make `app.*` importable when running from worktree root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.blob_store import LocalBlobStore

SQLITE_PATH = Path("data/flashscore_snapshots.sqlite3")
BLOB_ROOT = Path("data/blobs")
PG_URL = os.environ.get(
    "DATABASE_URL_PSYCOPG",
    "postgresql+asyncpg://flashscore:flashscore@localhost:5432/flashscore",
)
BATCH_SIZE = 1000

# Hosts the migration is willing to TRUNCATE without an explicit override.
# Anything else (e.g. a remote VPS Postgres) is treated as production and
# refused — set ALLOW_REMOTE=1 in env to override after eyes-on-screen.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "postgres"}


def _utc(s: str | None) -> datetime | None:
    """Parse a stored ISO-8601 timestamp into a tz-aware UTC datetime, or None."""
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _safe_key(s: str) -> str:
    """Make a filesystem-safe key fragment (replace `:` from ISO timestamps)."""
    return s.replace(":", "_")


def _read_all(conn: sqlite3.Connection, query: str) -> list[sqlite3.Row]:
    return list(conn.execute(query).fetchall())


def _confirm(prompt: str) -> bool:
    if not sys.stdin.isatty():
        print(f"{prompt} [auto-yes -- non-interactive]")
        return True
    return input(f"{prompt} [y/N]: ").strip().lower().startswith("y")


async def _truncate_targets(engine: Any) -> None:
    print("Truncating Postgres target tables...")
    async with engine.begin() as conn:
        await conn.execute(text(
            "TRUNCATE TABLE odds_snapshots, match_stats_snapshots, "
            "scrape_jobs, scrape_job_events, match_event_summaries "
            "RESTART IDENTITY CASCADE"
        ))


async def _bump_sequence(engine: Any, table: str, column: str = "id") -> None:
    seq = f"{table}_{column}_seq"
    async with engine.begin() as conn:
        await conn.execute(text(
            f"SELECT setval('{seq}', (SELECT COALESCE(MAX({column}), 1) FROM {table}))"
        ))


async def _migrate_odds(
    sqlite_conn: sqlite3.Connection, engine: Any, blob_store: LocalBlobStore
) -> int:
    rows = _read_all(
        sqlite_conn,
        "SELECT id, event_id, fetched_at, source, correlation_id, "
        "odds_payload_json, upstream_payload_json FROM odds_snapshots ORDER BY id",
    )
    print(f"  Found {len(rows)} odds rows in SQLite.")
    inserted = 0
    sql = text(
        "INSERT INTO odds_snapshots "
        "(id, event_id, fetched_at, source, correlation_id, odds_payload_json, upstream_blob_url) "
        "VALUES (:id, :event_id, :fetched_at, :source, :correlation_id, :odds_payload_json, :upstream_blob_url)"
    )
    async with engine.begin() as conn:
        batch: list[dict[str, Any]] = []
        for row in rows:
            upstream_bytes = (row["upstream_payload_json"] or "").encode("utf-8")
            fetched_at_dt = _utc(row["fetched_at"])
            blob_url = await blob_store.put(
                namespace="odds",
                key=f"{row['event_id']}/{_safe_key(fetched_at_dt.isoformat())}",
                payload=upstream_bytes,
            )
            batch.append({
                "id": row["id"],
                "event_id": row["event_id"],
                "fetched_at": fetched_at_dt,
                "source": row["source"],
                "correlation_id": row["correlation_id"],
                "odds_payload_json": row["odds_payload_json"],
                "upstream_blob_url": blob_url,
            })
            if len(batch) >= BATCH_SIZE:
                await conn.execute(sql, batch)
                inserted += len(batch)
                print(f"  ...inserted {inserted}/{len(rows)}")
                batch = []
        if batch:
            await conn.execute(sql, batch)
            inserted += len(batch)
    return inserted


async def _migrate_match_stats(
    sqlite_conn: sqlite3.Connection, engine: Any, blob_store: LocalBlobStore
) -> int:
    rows = _read_all(
        sqlite_conn,
        "SELECT id, event_id, fetched_at, source, correlation_id, "
        "match_stats_payload_json, feed_payloads_json, is_terminal "
        "FROM match_stats_snapshots ORDER BY id",
    )
    print(f"  Found {len(rows)} match-stats rows in SQLite.")
    inserted = 0
    sql = text(
        "INSERT INTO match_stats_snapshots "
        "(id, event_id, fetched_at, source, correlation_id, match_stats_payload_json, "
        "feed_payloads_blob_url, is_terminal) "
        "VALUES (:id, :event_id, :fetched_at, :source, :correlation_id, "
        ":match_stats_payload_json, :feed_payloads_blob_url, :is_terminal)"
    )
    async with engine.begin() as conn:
        batch: list[dict[str, Any]] = []
        for row in rows:
            feeds_bytes = (row["feed_payloads_json"] or "").encode("utf-8")
            fetched_at_dt = _utc(row["fetched_at"])
            blob_url = await blob_store.put(
                namespace="match_stats",
                key=f"{row['event_id']}/{_safe_key(fetched_at_dt.isoformat())}",
                payload=feeds_bytes,
            )
            batch.append({
                "id": row["id"],
                "event_id": row["event_id"],
                "fetched_at": fetched_at_dt,
                "source": row["source"],
                "correlation_id": row["correlation_id"],
                "match_stats_payload_json": row["match_stats_payload_json"],
                "feed_payloads_blob_url": blob_url,
                "is_terminal": bool(row["is_terminal"]),
            })
            if len(batch) >= BATCH_SIZE:
                await conn.execute(sql, batch)
                inserted += len(batch)
                print(f"  ...inserted {inserted}/{len(rows)}")
                batch = []
        if batch:
            await conn.execute(sql, batch)
            inserted += len(batch)
    return inserted


async def _migrate_simple_table(
    sqlite_conn: sqlite3.Connection,
    engine: Any,
    *,
    table: str,
    columns: list[str],
    datetime_cols: list[str],
    bool_cols: list[str] | None = None,
    order_by: str | None = "id",
) -> int:
    bool_cols = bool_cols or []
    order_clause = f" ORDER BY {order_by}" if order_by else ""
    rows = _read_all(
        sqlite_conn,
        f"SELECT {', '.join(columns)} FROM {table}{order_clause}",
    )
    print(f"  Found {len(rows)} rows in {table}.")
    if not rows:
        return 0
    inserted = 0
    placeholders = ", ".join(f":{c}" for c in columns)
    sql = text(
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    )
    async with engine.begin() as conn:
        batch: list[dict[str, Any]] = []
        for row in rows:
            data: dict[str, Any] = {}
            for col in columns:
                v = row[col]
                if col in datetime_cols:
                    data[col] = _utc(v) if isinstance(v, str) else v
                elif col in bool_cols:
                    data[col] = bool(v) if v is not None else None
                else:
                    data[col] = v
            batch.append(data)
            if len(batch) >= BATCH_SIZE:
                await conn.execute(sql, batch)
                inserted += len(batch)
                print(f"  ...inserted {inserted}/{len(rows)}")
                batch = []
        if batch:
            await conn.execute(sql, batch)
            inserted += len(batch)
    return inserted


def _assert_local_target(url: str) -> None:
    """Refuse to run against anything but localhost/postgres unless ALLOW_REMOTE=1."""
    from urllib.parse import urlparse

    host = urlparse(url.replace("postgresql+asyncpg", "postgresql")).hostname
    if host in _LOCAL_HOSTS:
        return
    if os.environ.get("ALLOW_REMOTE") == "1":
        print(f"WARNING: target host {host!r} is not local; ALLOW_REMOTE=1, proceeding.")
        return
    sys.exit(
        f"Refusing to run against non-local Postgres host {host!r}. "
        "This script truncates tables; running it against production would be catastrophic. "
        "Set ALLOW_REMOTE=1 to override after triple-checking."
    )


async def main() -> None:
    if not SQLITE_PATH.exists():
        sys.exit(f"SQLite DB not found at {SQLITE_PATH}.")

    _assert_local_target(PG_URL)
    engine = create_async_engine(PG_URL)

    async with engine.connect() as conn:
        version = (await conn.execute(text("SELECT version()"))).scalar()
        print(f"Connected to Postgres: {version}")

    async with engine.connect() as conn:
        odds_count = (await conn.execute(text("SELECT count(*) FROM odds_snapshots"))).scalar()
        if odds_count > 0:
            if not _confirm(f"odds_snapshots already has {odds_count} rows. Truncate and re-migrate?"):
                sys.exit("Aborted.")
            await engine.dispose()
            engine = create_async_engine(PG_URL)
            await _truncate_targets(engine)

    blob_store = LocalBlobStore(root=BLOB_ROOT)

    sqlite_conn = sqlite3.connect(str(SQLITE_PATH))
    sqlite_conn.row_factory = sqlite3.Row
    try:
        # Order matters: scrape_jobs before scrape_job_events (FK).
        print("\n== scrape_jobs ==")
        n_jobs = await _migrate_simple_table(
            sqlite_conn, engine,
            table="scrape_jobs",
            columns=[
                "id", "competition_path", "seasons", "include_stats", "include_odds",
                "max_concurrency", "status", "created_at", "started_at",
                "updated_at", "finished_at", "last_error", "total_events",
            ],
            datetime_cols=["created_at", "started_at", "updated_at", "finished_at"],
            bool_cols=["include_stats", "include_odds"],
        )
        await _bump_sequence(engine, "scrape_jobs")

        print("\n== scrape_job_events ==")
        n_events = await _migrate_simple_table(
            sqlite_conn, engine,
            table="scrape_job_events",
            columns=[
                "id", "job_id", "event_id", "season_path", "status", "attempts",
                "skipped_reason", "last_error", "created_at", "started_at",
                "updated_at", "finished_at",
            ],
            datetime_cols=["created_at", "started_at", "updated_at", "finished_at"],
        )
        await _bump_sequence(engine, "scrape_job_events")

        print("\n== odds_snapshots ==")
        n_odds = await _migrate_odds(sqlite_conn, engine, blob_store)
        await _bump_sequence(engine, "odds_snapshots")

        print("\n== match_stats_snapshots ==")
        n_stats = await _migrate_match_stats(sqlite_conn, engine, blob_store)
        await _bump_sequence(engine, "match_stats_snapshots")

        print("\n== match_event_summaries ==")
        n_summaries = await _migrate_simple_table(
            sqlite_conn, engine,
            table="match_event_summaries",
            columns=[
                "event_id", "event_name", "home_team", "away_team", "sport",
                "country", "competition", "competition_stage", "competition_path",
                "start_time_utc", "status", "status_detail", "outcome",
                "odds_snapshot_count", "stats_snapshot_count",
                "latest_odds_fetched_at", "latest_stats_fetched_at", "updated_at",
            ],
            datetime_cols=[
                "start_time_utc", "latest_odds_fetched_at",
                "latest_stats_fetched_at", "updated_at",
            ],
            order_by="event_id",
        )
    finally:
        sqlite_conn.close()

    await engine.dispose()

    print("\n=== Migration summary ===")
    print(f"  scrape_jobs:           {n_jobs}")
    print(f"  scrape_job_events:     {n_events}")
    print(f"  odds_snapshots:        {n_odds}")
    print(f"  match_stats_snapshots: {n_stats}")
    print(f"  match_event_summaries: {n_summaries}")
    print(f"\nBlob store root: {BLOB_ROOT.resolve()}")


if __name__ == "__main__":
    asyncio.run(main())
