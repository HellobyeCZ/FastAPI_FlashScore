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
    periods: List[MatchStatsPeriod] = Field(default_factory=list, description="Statistics grouped by periods.")


class MatchStatsResponse(BaseModel):
    event: MatchStatsEvent = Field(description="Event statistics payload.")
    retrieved_at: datetime = Field(description="Timestamp when stats were retrieved from upstream.")
    source: Optional[str] = Field(default=None, description="Identifier of upstream provider.")
