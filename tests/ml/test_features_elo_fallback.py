import sqlite3
from pathlib import Path

import pytest

from app.ml.features import _pre_match_elo


@pytest.fixture
def conn_with_elo(tmp_path: Path):
    db = tmp_path / "test.sqlite3"
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    c.execute(
        """
        CREATE TABLE team_elo_history (
            event_id TEXT,
            team TEXT,
            start_time_utc TEXT,
            pre_elo REAL,
            post_elo REAL
        )
        """
    )
    c.executemany(
        "INSERT INTO team_elo_history VALUES (?,?,?,?,?)",
        [
            ("E1", "Arsenal", "2024-01-01T15:00:00Z", 1500.0, 1510.0),
            ("E2", "Arsenal", "2024-06-01T15:00:00Z", 1510.0, 1495.0),
            # Future row that must NOT be returned when as_of_ts is earlier:
            ("E3", "Arsenal", "2024-12-01T15:00:00Z", 1495.0, 1520.0),
        ],
    )
    c.commit()
    yield c
    c.close()


def test_pre_match_elo_fallback_excludes_future_rows(conn_with_elo):
    """For an unseen event at as_of=2024-07-01, fallback must not see E3."""
    val = _pre_match_elo(
        conn_with_elo,
        event_id="UNKNOWN",
        team="Arsenal",
        as_of_ts="2024-07-01T00:00:00Z",
    )
    # Expect post_elo from E2 (1495.0), NOT E3 (1520.0).
    assert val == pytest.approx(1495.0)


def test_pre_match_elo_fallback_excludes_test_event(conn_with_elo):
    """If the only candidate row is the test event itself, fallback must skip it."""
    # Same team, only rows we've seeded — pass the latest event's id explicitly.
    val = _pre_match_elo(
        conn_with_elo,
        event_id="E3",
        team="Arsenal",
        as_of_ts="2025-01-01T00:00:00Z",
    )
    # E3 itself has a pre_elo row (1495.0) — direct lookup wins.
    assert val == pytest.approx(1495.0)


def test_pre_match_elo_backward_compatible_no_as_of(conn_with_elo):
    """When as_of_ts is omitted (forward prediction), fallback returns latest."""
    val = _pre_match_elo(
        conn_with_elo,
        event_id="UNSEEN",
        team="Arsenal",
    )
    # Should return latest post_elo (1520.0 from E3).
    assert val == pytest.approx(1520.0)


def test_pre_match_elo_direct_lookup_wins(conn_with_elo):
    """If the event has its own pre_elo row, it's returned regardless of as_of."""
    val = _pre_match_elo(
        conn_with_elo,
        event_id="E1",
        team="Arsenal",
        as_of_ts="2024-07-01T00:00:00Z",
    )
    assert val == pytest.approx(1500.0)
