"""Shared pytest fixtures."""
from __future__ import annotations

import os

import pytest

# Provide required scraper config so settings instantiation doesn't fail under tests.
os.environ.setdefault("APP_STATS_FEED_SIGN", "test-sign")
os.environ.setdefault("APP_DEFAULT_HEADERS", '{"User-Agent":"test"}')
os.environ.setdefault("APP_DATABASE_URL", "sqlite+aiosqlite:///:memory:")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
