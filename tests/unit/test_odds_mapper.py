"""Golden-file regression tests for app.services.odds.map_odds_payload.

Each captured fixture pair (`{event_id}_upstream.json`, `{event_id}_expected.json`)
is fed back through the mapper and the result must match the saved snapshot byte-for-byte
(after JSON round-trip normalization).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.odds import map_odds_payload

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures" / "odds"


def _fixture_event_ids() -> list[str]:
    return sorted(
        path.name.removesuffix("_upstream.json")
        for path in FIXTURES_DIR.glob("*_upstream.json")
    )


@pytest.mark.parametrize("event_id", _fixture_event_ids())
def test_map_odds_payload_matches_golden(event_id: str) -> None:
    upstream = json.loads(
        (FIXTURES_DIR / f"{event_id}_upstream.json").read_text(encoding="utf-8")
    )
    expected = json.loads(
        (FIXTURES_DIR / f"{event_id}_expected.json").read_text(encoding="utf-8")
    )

    result = map_odds_payload(event_id=event_id, payload=upstream)
    actual = json.loads(result.model_dump_json())

    # `retrieved_at` is a wall-clock timestamp; ignore it.
    actual.pop("retrieved_at", None)
    expected.pop("retrieved_at", None)

    assert actual == expected
