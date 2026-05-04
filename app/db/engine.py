"""SQLAlchemy async engine + session factory."""
from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings


# Engine + session factory are process-globals via @lru_cache. Task 13 will move
# them onto FastAPI's lifespan so engine.dispose() is called on shutdown.
@lru_cache
def get_engine() -> AsyncEngine:
    settings = get_settings()
    url = settings._resolve_value(settings.database_url)
    return create_async_engine(url, echo=False, pool_pre_ping=True)


@lru_cache
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an AsyncSession.

    Contract: callers commit explicitly. On any exception inside the request
    handler, the session is rolled back before the connection returns to the
    pool, so a failed request can't leak an open transaction.
    """
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
