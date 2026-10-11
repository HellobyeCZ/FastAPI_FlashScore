"""Router: events. See app/routes/__init__.py.

Match detail from stored data only: every handler reads SQLite through a
read-only connection and never reaches FlashScore (unlike /odds/{id} and
/match-stats/{id}, which scrape non-terminal events). Handlers are plain
``def`` so the blocking queries run in FastAPI's threadpool.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
from typing import Any, Dict, Optional

import structlog
from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from app.ml import db as ml_db
from app.ml.backtest_stats import fetch_backtest_bets_for_event
from app.ml.paper_trade_stats import (
    StatsFilter,
    fetch_history,
    format_timestamp,
    table_names,
)
from app.schemas.events import (
    EventPicks,
    EventScore,
    EventSummary,
    StoredMatchStatsResponse,
    StoredOddsResponse,
)
from app.schemas.match_stats import MatchStatsResponse
from app.services.storage import SnapshotStore

router = APIRouter(tags=["events"])

_logger = structlog.get_logger("events")


def _connect() -> sqlite3.Connection:
    return ml_db.connect(read_only=True)


# "Latest" is by insertion order, the convention /odds and /match-stats use.
# Only the response JSON is read; the upstream/feed payload columns are large.
_LATEST_ODDS_SQL = """
    SELECT id, fetched_at, odds_payload_json AS payload
    FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1
"""
_LATEST_STATS_SQL = """
    SELECT id, fetched_at, is_terminal, match_stats_payload_json AS payload
    FROM match_stats_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1
"""


def _odds_snapshot_meta(conn: sqlite3.Connection, event_id: str) -> tuple:
    """``(count, latest fetched_at)`` without reading any payload. Both
    queries are ranges on the (event_id, fetched_at) index."""
    count = conn.execute(
        "SELECT COUNT(*) FROM odds_snapshots WHERE event_id = ?", (event_id,)
    ).fetchone()[0]
    latest = conn.execute(
        "SELECT fetched_at FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1",
        (event_id,),
    ).fetchone()
    return int(count), (latest[0] if latest else None)


@router.get("/events/{event_id}", response_model=EventSummary)
def get_event(event_id: str) -> EventSummary:
    """Match header: archive summary, else the discovered fixture, plus the
    final score and terminal state from the latest stored stats snapshot."""
    with contextlib.closing(_connect()) as conn:
        tables = table_names(conn)
        summary = (
            conn.execute(
                "SELECT * FROM match_event_summaries WHERE event_id = ?", (event_id,)
            ).fetchone()
            if "match_event_summaries" in tables
            else None
        )
        fixture = (
            conn.execute(
                "SELECT * FROM upcoming_fixtures WHERE event_id = ?", (event_id,)
            ).fetchone()
            if "upcoming_fixtures" in tables
            else None
        )
        odds_count, odds_fetched_at = _odds_snapshot_meta(conn, event_id)
        stats_row = conn.execute(_LATEST_STATS_SQL, (event_id,)).fetchone()
        stats_count = conn.execute(
            "SELECT COUNT(*) FROM match_stats_snapshots WHERE event_id = ?", (event_id,)
        ).fetchone()[0]

    stats: Optional[MatchStatsResponse] = (
        SnapshotStore.load_model_from_json(MatchStatsResponse, stats_row["payload"])
        if stats_row is not None
        else None
    )
    fields: Dict[str, Any]
    if summary is not None:
        fields = {
            "home_team": summary["home_team"],
            "away_team": summary["away_team"],
            "sport": summary["sport"],
            "country": summary["country"],
            "competition": summary["competition"],
            "competition_path": summary["competition_path"],
            "start_time_utc": summary["start_time_utc"],
            "status": summary["status"],
            "status_detail": summary["status_detail"],
            "outcome": summary["outcome"],
        }
    elif fixture is not None:
        # Discovered by the live pipeline but never scraped into the archive.
        # Fixture countries are lowercase; the archive vocabulary is upper.
        fields = {
            "home_team": fixture["home_team_raw"],
            "away_team": fixture["away_team_raw"],
            "sport": fixture["sport"],
            "country": fixture["country"].upper() if fixture["country"] else None,
            "competition": fixture["competition"],
            "competition_path": fixture["competition_path"],
            "start_time_utc": fixture["start_time_utc"],
            "status": "scheduled",
            "status_detail": None,
            "outcome": None,
        }
    elif stats is not None:
        event = stats.event
        fields = {
            "home_team": event.home_team,
            "away_team": event.away_team,
            "sport": event.sport,
            "country": event.country,
            "competition": event.competition,
            "competition_path": event.competition_path,
            "start_time_utc": event.start_time_utc,
            "status": event.status,
            "status_detail": event.status_detail,
            "outcome": event.outcome,
        }
    elif odds_count:
        fields = {}
    else:
        raise HTTPException(status_code=404, detail="Event not found in stored data.")

    score = SnapshotStore.final_score(stats) if stats is not None else None
    is_terminal = stats_row is not None and (
        bool(stats_row["is_terminal"])
        or (stats is not None and SnapshotStore.is_terminal_match_response(stats))
    )
    fields["start_time_utc"] = format_timestamp(fields.get("start_time_utc"))
    return EventSummary(
        event_id=event_id,
        **fields,
        score=EventScore(home=score[0], away=score[1]) if score else None,
        is_terminal=is_terminal,
        latest_odds_fetched_at=format_timestamp(odds_fetched_at),
        latest_stats_fetched_at=format_timestamp(stats_row["fetched_at"]) if stats_row else None,
        odds_snapshot_count=odds_count,
        stats_snapshot_count=int(stats_count),
    )


def _stored_payload(row: Optional[sqlite3.Row], *, kind: str, event_id: str) -> Dict[str, Any]:
    if row is None:
        raise HTTPException(status_code=404, detail=f"No stored {kind} snapshot for this event.")
    try:
        payload = json.loads(row["payload"])
    except (TypeError, json.JSONDecodeError):
        payload = None
    if not isinstance(payload, dict):
        _logger.error("stored_snapshot_unreadable", event_id=event_id, kind=kind, snapshot_id=row["id"])
        raise HTTPException(status_code=500, detail=f"Stored {kind} snapshot is unreadable.")
    payload["fetched_at"] = format_timestamp(row["fetched_at"])
    return payload


@router.get("/events/{event_id}/odds", response_model=StoredOddsResponse)
def get_event_odds(event_id: str) -> StoredOddsResponse:
    """Latest stored odds snapshot in the ``/odds/{event_id}`` shape, with
    ``fetched_at`` and ``served_from: "stored"``. 404 when none exists."""
    with contextlib.closing(_connect()) as conn:
        row = conn.execute(_LATEST_ODDS_SQL, (event_id,)).fetchone()
    payload = _stored_payload(row, kind="odds", event_id=event_id)
    payload["served_from"] = "stored"
    try:
        return StoredOddsResponse.model_validate(payload)
    except ValidationError as exc:
        _logger.error("stored_snapshot_invalid", event_id=event_id, kind="odds", error=str(exc))
        raise HTTPException(status_code=500, detail="Stored odds snapshot is unreadable.") from exc


@router.get("/events/{event_id}/stats", response_model=StoredMatchStatsResponse)
def get_event_stats(event_id: str) -> StoredMatchStatsResponse:
    """Latest stored match-stats snapshot in the ``/match-stats/{event_id}``
    shape, with ``fetched_at``. 404 when none exists."""
    with contextlib.closing(_connect()) as conn:
        row = conn.execute(_LATEST_STATS_SQL, (event_id,)).fetchone()
    payload = _stored_payload(row, kind="stats", event_id=event_id)
    try:
        return StoredMatchStatsResponse.model_validate(payload)
    except ValidationError as exc:
        _logger.error("stored_snapshot_invalid", event_id=event_id, kind="stats", error=str(exc))
        raise HTTPException(status_code=500, detail="Stored stats snapshot is unreadable.") from exc


@router.get("/events/{event_id}/picks", response_model=EventPicks)
def get_event_picks(event_id: str) -> EventPicks:
    """Every bet placed on the event: live paper bets (the /picks/history
    row shape, any status) and backtest bets with their run's label and
    model. Empty lists, not 404, for an event without bets."""
    _, live = fetch_history(StatsFilter(status="all"), limit=None, event_id=event_id)
    return EventPicks(live=live, backtest=fetch_backtest_bets_for_event(event_id))
