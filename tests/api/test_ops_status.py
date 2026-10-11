"""GET /ops/status — health rules, fallbacks and the no-heavy-query contract."""
from __future__ import annotations

import asyncio
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Iterator, List

import pytest
from fastapi.testclient import TestClient

from app.routes import ops
from app.schemas.ops import MlflowStatus, PipelineStatus, ServedModel

NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _health(**overrides):
    pipeline = overrides.pop("pipeline", PipelineStatus(last_pick_recorded_at=_iso(NOW - timedelta(hours=1))))
    models = overrides.pop("models", [ServedModel(name="logistic", loaded=True, source="file")])
    mlflow = overrides.pop(
        "mlflow", MlflowStatus(enabled=True, reachable=True, experiment_name="picks")
    )
    freshness = overrides.pop("freshness", {})
    return ops.evaluate_health(
        pipeline=pipeline, freshness=freshness, models=models, mlflow=mlflow, now=NOW,
    )


def _codes(health) -> dict:
    return {issue.code: issue for issue in health.issues}


# ---------------------------------------------------------------------------
# Health rules (pure)
# ---------------------------------------------------------------------------

def test_everything_fresh_is_ok():
    health = _health()
    assert health.level == "ok"
    assert health.issues == []


@pytest.mark.parametrize(
    ("age", "level"),
    [
        (timedelta(hours=35), None),
        (timedelta(hours=37), "warn"),
        (timedelta(days=6, hours=23), "warn"),
        (timedelta(days=7, hours=1), "error"),
    ],
)
def test_pipeline_stale_thresholds(age, level):
    since = _iso(NOW - age)
    health = _health(pipeline=PipelineStatus(last_pick_recorded_at=since))
    issues = _codes(health)
    if level is None:
        assert "pipeline_stale" not in issues
        assert health.level == "ok"
    else:
        assert issues["pipeline_stale"].level == level
        assert issues["pipeline_stale"].params == {"since": since}
        assert health.level == level


def test_pipeline_never_is_a_warning():
    health = _health(pipeline=PipelineStatus())
    assert _codes(health)["pipeline_never"].level == "warn"
    assert health.level == "warn"


def test_settle_overdue_carries_count_and_since():
    health = _health(freshness={"overdue_pending_bets": 3, "oldest_overdue_kickoff": "2026-05-12T15:30:00+00:00"})
    issue = _codes(health)["settle_overdue"]
    assert issue.level == "warn"
    assert issue.params == {"count": 3, "since": "2026-05-12T15:30:00+00:00"}


def test_no_models_loaded():
    health = _health(models=[ServedModel(name="logistic", loaded=False), ServedModel(name="hgb", loaded=False)])
    assert _codes(health)["no_models_loaded"].level == "warn"


def test_live_odds_stale_only_when_fixtures_exist():
    old = _iso(NOW - timedelta(hours=30))
    recent = _iso(NOW - timedelta(hours=2))
    last_pick = _iso(NOW - timedelta(hours=1))

    no_fixtures = PipelineStatus(last_pick_recorded_at=last_pick, last_live_odds_at=old, upcoming_fixtures_72h=0)
    assert "live_odds_stale" not in _codes(_health(pipeline=no_fixtures))

    fresh = PipelineStatus(last_pick_recorded_at=last_pick, last_live_odds_at=recent, upcoming_fixtures_72h=5)
    assert "live_odds_stale" not in _codes(_health(pipeline=fresh))

    stale = PipelineStatus(last_pick_recorded_at=last_pick, last_live_odds_at=old, upcoming_fixtures_72h=5)
    issue = _codes(_health(pipeline=stale))["live_odds_stale"]
    assert issue.level == "warn"
    assert issue.params == {"since": old}

    never = PipelineStatus(last_pick_recorded_at=last_pick, upcoming_fixtures_72h=5)
    assert _codes(_health(pipeline=never))["live_odds_stale"].params == {"since": None}


def test_mlflow_unreachable_but_disabled_is_not_an_issue():
    unreachable = MlflowStatus(
        enabled=True, reachable=False, tracking_uri="http://127.0.0.1:5050", experiment_name="picks",
    )
    issue = _codes(_health(mlflow=unreachable))["mlflow_unreachable"]
    assert issue.level == "warn"
    assert issue.params == {"uri": "http://127.0.0.1:5050"}

    disabled = MlflowStatus(enabled=False, reachable=False, experiment_name="picks")
    health = _health(mlflow=disabled)
    assert health.level == "ok"
    assert health.issues == []


def test_level_is_worst_issue():
    health = _health(
        pipeline=PipelineStatus(last_pick_recorded_at=_iso(NOW - timedelta(days=30))),
        models=[ServedModel(name="logistic", loaded=False)],
    )
    assert {i.code for i in health.issues} == {"pipeline_stale", "no_models_loaded"}
    assert health.level == "error"


# ---------------------------------------------------------------------------
# Endpoint against a seeded database
# ---------------------------------------------------------------------------

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

    now = datetime.now(timezone.utc)
    with sqlite3.connect(db) as c:
        # Last pick 10 days ago -> pipeline_stale error.
        for idx, (status, kickoff) in enumerate([
            ("pending", now - timedelta(days=9)),      # overdue
            ("pending", now - timedelta(hours=2)),     # inside the 6 h grace
            ("settled", now - timedelta(days=11)),
        ]):
            event_id = f"E{idx}"
            c.execute(
                "INSERT INTO paper_bets (event_id, model, market, selection, recommended_at, bet_ts, "
                "price_at_recommendation, model_prob, status, settled_at) VALUES "
                "(?, 'logistic', '1X2_FT', 'home', ?, ?, 2.0, 0.5, ?, ?)",
                (
                    event_id,
                    (now - timedelta(days=10 + idx)).isoformat(),
                    (now - timedelta(days=10 + idx)).isoformat(),
                    status,
                    (now - timedelta(days=10)).isoformat() if status == "settled" else None,
                ),
            )
            c.execute(
                "INSERT INTO match_event_summaries (event_id, start_time_utc, updated_at) VALUES (?, ?, ?)",
                (event_id, kickoff.isoformat().replace("+00:00", "Z"), now.isoformat()),
            )
        c.execute(
            "INSERT INTO upcoming_fixtures (event_id, competition_path, start_time_utc, discovered_at, "
            "last_refreshed_at) VALUES ('F1', 'football/spain/laliga', ?, ?, ?)",
            ((now + timedelta(hours=20)).isoformat(), now.isoformat(), now.isoformat()),
        )
        c.execute(
            "INSERT INTO live_odds_snapshots (event_id, fetched_at, market, selection_key, decimal_price) "
            "VALUES ('F1', ?, 'HOME_DRAW_AWAY:FULL_TIME', 'DRAW', 3.4)",
            ((now - timedelta(hours=30)).isoformat(),),
        )
        c.execute(
            "INSERT INTO upcoming_discovery_runs (competition_path, ran_at, fixtures_found, status) "
            "VALUES ('football/spain/laliga', ?, 1, 'ok')",
            ((now - timedelta(hours=3)).isoformat(),),
        )
        c.execute(
            "INSERT INTO scrape_jobs (competition_path, seasons, status, created_at, updated_at) "
            "VALUES ('football/spain/laliga', 1, 'completed', ?, ?)",
            ((now - timedelta(days=2)).isoformat(), (now - timedelta(days=2)).isoformat()),
        )
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, kelly_fraction, "
            "force_bets, scope_json, status, created_at) VALUES "
            "('bt1', 'l', 'logistic', '2024-08-01', 0.02, 0.25, 0, '[]', 'completed', ?)",
            (now.isoformat(),),
        )
        c.commit()
    return db


@pytest.fixture
def client(db_path: Path, monkeypatch) -> Iterator[TestClient]:
    import src
    from app.ml import serving, tracking

    # Pin both integration points to "not available" so the fallbacks are
    # exercised regardless of which serving/tracking version is installed.
    monkeypatch.delattr(serving, "served_models_info", raising=False)
    monkeypatch.delattr(tracking, "get_status", raising=False)
    monkeypatch.setattr(
        src,
        "_get_ml_artifacts",
        lambda: SimpleNamespace(logistic=None, hgb=object(), dc_rates=None),
    )
    src._get_backtest_manager.cache_clear()
    with TestClient(src.app) as c:
        yield c
    src._get_backtest_manager.cache_clear()


def test_ops_status_matches_contract(client: TestClient, monkeypatch):
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    resp = client.get("/ops/status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"generated_at", "git_sha", "db", "pipeline", "models", "mlflow", "health"}
    assert set(body["pipeline"]) == {
        "last_pick_recorded_at", "last_settled_at", "pending_bets", "oldest_pending_at",
        "last_live_odds_at", "last_discovery_at", "upcoming_fixtures_72h", "last_scrape_job_at",
        "active_scrape_jobs", "active_backtests",
    }
    assert body["db"]["size_bytes"] > 0

    pipeline = body["pipeline"]
    assert pipeline["pending_bets"] == 2
    assert pipeline["upcoming_fixtures_72h"] == 1
    assert pipeline["active_scrape_jobs"] == 0
    assert pipeline["active_backtests"] == 0
    assert pipeline["last_live_odds_at"] is not None
    assert pipeline["last_discovery_at"] is not None

    # Fallback serving info: flags from the file-based artifacts.
    assert body["models"] == [
        {"name": "logistic", "loaded": False, "source": None, "version": None, "run_id": None, "loaded_at": None},
        {"name": "hgb", "loaded": True, "source": "file", "version": None, "run_id": None, "loaded_at": None},
        {"name": "dixon_coles", "loaded": False, "source": None, "version": None, "run_id": None, "loaded_at": None},
    ]
    # Fallback MLflow status: enabled (env not set), reachability unknown.
    assert body["mlflow"]["enabled"] is True
    assert body["mlflow"]["reachable"] is False
    assert body["mlflow"]["error"] == "status unavailable"
    assert body["mlflow"]["experiment_name"] == "picks"

    issues = {i["code"]: i for i in body["health"]["issues"]}
    assert set(issues) == {"pipeline_stale", "settle_overdue", "live_odds_stale", "mlflow_unreachable"}
    assert issues["pipeline_stale"]["level"] == "error"
    assert issues["settle_overdue"]["params"]["count"] == 1
    assert body["health"]["level"] == "error"


def test_ops_status_disabled_mlflow_is_not_an_issue(client: TestClient, monkeypatch):
    monkeypatch.setenv("APP_MLFLOW_DISABLED", "1")
    body = client.get("/ops/status").json()
    assert body["mlflow"]["enabled"] is False
    assert "mlflow_unreachable" not in {i["code"] for i in body["health"]["issues"]}


def test_ops_status_uses_serving_and_tracking_when_available(client: TestClient, monkeypatch):
    from app.ml import serving, tracking

    monkeypatch.setattr(
        serving,
        "served_models_info",
        lambda: [{"name": "logistic", "loaded": True, "source": "registry", "version": "3",
                  "run_id": "abc", "loaded_at": datetime(2026, 10, 11, 10, tzinfo=timezone.utc),
                  "extra": "ignored"}],
        raising=False,
    )
    monkeypatch.setattr(
        tracking,
        "get_status",
        lambda: {"enabled": True, "reachable": True, "tracking_uri": "http://127.0.0.1:5050",
                 "ui_url": "http://127.0.0.1:5050", "experiment_name": "picks", "experiment_id": "2",
                 "error": None, "checked_at": "2026-10-11T10:00:00+00:00"},
        raising=False,
    )
    body = client.get("/ops/status").json()
    assert body["models"] == [{
        "name": "logistic", "loaded": True, "source": "registry", "version": "3",
        "run_id": "abc", "loaded_at": "2026-10-11T10:00:00+00:00",
    }]
    assert body["mlflow"]["experiment_id"] == "2"
    codes = {i["code"] for i in body["health"]["issues"]}
    assert "no_models_loaded" not in codes
    assert "mlflow_unreachable" not in codes


def test_ops_status_survives_failing_integrations(client: TestClient, monkeypatch):
    from app.ml import serving, tracking

    def _boom():
        raise RuntimeError("registry down")

    monkeypatch.setattr(serving, "served_models_info", _boom, raising=False)
    monkeypatch.setattr(tracking, "get_status", _boom, raising=False)
    resp = client.get("/ops/status")
    assert resp.status_code == 200
    body = resp.json()
    assert [m["name"] for m in body["models"]] == ["logistic", "hgb", "dixon_coles"]
    assert body["mlflow"]["error"] == "status unavailable"


def test_ops_status_never_scans_snapshot_tables(client: TestClient, monkeypatch):
    statements: List[str] = []
    real_connect = ops._connect

    def _traced() -> sqlite3.Connection:
        conn = real_connect()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(ops, "_connect", _traced)
    assert client.get("/ops/status").status_code == 200
    assert statements, "expected the status queries to be traced"
    snapshot_table = re.compile(r"(?<![a-z_])(odds_snapshots|match_stats_snapshots)\b", re.IGNORECASE)
    offending = [sql for sql in statements if snapshot_table.search(sql)]
    assert offending == []
    # The only live_odds_snapshots read is the indexed MAX().
    live = [sql for sql in statements if "live_odds_snapshots" in sql]
    assert live == ["SELECT MAX(fetched_at) FROM live_odds_snapshots"]
