import asyncio
import sqlite3
from pathlib import Path

from app.services.storage import SnapshotStore


def _seed_prisma_tables(db_path: Path) -> None:
    """Create the Prisma-owned tables that SnapshotStore._initialize_sync requires."""
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS odds_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                source TEXT,
                correlation_id TEXT,
                odds_payload_json TEXT NOT NULL,
                upstream_payload_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS match_stats_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                source TEXT,
                correlation_id TEXT,
                match_stats_payload_json TEXT NOT NULL,
                feed_payloads_json TEXT NOT NULL,
                is_terminal INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_storage_creates_backtest_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "test.sqlite3"
    _seed_prisma_tables(db_path)
    store = SnapshotStore(str(db_path))
    asyncio.run(store.initialize())

    conn = sqlite3.connect(db_path)
    try:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    finally:
        conn.close()

    assert "backtest_runs" in names
    assert "backtest_bets" in names
