"""Test fixtures for app.ml.

Each test gets a clean, isolated SQLite DB seeded with a handful of
synthetic events that exercise the no-leakage contract. We don't touch
the real archive — these tests run anywhere.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Tuple

import pytest


HOME_TEAM = "Alpha FC"
AWAY_TEAM = "Beta United"
THIRD_TEAM = "Gamma City"


def _stats_payload(
    event_id: str,
    home: str,
    away: str,
    home_score: int,
    away_score: int,
    kickoff: datetime,
    status: str = "finished",
) -> Dict:
    return {
        "event": {
            "event_id": event_id,
            "home_team": home,
            "away_team": away,
            "sport": "football",
            "country": "TESTLAND",
            "competition": "Test League",
            "competition_stage": "Round 1",
            "competition_path": "FOOTBALL/TESTLAND/TEST LEAGUE",
            "start_time_utc": kickoff.isoformat().replace("+00:00", "Z"),
            "status": status,
            "outcome": "home" if home_score > away_score else ("away" if away_score > home_score else "draw"),
            "periods": [
                {
                    "name": "Match",
                    "categories": [
                        {
                            "name": "Score",
                            "stats": [
                                {"code": None, "label": "Final score", "home": str(home_score), "away": str(away_score)},
                            ],
                        },
                    ],
                },
                {
                    "name": "1st Half",
                    "categories": [
                        {
                            "name": "Score",
                            "stats": [
                                {"code": None, "label": "Period score", "home": str(home_score // 2), "away": str(away_score // 2)},
                            ],
                        },
                    ],
                },
            ],
        }
    }


def _odds_upstream(home_pid: str, away_pid: str, home_price: float, draw_price: float, away_price: float) -> Dict:
    """Minimal 1X2 FT odds payload from a single bookmaker."""
    return {
        "data": {
            "findOddsByEventId": {
                "settings": {
                    "bookmakers": [
                        {"bookmaker": {"id": 99, "name": "TestBook"}},
                    ],
                },
                "odds": [
                    {
                        "bookmakerId": 99,
                        "bettingType": "HOME_DRAW_AWAY",
                        "bettingScope": "FULL_TIME",
                        "odds": [
                            {"eventParticipantId": home_pid, "position": None, "selection": None,
                             "handicap": None, "active": True, "value": str(home_price)},
                            {"eventParticipantId": away_pid, "position": None, "selection": None,
                             "handicap": None, "active": True, "value": str(away_price)},
                            {"eventParticipantId": None, "position": None, "selection": None,
                             "handicap": None, "active": True, "value": str(draw_price)},
                        ],
                    }
                ],
            }
        }
    }


@pytest.fixture
def fixture_db(tmp_path, monkeypatch):
    """Create an isolated SQLite DB, seed it with synthetic events, and
    return ``(db_path, events)``."""
    db_file = tmp_path / "fixture.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db_file))
    # Reset the module-level "tables initialized" flag so each test gets a
    # fresh ensure_phase1_tables call against the new DB path.
    from app.ml import db as ml_db
    ml_db._TABLES_INITIALIZED = False
    # Also reset the cached settings so re-reads pick up the new env var.
    from app import config as app_config
    app_config.get_settings.cache_clear()

    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    # Minimal subset of the archive schema required by ml.labels and
    # ml.closing_odds queries.
    conn.executescript(
        """
        CREATE TABLE odds_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            source TEXT,
            correlation_id TEXT,
            odds_payload_json TEXT NOT NULL,
            upstream_payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_odds_snapshots_event_fetched ON odds_snapshots(event_id, fetched_at);
        CREATE TABLE match_stats_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            source TEXT,
            correlation_id TEXT,
            match_stats_payload_json TEXT NOT NULL,
            feed_payloads_json TEXT NOT NULL,
            is_terminal INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_match_stats_snapshots_event_fetched ON match_stats_snapshots(event_id, fetched_at);
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY,
            event_name TEXT,
            home_team TEXT,
            away_team TEXT,
            sport TEXT,
            country TEXT,
            competition TEXT,
            competition_stage TEXT,
            competition_path TEXT,
            start_time_utc TEXT,
            status TEXT,
            status_detail TEXT,
            outcome TEXT,
            odds_snapshot_count INTEGER NOT NULL DEFAULT 0,
            stats_snapshot_count INTEGER NOT NULL DEFAULT 0,
            latest_odds_fetched_at TEXT,
            latest_stats_fetched_at TEXT,
            updated_at TEXT NOT NULL
        );
        """
    )

    base = datetime(2024, 1, 1, 15, 0, tzinfo=timezone.utc)
    events: List[Tuple[str, str, str, int, int, datetime]] = [
        ("evt001", HOME_TEAM, AWAY_TEAM, 2, 1, base),
        ("evt002", AWAY_TEAM, THIRD_TEAM, 0, 0, base + timedelta(days=7)),
        ("evt003", THIRD_TEAM, HOME_TEAM, 1, 3, base + timedelta(days=14)),
        ("evt004", HOME_TEAM, AWAY_TEAM, 1, 2, base + timedelta(days=21)),  # target event
        ("evt005", AWAY_TEAM, HOME_TEAM, 3, 0, base + timedelta(days=28)),  # AFTER target
    ]
    for evt_id, home, away, hs, as_, ko in events:
        stats = _stats_payload(evt_id, home, away, hs, as_, ko)
        # Odds fetched 24h before kickoff (closing) for every event.
        fetched_at = (ko - timedelta(hours=24)).isoformat().replace("+00:00", "Z")
        # Simple participant IDs based on team name (deterministic).
        home_pid = f"pid_{home.replace(' ', '_')}"
        away_pid = f"pid_{away.replace(' ', '_')}"
        upstream = _odds_upstream(home_pid, away_pid, 2.0, 3.4, 4.0)
        conn.execute(
            "INSERT INTO odds_snapshots (event_id, fetched_at, source, odds_payload_json, upstream_payload_json) "
            "VALUES (?, ?, 'test', '{}', ?)",
            (evt_id, fetched_at, json.dumps(upstream)),
        )
        conn.execute(
            "INSERT INTO match_stats_snapshots (event_id, fetched_at, source, match_stats_payload_json, feed_payloads_json, is_terminal) "
            "VALUES (?, ?, 'test', ?, '{}', 1)",
            (evt_id, ko.isoformat().replace("+00:00", "Z"), json.dumps(stats)),
        )
        conn.execute(
            "INSERT INTO match_event_summaries (event_id, home_team, away_team, sport, country, competition, "
            "competition_path, start_time_utc, status, outcome, updated_at) "
            "VALUES (?, ?, ?, 'football', 'TESTLAND', 'Test League', "
            "'FOOTBALL/TESTLAND/TEST LEAGUE', ?, 'finished', ?, datetime('now'))",
            (evt_id, home, away, ko.isoformat().replace("+00:00", "Z"),
             "home" if hs > as_ else ("away" if as_ > hs else "draw")),
        )
    conn.commit()
    conn.close()
    return {"path": str(db_file), "events": events}
