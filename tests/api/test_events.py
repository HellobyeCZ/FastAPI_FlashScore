"""GET /events/{event_id}[/odds|/stats|/picks] — stored data only."""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.schemas.match_stats import (
    MatchStat,
    MatchStatsCategory,
    MatchStatsEvent,
    MatchStatsPeriod,
    MatchStatsResponse,
)
from app.schemas.odds import BookmakerOdds, EventOdds, OddsMarket, OddsOutcome, OddsResponse

KICKOFF = datetime(2026, 5, 24, 12, 0, tzinfo=timezone.utc)


def _stats_response(*, final_score: tuple | None, fetched: datetime, status: str = "finished") -> MatchStatsResponse:
    score_stats = []
    if final_score is not None:
        score_stats.append(
            MatchStat(label="Final score", home=str(final_score[0]), away=str(final_score[1]))
        )
    return MatchStatsResponse(
        event=MatchStatsEvent(
            event_id="EVT1",
            home_team="Sparta Prague",
            away_team="Hradec Kralove",
            sport="football",
            country="CZECH REPUBLIC",
            competition="Chance Liga - Championship Group",
            competition_path="FOOTBALL/CZECH REPUBLIC/CHANCE LIGA - CHAMPIONSHIP GROUP",
            start_time_utc=KICKOFF,
            status=status,
            outcome="home_win" if final_score else None,
            periods=[
                MatchStatsPeriod(
                    name="Match",
                    categories=[MatchStatsCategory(name="Score", stats=score_stats)],
                )
            ],
        ),
        retrieved_at=fetched,
        source="test",
    )


def _odds_response(fetched: datetime, price: float) -> OddsResponse:
    return OddsResponse(
        event=EventOdds(
            event_id="EVT1",
            bookmakers=[
                BookmakerOdds(
                    id="49",
                    name="Tipsport.cz",
                    markets=[
                        OddsMarket(
                            id="HOME_DRAW_AWAY:FULL_TIME",
                            name="1X2",
                            key="HOME_DRAW_AWAY:FULL_TIME",
                            outcomes=[OddsOutcome(id="home", selection_key="home", odds_decimal=price)],
                        )
                    ],
                )
            ],
        ),
        retrieved_at=fetched,
        source="livesport",
    )


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch) -> Path:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    from app.config import get_settings
    get_settings.cache_clear()

    # Prisma owns these two tables; mirror its schema.
    with sqlite3.connect(db) as c:
        c.executescript(
            """
            CREATE TABLE odds_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
                fetched_at TEXT NOT NULL, source TEXT, correlation_id TEXT,
                odds_payload_json TEXT NOT NULL, upstream_payload_json TEXT NOT NULL
            );
            CREATE INDEX idx_odds_snapshots_event_fetched ON odds_snapshots(event_id, fetched_at);
            CREATE TABLE match_stats_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
                fetched_at TEXT NOT NULL, source TEXT, correlation_id TEXT,
                match_stats_payload_json TEXT NOT NULL, feed_payloads_json TEXT NOT NULL,
                is_terminal INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_match_stats_snapshots_event_fetched
                ON match_stats_snapshots(event_id, fetched_at);
            """
        )

    from app.services.storage import SnapshotStore

    async def _seed() -> None:
        store = SnapshotStore(str(db))
        await store.initialize()
        # A pre-match capture first, then the terminal one with the result.
        await store.save_match_stats_snapshot(
            event_id="EVT1",
            response=_stats_response(final_score=None, fetched=datetime(2026, 5, 13, tzinfo=timezone.utc)),
            feed_payloads={},
        )
        await store.save_odds_snapshot(
            event_id="EVT1",
            response=_odds_response(datetime(2026, 5, 13, tzinfo=timezone.utc), 1.9),
            upstream_payload={},
        )
        await store.save_odds_snapshot(
            event_id="EVT1",
            response=_odds_response(datetime(2026, 5, 24, 14, tzinfo=timezone.utc), 2.05),
            upstream_payload={},
        )
        await store.save_match_stats_snapshot(
            event_id="EVT1",
            response=_stats_response(final_score=(3, 1), fetched=datetime(2026, 5, 24, 14, tzinfo=timezone.utc)),
            feed_payloads={},
        )

    asyncio.run(_seed())

    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO upcoming_fixtures (event_id, competition_path, sport, country, competition, "
            "home_team_raw, away_team_raw, start_time_utc, discovered_at, last_refreshed_at) VALUES "
            "('UPC1', 'football/spain/laliga', 'football', 'spain', 'laliga', 'Oviedo', 'Real Madrid', "
            "'2026-05-14T19:30:00+00:00', '2026-05-11T20:48:02+00:00', '2026-05-13T20:40:00+00:00')"
        )
        c.execute(
            "INSERT INTO upcoming_fixtures (event_id, competition_path, sport, country, competition, "
            "home_team_raw, away_team_raw, start_time_utc, discovered_at, last_refreshed_at) VALUES "
            "('UPC2', 'football/spain/laliga', 'football', 'spain', 'laliga', 'Betis', 'Sevilla', "
            "?, '2026-05-11T20:48:02+00:00', '2026-05-13T20:40:00+00:00')",
            ((datetime.now(timezone.utc) + timedelta(days=3)).isoformat(),),
        )
        c.commit()
    return db


@pytest.fixture
def client(db_path: Path) -> Iterator[TestClient]:
    import src
    src._get_backtest_manager.cache_clear()
    with TestClient(src.app) as c:
        yield c
    src._get_backtest_manager.cache_clear()


def _seed_bets(db: Path) -> None:
    from app.ml.paper_trade import _ensure_paper_bets_table
    _ensure_paper_bets_table()
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO paper_bets (event_id, model, market, selection, recommended_at, bet_ts, "
            "price_at_recommendation, model_prob, edge, kelly_full, status) VALUES "
            "('UPC1', 'dixon_coles', '1X2_FT', 'draw', '2026-05-12T06:23:24+00:00', "
            "'2026-05-12T06:23:23+00:00', 6.55, 0.22, 0.07, 0.08, 'pending')"
        )
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, kelly_fraction, "
            "force_bets, scope_json, status, created_at) VALUES "
            "('run-a', 'logistic Aug', 'logistic', '2024-08-01T00:00:00Z', 0.02, 0.25, 0, '[]', "
            "'completed', '2026-05-18T10:00:00Z')"
        )
        c.execute(
            "INSERT INTO backtest_bets VALUES ('run-a', 'EVT1', '2026-05-24T11:55:00Z', "
            "'2026-05-24T12:00:00Z', 'HOME_DRAW_AWAY:FULL_TIME', 'home', 2.05, 2.05, 0.55, 0.49, "
            "0.47, 0.08, 0.04, 1.0, 0.042, 0.0)"
        )
        c.commit()


def test_event_summary_from_archive(client: TestClient):
    resp = client.get("/events/EVT1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["home_team"] == "Sparta Prague"
    assert body["away_team"] == "Hradec Kralove"
    assert body["competition"] == "Chance Liga - Championship Group"
    assert body["country"] == "CZECH REPUBLIC"
    assert body["start_time_utc"] == "2026-05-24T12:00:00+00:00"
    assert body["outcome"] == "home_win"
    assert body["score"] == {"home": 3, "away": 1}
    assert body["is_terminal"] is True
    assert body["odds_snapshot_count"] == 2
    assert body["stats_snapshot_count"] == 2
    assert body["latest_odds_fetched_at"] == "2026-05-24T14:00:00+00:00"
    assert body["latest_stats_fetched_at"] == "2026-05-24T14:00:00+00:00"


def test_event_summary_for_fixture_known_only_from_discovery(client: TestClient):
    resp = client.get("/events/UPC1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Kickoff has passed and no result is stored: status unknown, not "scheduled".
    assert body["status"] is None
    assert body["home_team"] == "Oviedo"
    assert body["away_team"] == "Real Madrid"
    assert body["country"] == "SPAIN"
    assert body["start_time_utc"] == "2026-05-14T19:30:00+00:00"
    assert body["score"] is None
    assert body["is_terminal"] is False
    assert body["odds_snapshot_count"] == 0
    assert body["stats_snapshot_count"] == 0


def test_fixture_with_kickoff_ahead_is_scheduled(client: TestClient):
    body = client.get("/events/UPC2").json()
    assert body["status"] == "scheduled"
    assert (body["home_team"], body["away_team"]) == ("Betis", "Sevilla")


def test_unknown_event_is_404(client: TestClient):
    for path in ("/events/NOPE", "/events/NOPE/odds", "/events/NOPE/stats"):
        assert client.get(path).status_code == 404, path


def test_event_odds_serves_latest_stored_snapshot(client: TestClient):
    resp = client.get("/events/EVT1/odds")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["served_from"] == "stored"
    assert body["fetched_at"] == "2026-05-24T14:00:00+00:00"
    outcome = body["event"]["bookmakers"][0]["markets"][0]["outcomes"][0]
    assert outcome["odds_decimal"] == 2.05
    assert body["event"]["event_id"] == "EVT1"


def test_event_stats_serves_latest_stored_snapshot(client: TestClient):
    resp = client.get("/events/EVT1/stats")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fetched_at"] == "2026-05-24T14:00:00+00:00"
    assert body["event"]["home_team"] == "Sparta Prague"
    stats = body["event"]["periods"][0]["categories"][0]["stats"]
    assert stats[0]["label"] == "Final score"


def test_fixture_without_snapshots_has_no_stored_odds(client: TestClient):
    assert client.get("/events/UPC1/odds").status_code == 404
    assert client.get("/events/UPC1/stats").status_code == 404


def test_event_endpoints_never_call_upstream(client: TestClient, monkeypatch):
    import src

    def _boom(*_args, **_kwargs):
        raise AssertionError("upstream client must not be used")

    monkeypatch.setattr(src._get_odds_client(), "get_odds", _boom)
    monkeypatch.setattr(src._get_match_stats_client(), "get_match_stats_feeds", _boom)
    for path in ("/events/EVT1", "/events/EVT1/odds", "/events/EVT1/stats", "/events/EVT1/picks"):
        assert client.get(path).status_code == 200, path


def test_event_picks_live_and_backtest(client: TestClient, db_path: Path):
    _seed_bets(db_path)

    live = client.get("/events/UPC1/picks").json()
    assert live["backtest"] == []
    assert len(live["live"]) == 1
    row = live["live"][0]
    # Same row shape as /picks/history live rows.
    history_row = client.get("/picks/history").json()["rows"][0]
    assert set(row) == set(history_row)
    assert row["home_team"] == "Oviedo"
    assert row["status"] == "pending"

    archived = client.get("/events/EVT1/picks").json()
    assert archived["live"] == []
    assert len(archived["backtest"]) == 1
    bet = archived["backtest"][0]
    assert bet["run_id"] == "run-a"
    assert bet["run_label"] == "logistic Aug"
    assert bet["model"] == "logistic"
    assert bet["price_taken"] == 2.05
    # CLV is undefined for bets priced at the close.
    assert bet["clv"] is None


def test_event_picks_for_event_without_bets_is_empty(client: TestClient):
    resp = client.get("/events/NOPE/picks")
    assert resp.status_code == 200
    assert resp.json() == {"live": [], "backtest": []}
