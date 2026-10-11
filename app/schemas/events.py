"""GET /events/{event_id}[/odds|/stats|/picks] — stored data only, never
scraped. Mirrors the match-detail contracts in the frontend."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.match_stats import MatchStatsResponse
from app.schemas.odds import OddsResponse


class EventScore(BaseModel):
    home: int
    away: int


class EventSummary(BaseModel):
    event_id: str
    home_team: Optional[str] = None
    away_team: Optional[str] = None
    sport: Optional[str] = None
    country: Optional[str] = None
    competition: Optional[str] = None
    competition_path: Optional[str] = None
    start_time_utc: Optional[str] = None
    status: Optional[str] = Field(
        default=None,
        description=(
            'Upstream status as stored ("finished" can mean a pre-match capture); '
            '"scheduled" for fixtures known only from discovery.'
        ),
    )
    status_detail: Optional[str] = None
    outcome: Optional[str] = None
    score: Optional[EventScore] = Field(
        default=None, description="Final score parsed from the latest stored stats snapshot."
    )
    is_terminal: bool = Field(
        default=False,
        description="True once a terminal stats snapshot exists; the archive is then frozen.",
    )
    latest_odds_fetched_at: Optional[str] = None
    latest_stats_fetched_at: Optional[str] = None
    odds_snapshot_count: int = 0
    stats_snapshot_count: int = 0


class StoredOddsResponse(OddsResponse):
    """Latest stored odds snapshot in the ``/odds/{event_id}`` shape."""

    fetched_at: str
    served_from: Literal["stored"] = "stored"


class StoredMatchStatsResponse(MatchStatsResponse):
    """Latest stored stats snapshot in the ``/match-stats/{event_id}`` shape."""

    fetched_at: str


class EventPicks(BaseModel):
    live: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="paper_bets rows for the event, shaped like /picks/history live rows.",
    )
    backtest: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="backtest_bets rows for the event plus run_label and model; clv is null.",
    )
