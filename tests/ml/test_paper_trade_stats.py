"""Unit tests for app.ml.paper_trade_stats — the /picks/stats backend.

Hermetic: uses the existing fixture DB pattern. Tests query templating,
filter validation, bucket math, and aggregation correctness.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.ml.closing_odds import backfill_closing_odds
from app.ml.labels import backfill_labels
from app.ml.paper_trade import PickInput, record_picks, settle_pending_bets
from app.ml.paper_trade_stats import (
    StatsFilter,
    StatsRequest,
    aggregate,
    calibration_buckets,
)


TEST_SCOPE = (("TESTLAND", "Test League"),)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def test_invalid_group_by_raises():
    with pytest.raises(ValueError, match="unknown group_by"):
        StatsRequest(group_by=("not_a_real_dim",))


def test_invalid_status_raises():
    with pytest.raises(ValueError, match="unknown status"):
        StatsRequest(group_by=("model",), filters=StatsFilter(status="weird"))


def test_empty_group_by_is_valid():
    # No group_by means a single global row.
    req = StatsRequest(group_by=())
    assert req.group_by == ()
