from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class OddsOutcome(BaseModel):
    """Individual selection available within a market."""

    id: Optional[str] = Field(default=None, description="Identifier provided by the upstream source.")
    label: Optional[str] = Field(default=None, description="User facing label, e.g. team name or outcome description.")
    selection_key: Optional[str] = Field(default=None, description="Stable key that can be used to match selections across updates.")
    odds_decimal: Optional[float] = Field(default=None, description="Odds expressed in decimal format if available.")
    odds_fractional: Optional[str] = Field(default=None, description="Odds expressed in fractional format if available.")
    probability: Optional[float] = Field(default=None, description="Implied probability or probability override supplied by upstream.")


class OddsMarket(BaseModel):
    """Container for all selections for a particular betting market."""

    id: Optional[str] = Field(default=None, description="Identifier provided by the upstream source.")
    name: Optional[str] = Field(default=None, description="Display name of the market (e.g. Match Winner).")
    key: Optional[str] = Field(default=None, description="Stable key that can be used to group markets across bookmakers.")
    outcomes: List[OddsOutcome] = Field(default_factory=list, description="Selections that belong to this market.")


class BookmakerOdds(BaseModel):
    """Odds data scoped to a bookmaker."""

    id: Optional[str] = Field(default=None, description="Identifier of the bookmaker from the upstream API.")
    name: Optional[str] = Field(default=None, description="Display name of the bookmaker.")
    region: Optional[str] = Field(default=None, description="Region or jurisdiction for which the odds apply.")
    markets: List[OddsMarket] = Field(default_factory=list, description="Markets offered by the bookmaker for the event.")


class EventOdds(BaseModel):
    """Top level odds container for an event."""

    event_id: str = Field(description="Identifier requested by the client.")
    event_name: Optional[str] = Field(default=None, description="Display name of the event or matchup.")
    competition_name: Optional[str] = Field(default=None, description="Competition or tournament name if provided.")
    start_time: Optional[datetime] = Field(default=None, description="Scheduled start time for the event in UTC.")
    bookmakers: List[BookmakerOdds] = Field(default_factory=list, description="Odds grouped by bookmaker.")


class OddsResponse(BaseModel):
    """Structured response returned to consumers of the odds endpoint."""

    event: EventOdds = Field(description="Event level odds information.")
    retrieved_at: datetime = Field(description="Timestamp when the odds were retrieved from the upstream service.")
    source: Optional[str] = Field(default=None, description="Identifier for the upstream odds provider.")
