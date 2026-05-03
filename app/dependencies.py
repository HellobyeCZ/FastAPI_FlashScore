"""FastAPI dependency factories. All singletons live here behind @lru_cache."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app.db.blob_store import LocalBlobStore
from app.db.engine import get_session_factory
from app.services.odds_client import OddsClient, build_odds_client
from app.services.snapshot_repo import SnapshotRepo
from app.services.stats_client import MatchStatsClient, build_match_stats_client


@lru_cache
def get_blob_store() -> LocalBlobStore:
    return LocalBlobStore(root=Path("data/blobs"))


@lru_cache
def get_snapshot_repo() -> SnapshotRepo:
    return SnapshotRepo(session_factory=get_session_factory(), blob_store=get_blob_store())


@lru_cache
def get_odds_client() -> OddsClient:
    return build_odds_client()


@lru_cache
def get_match_stats_client() -> MatchStatsClient:
    return build_match_stats_client()
