"""Shared read/write SQLite helper for the offline ML pipeline.

Routes through ``APP_STORAGE_DB_PATH`` (env var) with fallback to the
``app.config`` default, matching how :func:`build_snapshot_store` resolves
the path. Bumps a few SQLite pragmas suitable for batch backfill.
"""
from __future__ import annotations

import os
import sqlite3

from app.config import get_settings


def db_path() -> str:
    settings = get_settings()
    return os.environ.get(
        "APP_STORAGE_DB_PATH",
        str(settings._resolve_value(settings.storage_db_path)),
    )


_TABLES_INITIALIZED = False


def ensure_phase1_tables() -> None:
    """Idempotently create the Phase 1 ML tables. Safe to call repeatedly."""
    global _TABLES_INITIALIZED
    if _TABLES_INITIALIZED:
        return
    # Import lazily to avoid circular imports between app.ml.db and
    # app.services.storage at module-load time.
    from app.services.storage import SnapshotStore

    with sqlite3.connect(db_path(), timeout=60.0) as conn:
        SnapshotStore._ensure_phase1_tables(conn)
    _TABLES_INITIALIZED = True


def connect(*, read_only: bool = False) -> sqlite3.Connection:
    path = db_path()
    if read_only:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60.0)
    else:
        conn = sqlite3.connect(path, timeout=60.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA cache_size=-200000;")  # ~200 MB page cache
    return conn
