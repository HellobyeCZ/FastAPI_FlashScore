"""Golden-file regression tests for app.services.match_stats.map_match_stats_payload.

Coverage caveat: the mapper takes 7 metadata kwargs (`home_team`, `away_team`,
`sport`, `country`, `competition`, `competition_stage`, `competition_path`)
that it passes through unchanged to the output `event` block. Because these
goldens replay the captured `expected.event.*` values BACK as the kwargs,
those 7 fields are tautologically equal — drift in pass-through behavior is
NOT detected by this test net. What IS detected: every feed-derived field
(status, status_detail, outcome, start_time_utc, periods, sections, stats,
top players, score totals) and the entire FlashScore feed-format parser.
That's the load-bearing logic and the most likely regression source under
later refactors. Capturing metadata into a sidecar fixture is a follow-up
if pass-through coverage is ever needed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.match_stats import map_match_stats_payload
from tests.unit._golden_diff import assert_golden_match

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures" / "match_stats"

# Top-level fields that vary between mapper invocations (timestamps captured
# at call time) and must be stripped before comparison. Centralized so
# adding/removing volatile keys is a one-line change. Keep in sync with the
# odds-mapper test for structural consistency.
VOLATILE_FIELDS = {"retrieved_at"}


def _fixture_event_ids() -> list[str]:
    return sorted(
        path.name.removesuffix("_feeds.json")
        for path in FIXTURES_DIR.glob("*_feeds.json")
    )


@pytest.mark.parametrize("event_id", _fixture_event_ids())
def test_map_match_stats_payload_matches_golden(event_id: str) -> None:
    feeds = json.loads(
        (FIXTURES_DIR / f"{event_id}_feeds.json").read_text(encoding="utf-8")
    )
    expected = json.loads(
        (FIXTURES_DIR / f"{event_id}_expected.json").read_text(encoding="utf-8")
    )

    # The mapper accepts metadata kwargs that the FastAPI handler sources
    # separately (via MatchStatsClient.get_match_metadata). Replay them from
    # the captured response's `event` block so the mapper sees the same
    # inputs it saw at capture time.
    expected_event = expected.get("event", {})
    result = map_match_stats_payload(
        event_id=event_id,
        feed_payloads=feeds,
        home_team=expected_event.get("home_team"),
        away_team=expected_event.get("away_team"),
        sport=expected_event.get("sport"),
        country=expected_event.get("country"),
        competition=expected_event.get("competition"),
        competition_stage=expected_event.get("competition_stage"),
        competition_path=expected_event.get("competition_path"),
    )
    actual = json.loads(result.model_dump_json())

    for field in VOLATILE_FIELDS:
        actual.pop(field, None)
        expected.pop(field, None)

    assert_golden_match(actual, expected)
