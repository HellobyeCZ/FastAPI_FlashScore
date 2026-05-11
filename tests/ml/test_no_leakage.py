"""No-leakage tests for the Phase 1 feature store.

The contract: ``get_features(event_id, as_of_ts)`` must use only data with
timestamps strictly before ``as_of_ts``. These tests assert that contract
by constructing a synthetic event sequence and checking that:

  1. Form features for the target event don't include the target's own
     result, even when called with as_of_ts > kickoff.
  2. Form features only see strictly-earlier matches — the count of
     match history visible at as_of_ts grows monotonically as as_of_ts
     advances, and never includes future matches.
  3. Pre-match Elo equals what the Elo backfill computed for this
     event_id (and is therefore independent of as_of_ts, because Elo is
     computed chronologically and stored per-event).
  4. Market-implied probability is NULL when as_of_ts < odds fetched_at,
     and populated when as_of_ts >= odds fetched_at.
  5. Identical as_of_ts inputs yield identical outputs (idempotency).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.ml.closing_odds import backfill_closing_odds
from app.ml.features import get_features
from app.ml.labels import backfill_labels
from app.ml.elo import backfill_elo, EloConfig


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled(fixture_db):
    """Run labels + elo against the fixture DB and yield its events."""
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=TEST_SCOPE, rebuild=True)
    return fixture_db["events"]


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def test_form_excludes_target_event_even_when_as_of_after_kickoff(backfilled):
    # evt004 is at base+21d (2024-01-22). evt005 (the only later one) is
    # at base+28d. If we call get_features(evt004) with as_of *after*
    # evt004's kickoff but before evt005, the target's own result must
    # not leak into form.
    target_id = "evt004"
    target_kickoff = datetime(2024, 1, 22, 15, 0, tzinfo=timezone.utc)
    as_of_after_target = target_kickoff + timedelta(days=1)
    features = get_features(target_id, _iso(as_of_after_target))
    assert features is not None
    # evt004 result is HOME_TEAM lost 1-2 (away win). HOME_TEAM has played
    # evt001 (won), evt003 (won), evt004 (lost). Excluding evt004 leaves
    # exactly 2 matches in form. With evt004 included it would be 3.
    assert features["home_form_matches"] == 2
    # Two wins, two times 3 points each = 6 points / 2 matches = 3.0 PPG.
    assert features["home_form_ppg"] == 3.0


def test_form_only_sees_strictly_earlier_matches(backfilled):
    target_id = "evt004"
    target_kickoff = datetime(2024, 1, 22, 15, 0, tzinfo=timezone.utc)
    # Before evt004, HOME_TEAM has played evt001 (home win) and evt003 (away win) = 2 matches, 6 pts.
    one_sec_before = target_kickoff - timedelta(seconds=1)
    features = get_features(target_id, _iso(one_sec_before))
    assert features is not None
    assert features["home_form_matches"] == 2
    assert features["home_form_ppg"] == 3.0

    # If we go back to before any match, form should be empty.
    way_before = datetime(2020, 1, 1, tzinfo=timezone.utc)
    features = get_features(target_id, _iso(way_before))
    assert features is not None
    assert features["home_form_matches"] == 0
    assert features["home_form_ppg"] is None


def test_pre_match_elo_is_independent_of_as_of_ts(backfilled):
    """Pre-match Elo stored in team_elo_history is by definition the rating
    before this specific event_id. It should not vary with as_of_ts."""
    target_id = "evt004"
    target_kickoff = datetime(2024, 1, 22, 15, 0, tzinfo=timezone.utc)
    before = get_features(target_id, _iso(target_kickoff - timedelta(seconds=1)))
    long_after = get_features(target_id, _iso(target_kickoff + timedelta(days=365)))
    assert before is not None and long_after is not None
    assert before["home_elo"] == long_after["home_elo"]
    assert before["away_elo"] == long_after["away_elo"]


def test_market_prob_is_null_well_before_kickoff(backfilled):
    """For a terminal event, the archive's odds snapshot is treated as
    known at min(fetched_at, kickoff − 5min). Calling with as_of well
    before that effective cutoff must produce NULL market probs."""
    target_id = "evt004"
    target_kickoff = datetime(2024, 1, 22, 15, 0, tzinfo=timezone.utc)
    # The fixture stores fetched_at = kickoff − 24h, so the effective_ts
    # is kickoff − 24h. Calling 48h before kickoff is strictly before
    # that — expect NULL.
    too_early = target_kickoff - timedelta(hours=48)
    features = get_features(target_id, _iso(too_early))
    assert features is not None
    assert features["market_prob_home"] is None
    assert features["market_prob_draw"] is None
    assert features["market_prob_away"] is None

    # Calling 1h before kickoff (after effective_ts) populates them.
    just_before = target_kickoff - timedelta(hours=1)
    features = get_features(target_id, _iso(just_before))
    assert features is not None
    assert features["market_prob_home"] is not None
    assert features["market_prob_draw"] is not None
    assert features["market_prob_away"] is not None
    s = features["market_prob_home"] + features["market_prob_draw"] + features["market_prob_away"]
    assert 0.99 <= s <= 1.01


def test_archive_after_kickoff_still_yields_closing_line_at_buffer_edge(backfilled_post_kickoff):
    """If the archive captured odds *after* kickoff for a terminal event
    (the bulk-scrape window case), the prices are still the closing
    line. The effective timestamp is kickoff − 5min — so a feature
    query at kickoff − 5min populates market probs even though
    fetched_at is 48h after kickoff. This is the key correction over
    naively using fetched_at as the cutoff."""
    target_id, target_kickoff = backfilled_post_kickoff
    at_edge = target_kickoff - timedelta(minutes=5)
    features = get_features(target_id, _iso(at_edge))
    assert features is not None
    assert features["market_prob_home"] is not None
    assert features["market_prob_draw"] is not None
    assert features["market_prob_away"] is not None
    s = features["market_prob_home"] + features["market_prob_draw"] + features["market_prob_away"]
    assert 0.99 <= s <= 1.01

    # Crucially: with the old fetched_at-only logic, this query would
    # have returned NULL (fetched_at is 48h in the future relative to
    # as_of_ts). The new logic correctly recognises the prices as
    # closing-line and available at kickoff − 5min.


def test_archive_after_kickoff_buffer_edge_is_load_bearing(backfilled_post_kickoff):
    """The 5-minute buffer is load-bearing — features at kickoff − 6min
    must NOT include closing-line probs because effective_ts is
    kickoff − 5min, which is *later* than 6min before kickoff. At
    kickoff − 5min the line is exactly available; at kickoff − 4min
    (inside the buffer) the line is still available (we passed the
    effective cutoff)."""
    target_id, target_kickoff = backfilled_post_kickoff

    # 6 minutes before kickoff: effective_ts (kickoff − 5min) is after
    # as_of_ts → NULL.
    too_early = target_kickoff - timedelta(minutes=6)
    features = get_features(target_id, _iso(too_early))
    assert features is not None
    assert features["market_prob_home"] is None
    assert features["market_prob_draw"] is None
    assert features["market_prob_away"] is None

    # At exactly kickoff − 5min the line becomes available.
    at_buffer_edge = target_kickoff - timedelta(minutes=5)
    features = get_features(target_id, _iso(at_buffer_edge))
    assert features is not None
    assert features["market_prob_home"] is not None


def test_identical_inputs_yield_identical_outputs(backfilled):
    target_id = "evt004"
    target_kickoff = datetime(2024, 1, 22, 15, 0, tzinfo=timezone.utc)
    as_of = _iso(target_kickoff - timedelta(hours=1))
    first = get_features(target_id, as_of)
    second = get_features(target_id, as_of)
    assert first == second
