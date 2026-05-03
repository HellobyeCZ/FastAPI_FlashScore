"""SQLAlchemy ORM models. MUST mirror frontend/prisma/schema.prisma exactly.

Prisma is the source of truth for the schema. These models exist so the Python
side can read/write the same Postgres database with type safety.

Forward reference: this file mirrors the POST-Task-7 reconciled Prisma schema.
The current Prisma schema only defines two of the five tables here, and uses
`upstream_payload_json` / `feed_payloads_json` rather than `upstream_blob_url`
/ `feed_payloads_blob_url`. Task 7 reconciles Prisma to add the missing tables;
Task 9 renames the JSON-text columns to blob-URL columns when migrating data
from SQLite to Postgres + the local blob store.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class OddsSnapshot(Base):
    __tablename__ = "odds_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_id: Mapped[str] = mapped_column(String, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str | None] = mapped_column(String, nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(String, nullable=True)
    odds_payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    upstream_blob_url: Mapped[str] = mapped_column(String, nullable=False)

    __table_args__ = (Index("idx_odds_snapshots_event_fetched", "event_id", "fetched_at"),)


class MatchStatsSnapshot(Base):
    __tablename__ = "match_stats_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_id: Mapped[str] = mapped_column(String, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str | None] = mapped_column(String, nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(String, nullable=True)
    match_stats_payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    feed_payloads_blob_url: Mapped[str] = mapped_column(String, nullable=False)
    is_terminal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("idx_match_stats_snapshots_event_fetched", "event_id", "fetched_at"),
    )


class ScrapeJob(Base):
    __tablename__ = "scrape_jobs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    competition_path: Mapped[str] = mapped_column(String, nullable=False)
    seasons: Mapped[int] = mapped_column(Integer, nullable=False)
    include_stats: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    include_odds: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    status: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_events: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    events: Mapped[list[ScrapeJobEvent]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("idx_scrape_jobs_status", "status", "id"),)


class ScrapeJobEvent(Base):
    __tablename__ = "scrape_job_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("scrape_jobs.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[str] = mapped_column(String, nullable=False)
    season_path: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    job: Mapped[ScrapeJob] = relationship(back_populates="events")

    __table_args__ = (
        UniqueConstraint("job_id", "event_id", name="uq_scrape_job_events_job_event"),
        Index("idx_scrape_job_events_job_status", "job_id", "status", "id"),
    )


class MatchEventSummary(Base):
    __tablename__ = "match_event_summaries"

    event_id: Mapped[str] = mapped_column(String, primary_key=True)
    event_name: Mapped[str | None] = mapped_column(String, nullable=True)
    home_team: Mapped[str | None] = mapped_column(String, nullable=True)
    away_team: Mapped[str | None] = mapped_column(String, nullable=True)
    sport: Mapped[str | None] = mapped_column(String, nullable=True)
    country: Mapped[str | None] = mapped_column(String, nullable=True)
    competition: Mapped[str | None] = mapped_column(String, nullable=True)
    competition_stage: Mapped[str | None] = mapped_column(String, nullable=True)
    competition_path: Mapped[str | None] = mapped_column(String, nullable=True)
    start_time_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str | None] = mapped_column(String, nullable=True)
    status_detail: Mapped[str | None] = mapped_column(String, nullable=True)
    outcome: Mapped[str | None] = mapped_column(String, nullable=True)
    odds_snapshot_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stats_snapshot_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    latest_odds_fetched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latest_stats_fetched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (Index("idx_match_event_summaries_updated", "updated_at"),)
