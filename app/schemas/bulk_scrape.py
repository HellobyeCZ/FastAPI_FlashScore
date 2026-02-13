from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class BulkScrapeJobCreateRequest(BaseModel):
    competition_path: str = Field(
        ...,
        description="Competition path or URL, e.g. football/czech-republic/chance-liga",
        min_length=1,
    )
    seasons: int = Field(
        default=5,
        ge=1,
        le=50,
        description="Number of latest seasons to scan from archive.",
    )
    include_stats: bool = Field(default=True, description="Fetch match stats for each discovered event.")
    include_odds: bool = Field(default=True, description="Fetch odds for each discovered event.")
    max_concurrency: int = Field(
        default=4,
        ge=1,
        le=32,
        description="Concurrent workers processing event IDs.",
    )


class BulkScrapeJobEvent(BaseModel):
    event_id: str
    season_path: Optional[str] = None
    status: str
    attempts: int = 0
    skipped_reason: Optional[str] = None
    last_error: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    updated_at: str
    finished_at: Optional[str] = None


class BulkScrapeJob(BaseModel):
    id: int
    competition_path: str
    seasons: int
    include_stats: bool
    include_odds: bool
    max_concurrency: int
    status: str
    created_at: str
    started_at: Optional[str] = None
    updated_at: str
    finished_at: Optional[str] = None
    last_error: Optional[str] = None
    total_events: int = 0
    pending_events: int = 0
    running_events: int = 0
    succeeded_events: int = 0
    failed_events: int = 0
    skipped_events: int = 0


class BulkScrapeJobDetail(BulkScrapeJob):
    events: List[BulkScrapeJobEvent] = Field(default_factory=list)


class BulkScrapeJobListResponse(BaseModel):
    total: int
    jobs: List[BulkScrapeJob] = Field(default_factory=list)
