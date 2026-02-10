from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class MatchStat(BaseModel):
    code: Optional[str] = Field(default=None, description="Flashscore statistic code.")
    label: Optional[str] = Field(default=None, description="User-facing statistic name.")
    home: Optional[str] = Field(default=None, description="Home-side value for the statistic.")
    away: Optional[str] = Field(default=None, description="Away-side value for the statistic.")


class MatchStatsCategory(BaseModel):
    name: str = Field(description="Logical category, e.g. Top stats, Shots, Attack.")
    stats: List[MatchStat] = Field(default_factory=list, description="Statistics grouped under this category.")


class MatchStatsPeriod(BaseModel):
    name: str = Field(description="Period label, e.g. Match, 1st Half, 2nd Half.")
    categories: List[MatchStatsCategory] = Field(
        default_factory=list, description="Categories available for this period."
    )


class MatchStatsEvent(BaseModel):
    event_id: str = Field(description="Flashscore event identifier.")
    home_team: Optional[str] = Field(default=None, description="Home team name.")
    away_team: Optional[str] = Field(default=None, description="Away team name.")
    sport: Optional[str] = Field(default=None, description="Sport name, e.g. football, hockey.")
    country: Optional[str] = Field(default=None, description="Country or region name from competition metadata.")
    competition: Optional[str] = Field(default=None, description="Competition/tournament name.")
    competition_stage: Optional[str] = Field(default=None, description="Competition stage/round, if available.")
    competition_path: Optional[str] = Field(
        default=None,
        description=(
            "Normalized competition path, e.g. FOOTBALL/CZECH REPUBLIC/MOL CUP - 1/128-FINALS."
        ),
    )
    start_time_utc: Optional[datetime] = Field(default=None, description="Scheduled start time in UTC.")
    status: Optional[str] = Field(default=None, description="Normalized match status.")
    status_detail: Optional[str] = Field(default=None, description="Provider-specific status detail.")
    outcome: Optional[str] = Field(
        default=None,
        description="Outcome of the match, e.g. home_win, away_win, draw.",
    )
    periods: List[MatchStatsPeriod] = Field(default_factory=list, description="Statistics grouped by periods.")


class MatchStatsResponse(BaseModel):
    event: MatchStatsEvent = Field(description="Event statistics payload.")
    retrieved_at: datetime = Field(description="Timestamp when stats were retrieved from upstream.")
    source: Optional[str] = Field(default=None, description="Identifier of upstream provider.")
