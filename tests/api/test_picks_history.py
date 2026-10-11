"""/picks/history filters, pagination and joined match fields; honest
/picks/stats metrics; /picks/summary freshness; source validation."""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

# (event_id, model, selection, recommended_at, edge, status, result, pnl)
LIVE_BETS = [
    ("E1", "logistic", "home", "2026-05-01T10:00:00+00:00", 0.03, "settled", 1.0, 0.9),
    ("E2", "logistic", "draw", "2026-05-02T10:00:00+00:00", 0.08, "settled", 0.0, -1.0),
    ("E3", "hgb", "away", "2026-05-03T10:00:00+00:00", 0.12, "settled", 1.0, 1.5),
    ("E4", "hgb", "home", "2026-05-04T10:00:00+00:00", 0.05, "voided", None, None),
    ("U1", "dixon_coles", "draw", "2026-05-05T10:00:00+00:00", 0.07, "pending", None, None),
]


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch) -> Path:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    from app.config import get_settings
    get_settings.cache_clear()

    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE odds_snapshots (id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT)")
        c.execute(
            "CREATE TABLE match_stats_snapshots "
            "(id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT, is_terminal INTEGER DEFAULT 0)"
        )
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())
    from app.ml.paper_trade import _ensure_paper_bets_table
    _ensure_paper_bets_table()

    with sqlite3.connect(db) as c:
        for event_id, home, away, country, competition, kickoff in [
            ("E1", "Sparta Prague", "Slavia Prague", "CZECH REPUBLIC", "Chance Liga", "2026-05-01T18:00:00Z"),
            ("E2", "Arsenal", "Chelsea", "ENGLAND", "Premier League", "2026-05-02T18:00:00Z"),
            ("E3", "Bayern", "Dortmund", "GERMANY", "Bundesliga", "2026-05-03T18:00:00Z"),
            ("E4", "Lyon", "Nice", "FRANCE", "Ligue 1", "2026-05-04T18:00:00Z"),
        ]:
            c.execute(
                "INSERT INTO match_event_summaries (event_id, home_team, away_team, sport, country, "
                "competition, start_time_utc, status, updated_at) VALUES (?, ?, ?, 'football', ?, ?, ?, "
                "'finished', ?)",
                (event_id, home, away, country, competition, kickoff, kickoff),
            )
        # U1 is only known from fixture discovery (lowercase country).
        c.execute(
            "INSERT INTO upcoming_fixtures (event_id, competition_path, sport, country, competition, "
            "home_team_raw, away_team_raw, start_time_utc, discovered_at, last_refreshed_at) VALUES "
            "('U1', 'football/spain/laliga', 'football', 'spain', 'laliga', 'Oviedo', 'Real Madrid', "
            "'2026-05-14T19:30:00+00:00', '2026-05-01T00:00:00+00:00', '2026-05-01T00:00:00+00:00')"
        )
        for event_id, model, selection, rec_at, edge, status, result, pnl in LIVE_BETS:
            c.execute(
                "INSERT INTO paper_bets (event_id, model, market, selection, recommended_at, bet_ts, "
                "price_at_recommendation, model_prob, edge, kelly_full, result, pnl, clv, status, "
                "settled_at) VALUES (?, ?, '1X2_FT', ?, ?, ?, 2.0, 0.5, ?, 1.0, ?, ?, 0.01, ?, ?)",
                (event_id, model, selection, rec_at, rec_at, edge, result, pnl, status,
                 rec_at if status == "settled" else None),
            )

        for run_id, model, label in [("ra", "logistic", "logistic Aug"), ("rb", "hgb", "hgb Aug")]:
            c.execute(
                "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, kelly_fraction, "
                "force_bets, scope_json, status, created_at) VALUES (?, ?, ?, '2024-08-01T00:00:00Z', "
                "0.02, 0.25, 0, '[]', 'completed', '2026-05-18T10:00:00Z')",
                (run_id, label, model),
            )
        # Interleaved timestamps across the two runs; two bets share a bet_ts.
        base = datetime(2024, 9, 1, 14, 55, tzinfo=timezone.utc)
        bets = [
            ("ra", "E1", base, "home"),
            ("rb", "E1", base, "draw"),
            ("ra", "E2", base + timedelta(days=1), "home"),
            ("rb", "E3", base + timedelta(days=2), "away"),
            ("ra", "E4", base + timedelta(days=3), "home"),
        ]
        for run_id, event_id, ts, selection in bets:
            stamp = ts.isoformat().replace("+00:00", "Z")
            c.execute(
                "INSERT INTO backtest_bets VALUES (?, ?, ?, ?, 'HOME_DRAW_AWAY:FULL_TIME', ?, 2.1, 2.1, "
                "0.55, 0.48, 0.46, 0.09, 0.04, 1.0, 0.044, 0.0)",
                (run_id, event_id, stamp, stamp, selection),
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


def test_live_history_newest_first_with_total_count_and_offset(client: TestClient):
    page1 = client.get("/picks/history", params={"limit": 2}).json()
    assert page1["count"] == len(LIVE_BETS)
    assert [r["event_id"] for r in page1["rows"]] == ["U1", "E4"]
    page2 = client.get("/picks/history", params={"limit": 2, "offset": 2}).json()
    assert page2["count"] == len(LIVE_BETS)
    assert [r["event_id"] for r in page2["rows"]] == ["E3", "E2"]


def test_live_history_rows_carry_match_fields(client: TestClient):
    rows = {r["event_id"]: r for r in client.get("/picks/history").json()["rows"]}
    archived = rows["E1"]
    assert (archived["home_team"], archived["away_team"]) == ("Sparta Prague", "Slavia Prague")
    assert archived["competition"] == "Chance Liga"
    assert archived["country"] == "CZECH REPUBLIC"
    assert archived["kickoff"] == "2026-05-01T18:00:00Z"
    # Fixture-only event falls back to the raw discovery names.
    fixture = rows["U1"]
    assert (fixture["home_team"], fixture["away_team"]) == ("Oviedo", "Real Madrid")
    assert fixture["home_team_raw"] == "Oviedo"
    assert fixture["country"] == "SPAIN"
    assert fixture["kickoff"] == "2026-05-14T19:30:00+00:00"
    assert fixture["competition_path"] == "football/spain/laliga"


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"model": "logistic"}, {"E1", "E2"}),
        ({"model": "logistic,hgb", "status": "settled"}, {"E1", "E2", "E3"}),
        ({"status": "voided"}, {"E4"}),
        ({"country": "ENGLAND,GERMANY"}, {"E2", "E3"}),
        ({"competition": "Chance Liga"}, {"E1"}),
        ({"edge_min": 0.06, "edge_max": 0.1}, {"E2", "U1"}),
        ({"selection": "home"}, {"E1", "E4"}),
        ({"date_from": "2026-05-02T00:00:00+00:00", "date_to": "2026-05-03T23:59:59+00:00"}, {"E2", "E3"}),
    ],
)
def test_live_history_filters(client: TestClient, params, expected):
    body = client.get("/picks/history", params=params).json()
    assert {r["event_id"] for r in body["rows"]} == expected
    assert body["count"] == len(expected)


@pytest.mark.parametrize(
    "params",
    [
        {"status": "settled"},
        {"status": "settled", "model": "logistic"},
        {"status": "all", "country": "ENGLAND,GERMANY"},
        {"status": "settled", "edge_min": 0.05},
    ],
)
def test_history_count_matches_stats_n(client: TestClient, params):
    history = client.get("/picks/history", params=params).json()
    stats = client.get("/picks/stats", params=params).json()
    assert history["count"] == stats["rows"][0]["n"]


def test_backtest_history_pages_globally_across_runs(client: TestClient):
    seen = []
    for offset in range(0, 5, 2):
        body = client.get(
            "/picks/history",
            params={"source": "backtest", "run_ids": "ra,rb", "limit": 2, "offset": offset},
        ).json()
        assert body["count"] == 5
        seen.extend((r["run_id"], r["event_id"], r["selection"]) for r in body["rows"])
    assert len(seen) == len(set(seen)) == 5
    assert seen[:3] == [("ra", "E4", "home"), ("rb", "E3", "away"), ("ra", "E2", "home")]


def test_backtest_history_rows(client: TestClient):
    body = client.get("/picks/history", params={"source": "backtest", "run_id": "rb"}).json()
    assert body["count"] == 2
    row = next(r for r in body["rows"] if r["event_id"] == "E3")
    assert row["run_id"] == "rb"
    assert row["run_label"] == "hgb Aug"
    assert row["model"] == "hgb"
    assert row["status"] == "settled"
    assert row["clv"] is None
    assert (row["home_team"], row["away_team"]) == ("Bayern", "Dortmund")
    assert row["country"] == "GERMANY"
    assert row["kickoff"] == "2024-09-03T14:55:00Z"


def test_backtest_history_filters_and_status(client: TestClient):
    params = {"source": "backtest", "run_ids": "ra,rb"}
    assert client.get("/picks/history", params={**params, "model": "hgb"}).json()["count"] == 2
    assert client.get("/picks/history", params={**params, "country": "CZECH REPUBLIC"}).json()["count"] == 2
    # Backtest bets are all settled.
    assert client.get("/picks/history", params={**params, "status": "pending"}).json()["count"] == 0
    assert client.get("/picks/history", params={**params, "status": "settled"}).json()["count"] == 5


def test_both_merges_live_and_backtest_by_time(client: TestClient):
    body = client.get(
        "/picks/history", params={"source": "both", "run_id": "ra", "limit": 4, "offset": 3},
    ).json()
    assert body["count"] == len(LIVE_BETS) + 3
    # Live bets (2026) sort before the 2024 backtest bets.
    assert [r["event_id"] for r in body["rows"]] == ["E2", "E1", "E4", "E2"]
    assert [r.get("run_id") for r in body["rows"]] == [None, None, "ra", "ra"]


def test_history_unknown_run_is_404(client: TestClient):
    resp = client.get("/picks/history", params={"source": "backtest", "run_id": "nope"})
    assert resp.status_code == 404


@pytest.mark.parametrize("path", ["/picks/history", "/picks/stats", "/picks/facets"])
def test_unknown_source_is_400(client: TestClient, path):
    resp = client.get(path, params={"source": "bogus", "run_id": "ra"})
    assert resp.status_code == 400
    assert "unknown source" in resp.json()["detail"]


def test_live_stats_metrics_are_null_when_empty(client: TestClient):
    rows = client.get("/picks/stats", params={"model": "no_such_model"}).json()["rows"]
    assert len(rows) == 1
    row = rows[0]
    assert row["n"] == 0
    for key in ("hit_rate", "roi", "brier", "mean_clv"):
        assert row[key] is None, key


def test_backtest_stats_null_clv_and_empty_metrics(client: TestClient):
    rows = client.get("/picks/stats", params={"source": "backtest", "run_id": "ra"}).json()["rows"]
    assert rows[0]["n"] == 3
    assert rows[0]["mean_clv"] is None
    assert rows[0]["run_id"] == "ra"
    assert rows[0]["run_label"] == "logistic Aug"
    assert rows[0]["model"] == "logistic"

    empty = client.get(
        "/picks/stats", params={"source": "backtest", "run_id": "ra", "market": "nope"},
    ).json()["rows"][0]
    assert empty["n"] == 0
    for key in ("hit_rate", "roi", "brier", "mean_clv"):
        assert empty[key] is None, key


def test_backtest_stats_group_by_run_id(client: TestClient):
    rows = client.get(
        "/picks/stats", params={"source": "backtest", "run_ids": "ra,rb", "group_by": "run_id"},
    ).json()["rows"]
    by_run = {r["run_id"]: r for r in rows}
    assert set(by_run) == {"ra", "rb"}
    assert by_run["ra"]["n"] == 3 and by_run["rb"]["n"] == 2
    assert by_run["ra"]["run_label"] == "logistic Aug"
    assert by_run["rb"]["model"] == "hgb"
    assert all(r["mean_clv"] is None for r in rows)


def test_backtest_stats_model_filter(client: TestClient):
    rows = client.get(
        "/picks/stats", params={"source": "backtest", "run_ids": "ra,rb", "model": "hgb"},
    ).json()["rows"]
    assert rows[0]["n"] == 2


def test_summary_reports_pipeline_freshness(client: TestClient):
    body = client.get("/picks/summary").json()
    assert body["last_recommended_at"] == "2026-05-05T10:00:00+00:00"
    assert body["last_settled_at"] == "2026-05-03T10:00:00+00:00"
    assert body["oldest_pending_kickoff"] == "2026-05-14T19:30:00+00:00"
    # Existing keys are untouched.
    assert body["totals"]["pending"] == 1


def test_summary_normalises_freshness_timestamps(client: TestClient, db_path: Path):
    with sqlite3.connect(db_path) as c:
        c.execute(
            "INSERT INTO paper_bets (event_id, model, market, selection, recommended_at, bet_ts, "
            "price_at_recommendation, model_prob, edge, kelly_full, result, pnl, status, settled_at) "
            "VALUES ('E5', 'hgb', '1X2_FT', 'home', '2026-05-06T10:00:00Z', '2026-05-06T10:00:00Z', "
            "2.0, 0.5, 0.05, 1.0, 1.0, 1.0, 'settled', '2026-05-07T08:00:00Z')"
        )
    body = client.get("/picks/summary").json()
    # Same ISO style /ops/status reports, whatever the stored suffix.
    assert body["last_recommended_at"] == "2026-05-06T10:00:00+00:00"
    assert body["last_settled_at"] == "2026-05-07T08:00:00+00:00"
