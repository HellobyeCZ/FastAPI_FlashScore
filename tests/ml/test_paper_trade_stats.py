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


def test_aggregate_no_filters_no_group_returns_one_row(fixture_db):
    from app.ml.labels import backfill_labels
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    # Record a couple of synthetic picks and settle them.
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    from app.ml.closing_odds import backfill_closing_odds
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest())
    assert len(rows) == 1
    assert rows[0]["n"] == 1
    assert rows[0]["wins"] in (0, 1)

    # Verify the returned row carries every documented metric key.
    for key in ("n", "wins", "stake_total", "pnl_total", "mean_clv",
                "brier", "hit_rate", "roi", "max_drawdown"):
        assert key in rows[0], f"missing {key} in aggregate row"
    # hit_rate is either None or in [0, 1].
    assert rows[0]["hit_rate"] is None or 0.0 <= rows[0]["hit_rate"] <= 1.0
    # max_drawdown is a non-negative float.
    assert rows[0]["max_drawdown"] >= 0.0


def test_aggregate_group_by_model(fixture_db):
    from app.ml.labels import backfill_labels
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
        PickInput(
            event_id="evt001", model="dixon_coles", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.60,
            devigged_prob=0.5, edge=0.10, kelly_full=0.20,
        ),
    ]
    record_picks(picks)
    from app.ml.closing_odds import backfill_closing_odds
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("model",)))
    by_model = {r["model"]: r for r in rows}
    assert "logistic" in by_model
    assert "dixon_coles" in by_model
    assert by_model["logistic"]["n"] == 1
    assert by_model["dixon_coles"]["n"] == 1


def test_aggregate_min_n_filters_all_rows_does_not_raise(fixture_db):
    """With min_n_per_group=2 and only 1 bet, the global result row is
    filtered out by the outer WHERE on n (subquery-wrapper path, no
    group_by) and aggregate() should return an empty list, not raise
    IndexError when _attach_max_drawdown would otherwise index rows[0]."""
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(min_n_per_group=2))
    assert rows == []


def test_edge_bucket_grouping(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.51,
            devigged_prob=0.5, edge=0.01, kelly_full=0.10,
        ),
        PickInput(
            event_id="evt002", model="logistic", market="1X2_FT",
            selection="draw", bet_ts=_now_iso(),
            price_at_recommendation=3.5, model_prob=0.40,
            devigged_prob=0.30, edge=0.10, kelly_full=0.15,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("edge_bucket",)))
    buckets = {r["edge_bucket"] for r in rows}
    assert "0-2" in buckets
    assert "5-10" in buckets or "10-15" in buckets


def test_date_filter(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    # Filter that excludes everything.
    rows = aggregate(StatsRequest(
        filters=StatsFilter(date_from="2099-01-01T00:00:00Z"),
    ))
    assert len(rows) == 0 or rows[0]["n"] == 0


def test_min_n_per_group_drops_small_buckets(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("model",), min_n_per_group=5))
    assert len(rows) == 0
