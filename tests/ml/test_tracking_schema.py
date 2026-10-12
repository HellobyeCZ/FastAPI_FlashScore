"""Schema discipline + enable-gate semantics for app.ml.tracking."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app.ml.backtest import BacktestReport, BetRecord, ReliabilityBucket
from app.ml.market_spec import FOOTBALL_1X2_FT

REPO_ROOT = Path(__file__).resolve().parents[2]


def _bet(*, result: float, price: float = 2.0, closing: float | None = None) -> BetRecord:
    return BetRecord(
        event_id="E1", bet_ts="2024-08-10T14:55:00Z",
        market="HOME_DRAW_AWAY:FULL_TIME", selection="home",
        price_taken=price, closing_price=price if closing is None else closing,
        model_prob=0.55, implied_prob=0.5, devigged_prob=0.48, edge=0.07,
        stake_kelly_fraction=0.05, result=result,
        pnl=0.05 * (price - 1.0) if result == 1.0 else -0.05, clv=0.0,
    )


def _report(bets: list[BetRecord], **overrides) -> BacktestReport:
    fields = dict(
        model="logistic", scope_size=10, test_events=10, bets=bets,
        total_bets=len(bets), hit_rate=0.5, roi=0.04, mean_clv=0.0,
        brier=0.2, log_loss=0.7, max_drawdown=0.1,
        reliability_buckets=[ReliabilityBucket(0.4, 0.6, len(bets), 0.55, 0.5)],
        config={"min_edge": 0.02, "kelly_fraction": 0.25, "force_bets": False,
                "train_until": "2024-08-01T00:00:00Z",
                "test_until": "2024-12-31T00:00:00Z"},
        n_train_events=0,
        return_per_bet=1.05, rmse_per_bet=0.5, sharpe_adjusted=0.10,
    )
    fields.update(overrides)
    return BacktestReport(**fields)


def _log_backtest(report: BacktestReport, **kwargs):
    from app.ml import tracking

    return tracking.log_backtest_run(
        report=report, model_name=kwargs.pop("model_name", "logistic"),
        train_until="2024-08-01T00:00:00Z", test_until="2024-12-31T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT, feature_columns=("home_elo",),
        backtest_run_id="bt_42", git_sha="deadbeef", **kwargs,
    )


def _small_logistic():
    import numpy as np

    from app.ml.training import BASE_FEATURE_COLUMNS, FeatureMatrix, train_logistic

    rng = np.random.default_rng(0)
    n = 60
    fm = FeatureMatrix(
        X=rng.normal(size=(n, len(BASE_FEATURE_COLUMNS))),
        y=rng.integers(0, 3, size=n),
        event_ids=[f"E{i}" for i in range(n)],
        kickoffs=[f"2024-01-{(i % 28) + 1:02d}T00:00:00Z" for i in range(n)],
    )
    return train_logistic(fm)


def _client(uri: str):
    import mlflow

    return mlflow.MlflowClient(tracking_uri=uri)


# ---------------------------------------------------------------------------
# Training runs
# ---------------------------------------------------------------------------

def test_log_training_run_writes_canonical_schema(mlflow_store):
    from app.ml import tracking

    mlflow_run_id = tracking.log_training_run(
        model_name="logistic", train_until="2024-08-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
        feature_columns=("home_elo", "away_elo"),
        n_train_events=123,
        metrics_uncalibrated={"brier": 0.21, "log_loss": 0.95},
        metrics_calibrated={"brier": 0.20, "log_loss": 0.93},
        trained_model=None,  # trainable model without a fitted object: no model logged
        git_sha="deadbeef",
    )
    assert mlflow_run_id is not None
    run = _client(mlflow_store).get_run(mlflow_run_id)
    assert run.data.tags.get("purpose") == "offline_training"
    assert run.data.tags.get("has_model") == "false"
    assert run.data.params.get("model_name") == "logistic"
    assert run.data.params.get("train_until") == "2024-08-01T00:00:00Z"
    assert run.data.params.get("market_spec_key") == "football_1x2_ft"
    assert run.data.params.get("sport") == "football"
    assert run.data.params.get("n_train_events") == "123"
    assert run.data.params.get("git_sha") == "deadbeef"
    assert run.data.metrics["uncal_brier"] == pytest.approx(0.21)
    assert run.data.metrics["cal_brier"] == pytest.approx(0.20)


def test_log_training_run_logs_hyperparams_and_model(mlflow_store):
    from app.ml import tracking

    run_id = tracking.log_training_run(
        model_name="logistic", train_until="2024-08-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT, feature_columns=("home_elo",),
        n_train_events=60,
        metrics_uncalibrated={"brier": 0.21}, metrics_calibrated={"brier": 0.20},
        trained_model=_small_logistic(),
        artifact_extras={"reliability_calibrated.svg": "<svg/>"},
        # model_name clashes with a canonical param: the canonical value wins.
        extra_params={"C": 0.5, "calib_until": "2025-02-01T00:00:00Z",
                      "model_name": "ignored"},
    )
    client = _client(mlflow_store)
    run = client.get_run(run_id)
    assert run.data.params["C"] == "0.5"
    assert run.data.params["calib_until"] == "2025-02-01T00:00:00Z"
    assert run.data.params["model_name"] == "logistic"
    assert run.data.tags["has_model"] == "true"
    assert run.outputs.model_outputs, "picks_model should be a logged model of the run"
    assert "reliability_calibrated.svg" in {a.path for a in client.list_artifacts(run_id)}


# ---------------------------------------------------------------------------
# Backtest runs
# ---------------------------------------------------------------------------

def test_log_backtest_run_writes_canonical_schema(mlflow_store):
    report = _report([_bet(result=1.0), _bet(result=0.0)])
    run_id = _log_backtest(report, n_train_events=500, scope_size=12,
                           trained_model=_small_logistic())
    assert run_id is not None
    client = _client(mlflow_store)
    run = client.get_run(run_id)
    tags, params, metrics = run.data.tags, run.data.params, run.data.metrics
    assert tags["purpose"] == "walk_forward_backtest"
    assert tags["backtest_run_id"] == "bt_42"
    assert tags["has_model"] == "true"
    assert params["test_until"] == "2024-12-31T00:00:00Z"
    assert params["min_edge"] == "0.02"
    assert params["kelly_fraction"] == "0.25"
    assert params["force_bets"] == "False"
    assert params["scope_size"] == "12"
    assert params["n_train_events"] == "500"
    assert metrics["n_bets"] == 2
    assert metrics["n_test_events"] == 10
    assert metrics["sharpe_adjusted"] == pytest.approx(0.10)
    assert "return_per_bet" in metrics and "rmse_per_bet" in metrics
    assert "reliability.svg" in {a.path for a in client.list_artifacts(run_id)}


def test_backtest_priced_at_close_does_not_log_clv(mlflow_store):
    """Archive backtests take the closing price, so CLV is undefined —
    mean_clv must be absent (not 0.0) and flagged by tag."""
    run = _client(mlflow_store).get_run(_log_backtest(_report([_bet(result=1.0)])))
    assert "mean_clv" not in run.data.metrics
    assert run.data.tags["clv_available"] == "false"


def test_backtest_with_pre_close_prices_logs_clv(mlflow_store):
    report = _report([_bet(result=1.0, price=2.1, closing=2.0)], mean_clv=0.048)
    run = _client(mlflow_store).get_run(_log_backtest(report))
    assert run.data.metrics["mean_clv"] == pytest.approx(0.048)
    assert run.data.tags["clv_available"] == "true"


def test_backtest_without_bets_omits_rate_metrics(mlflow_store):
    report = _report([], hit_rate=0.0, roi=0.0, brier=0.0)
    run = _client(mlflow_store).get_run(_log_backtest(report))
    assert run.data.metrics == {"n_bets": 0.0, "n_test_events": 10.0}


def test_analytic_backtest_logs_stateless_wrapper(mlflow_store):
    run_id = _log_backtest(_report([_bet(result=1.0)]), model_name="market_implied")
    run = _client(mlflow_store).get_run(run_id)
    assert run.data.tags["has_model"] == "true"
    assert run.outputs.model_outputs


def test_trainable_backtest_without_fitted_object_logs_no_model(mlflow_store):
    run_id = _log_backtest(_report([_bet(result=1.0)]), model_name="dixon_coles")
    run = _client(mlflow_store).get_run(run_id)
    assert run.data.tags["has_model"] == "false"
    assert not run.outputs.model_outputs


# ---------------------------------------------------------------------------
# Gate semantics
# ---------------------------------------------------------------------------

def test_disabled_via_env_returns_none(monkeypatch):
    from app.ml import tracking

    monkeypatch.setenv("APP_MLFLOW_DISABLED", "1")
    out = tracking.log_training_run(
        model_name="logistic", train_until="2024-08-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT, feature_columns=(), n_train_events=0,
        metrics_uncalibrated={}, metrics_calibrated={},
        trained_model=None,
    )
    assert out is None
    status = tracking.get_status()
    assert status["enabled"] is False
    assert status["reachable"] is False


def test_unreachable_server_skips_and_reprobes_after_ttl(monkeypatch):
    """An unreachable server costs one probe per TTL: calls inside the TTL
    are skipped without re-probing; after it expires the next call
    probes again (no permanent latch)."""
    from app.ml import tracking

    uri = "http://127.0.0.1:1"  # port 1 is reserved: connection refused
    monkeypatch.delenv("APP_MLFLOW_DISABLED", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    tracking._reset_state()
    probes: list[str] = []
    real_health_check = tracking._health_check
    monkeypatch.setattr(
        tracking, "_health_check",
        lambda u: probes.append(u) or real_health_check(u),
    )
    try:
        report = _report([_bet(result=1.0)])
        assert _log_backtest(report) is None
        assert probes == [uri]
        assert tracking.get_status()["reachable"] is False

        assert _log_backtest(report) is None
        assert probes == [uri], "inside the TTL the cached probe result is reused"

        with tracking._probe_lock:
            tracking._probes[uri] = tracking._probes[uri].__class__(
                reachable=False, error="stale", checked_at="", expires_at=0.0,
            )
        assert _log_backtest(report) is None
        assert probes == [uri, uri], "an expired probe is refreshed"
    finally:
        tracking._reset_state()


def test_data_error_does_not_disable_future_runs(mlflow_store, monkeypatch):
    import mlflow

    from app.ml import tracking

    real_log_metrics = mlflow.log_metrics
    calls = {"n": 0}

    def flaky_log_metrics(metrics, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("bad metric value")
        return real_log_metrics(metrics, *args, **kwargs)

    monkeypatch.setattr(mlflow, "log_metrics", flaky_log_metrics)
    report = _report([_bet(result=1.0)])
    assert _log_backtest(report) is None
    assert tracking.probe().reachable is True
    second = _log_backtest(report)
    assert second is not None
    assert _client(mlflow_store).get_run(second).info.status == "FINISHED"


def test_stale_experiment_id_is_resolved_again_after_a_failure(mlflow_store):
    """The `picks` experiment id is cached per URI. If the experiment is
    recreated on the server, the next run fails once and the one after
    it resolves the id again — no restart needed."""
    from app.ml import tracking

    real_id = tracking.ensure_experiment_id()
    with tracking._probe_lock:
        tracking._experiment_ids[mlflow_store] = "999999"  # gone from the server

    report = _report([_bet(result=1.0)])
    assert _log_backtest(report) is None
    assert tracking.cached_experiment_id() is None
    run_id = _log_backtest(report)
    assert run_id is not None
    assert _client(mlflow_store).get_run(run_id).info.experiment_id == real_id
    assert tracking.cached_experiment_id() == real_id


# ---------------------------------------------------------------------------
# Status + deep links
# ---------------------------------------------------------------------------

def test_get_status_reachable_store(mlflow_store):
    from app.ml import tracking

    status = tracking.get_status()
    assert set(status) == {
        "enabled", "reachable", "tracking_uri", "ui_url", "experiment_name",
        "experiment_id", "error", "checked_at",
    }
    assert status["enabled"] is True
    assert status["reachable"] is True
    assert status["tracking_uri"] == mlflow_store
    assert status["ui_url"] is None  # local store, no APP_MLFLOW_UI_URL
    assert status["experiment_name"] == "picks"
    assert status["experiment_id"] is not None
    assert status["error"] is None
    assert status["checked_at"].endswith("Z")


def test_ui_links(monkeypatch):
    from app.ml import tracking

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5050/")
    monkeypatch.delenv("APP_MLFLOW_UI_URL", raising=False)
    assert tracking.ui_base_url() == "http://127.0.0.1:5050"
    assert tracking.run_ui_url("abc", "2") == "http://127.0.0.1:5050/#/experiments/2/runs/abc"
    assert tracking.run_ui_url(None, "2") is None
    assert tracking.model_ui_url("picks-hgb", "3") == "http://127.0.0.1:5050/#/models/picks-hgb/versions/3"
    assert tracking.model_ui_url("picks-hgb") == "http://127.0.0.1:5050/#/models/picks-hgb"

    monkeypatch.setenv("APP_MLFLOW_UI_URL", "https://mlflow.example.test/")
    assert tracking.experiment_ui_url("2") == "https://mlflow.example.test/#/experiments/2"


def test_api_boots_and_logging_degrades_when_mlflow_is_unimportable(tmp_path):
    """`import mlflow` raising must cost the MLflow features, not the API."""
    script = textwrap.dedent(
        f"""
        import sys
        sys.modules["mlflow"] = None  # any `import mlflow` now raises ImportError

        import src  # noqa: F401  (API import path: src -> backtest_manager -> tracking)
        from app.ml import tracking
        from tests.ml.test_tracking_schema import _bet, _report, _log_backtest

        assert _log_backtest(_report([_bet(result=1.0)])) is None
        status = tracking.get_status()
        assert status["reachable"] is False, status
        assert "import" in status["error"], status
        print("OK")
        """
    )
    env = {
        **os.environ,
        "PYTHONPATH": str(REPO_ROOT),
        "APP_STORAGE_DB_PATH": str(tmp_path / "snap.sqlite3"),
        "MLFLOW_TRACKING_URI": f"sqlite:///{tmp_path / 'mlflow.db'}",
    }
    env.pop("APP_MLFLOW_DISABLED", None)
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=REPO_ROOT, env=env,
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip().endswith("OK")


# ---------------------------------------------------------------------------
# scripts/backfill_mlflow_backtests.py
# ---------------------------------------------------------------------------

def _seed_backtest_db(tmp_path, monkeypatch) -> Path:
    import asyncio
    import json
    import sqlite3

    from app.services.storage import SnapshotStore

    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE odds_snapshots (id INTEGER PRIMARY KEY, event_id TEXT, fetched_at TEXT)")
        c.execute(
            "CREATE TABLE match_stats_snapshots (id INTEGER PRIMARY KEY, event_id TEXT, "
            "fetched_at TEXT, is_terminal INTEGER DEFAULT 0)"
        )
    asyncio.run(SnapshotStore(str(db)).initialize())
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, test_until, min_edge, "
            "kelly_fraction, force_bets, scope_json, status, created_at, started_at, finished_at, "
            "test_events, total_bets, hit_rate, roi, mean_clv, brier, log_loss, max_drawdown, "
            "reliability_json, market_spec, sharpe_adjusted) "
            "VALUES ('old1', 'old run', 'logistic', '2024-08-01T00:00:00Z', NULL, 0.02, 0.25, 0, ?, "
            "'completed', '2024-09-01T10:00:00Z', '2024-09-01T10:00:01Z', '2024-09-01T10:05:00Z', "
            "50, 2, 0.5, 0.1, 0.0, 0.24, 0.68, 0.05, ?, 'football_1x2_ft', 0.0123)",
            (json.dumps([["ENGLAND", "Premier League"]]),
             json.dumps([{"lower": 0.4, "upper": 0.6, "n": 2, "mean_pred": 0.5, "hit_rate": 0.5}])),
        )
        c.executemany(
            "INSERT INTO backtest_bets (run_id, event_id, bet_ts, kickoff_ts, market, selection, "
            "price_taken, closing_price, model_prob, implied_prob, devigged_prob, edge, "
            "stake_kelly_fraction, result, pnl, clv) VALUES "
            "('old1', ?, '2024-08-10T14:55:00Z', '2024-08-10T15:00:00Z', 'HOME_DRAW_AWAY:FULL_TIME', "
            "'home', ?, ?, 0.5, 0.5, 0.48, 0.02, 0.05, ?, ?, 0.0)",
            [("E1", 3.0, 3.0, 1.0, 0.1), ("E2", 2.0, 2.0, 0.0, -0.05)],
        )
    return db


def test_backfill_logs_completed_runs_once(mlflow_store, tmp_path, monkeypatch, capsys):
    import sqlite3

    from scripts import backfill_mlflow_backtests as backfill

    db = _seed_backtest_db(tmp_path, monkeypatch)

    monkeypatch.setattr(sys, "argv", ["backfill", "--dry-run"])
    assert backfill.main() == 0
    assert "would log old1" in capsys.readouterr().out
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT mlflow_run_id FROM backtest_runs").fetchone()[0] is None

    monkeypatch.setattr(sys, "argv", ["backfill"])
    assert backfill.main() == 0
    with sqlite3.connect(db) as c:
        run_id = c.execute("SELECT mlflow_run_id FROM backtest_runs WHERE id = 'old1'").fetchone()[0]
    assert run_id

    client = _client(mlflow_store)
    run = client.get_run(run_id)
    assert run.info.status == "FINISHED"
    assert run.info.run_name == "bt_logistic_2024-08-01"
    assert run.data.tags["purpose"] == "backfill"
    assert run.data.tags["backtest_run_id"] == "old1"
    assert run.data.tags["has_model"] == "false"
    assert run.data.params["scope_size"] == "1"
    assert run.data.params["market"] == "1x2_ft"
    assert "mean_clv" not in run.data.metrics
    # Unit-stake recomputation, not the stored (Kelly-scaled) 0.0123:
    # returns [+2, -1] -> R_p = 1.5, RMSE = sqrt(2.5), Sharpe = 0.5 / sqrt(2.5).
    assert run.data.metrics["return_per_bet"] == pytest.approx(1.5)
    assert run.data.metrics["sharpe_adjusted"] == pytest.approx(0.5 / 2.5 ** 0.5)
    assert "reliability.svg" in {a.path for a in client.list_artifacts(run_id)}

    # Idempotent: nothing pending; a lost write-back is relinked, not duplicated.
    assert backfill.main() == 0
    with sqlite3.connect(db) as c:
        c.execute("UPDATE backtest_runs SET mlflow_run_id = NULL")
    assert backfill.main() == 0
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT mlflow_run_id FROM backtest_runs").fetchone()[0] == run_id
    experiment_id = run.info.experiment_id
    assert len(client.search_runs([experiment_id], "tags.purpose = 'backfill'")) == 1


def test_backfill_never_relinks_a_half_logged_run(mlflow_store, tmp_path, monkeypatch, capsys):
    """A run that fails after creation is discarded, the row stays pending
    and the script exits non-zero; the next invocation logs it afresh."""
    import sqlite3

    import mlflow

    from scripts import backfill_mlflow_backtests as backfill

    db = _seed_backtest_db(tmp_path, monkeypatch)
    real_log_text = mlflow.MlflowClient.log_text

    def failing_log_text(self, *args, **kwargs):
        raise RuntimeError("artifact upload failed")

    monkeypatch.setattr(mlflow.MlflowClient, "log_text", failing_log_text)
    monkeypatch.setattr(sys, "argv", ["backfill"])
    assert backfill.main() == 1
    assert "FAILED old1" in capsys.readouterr().err
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT mlflow_run_id FROM backtest_runs").fetchone()[0] is None
    client = _client(mlflow_store)
    experiment_id = client.get_experiment_by_name("picks").experiment_id
    assert client.search_runs([experiment_id], "tags.backtest_run_id = 'old1'") == []

    monkeypatch.setattr(mlflow.MlflowClient, "log_text", real_log_text)
    assert backfill.main() == 0
    with sqlite3.connect(db) as c:
        run_id = c.execute("SELECT mlflow_run_id FROM backtest_runs").fetchone()[0]
    assert client.get_run(run_id).info.status == "FINISHED"


def test_backfill_normalizes_legacy_sqlite_metrics(tmp_path, monkeypatch, capsys):
    import sqlite3

    from scripts import backfill_mlflow_backtests as backfill

    db = _seed_backtest_db(tmp_path, monkeypatch)
    with sqlite3.connect(db) as c:
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, kelly_fraction, "
            "force_bets, scope_json, status, created_at, test_events, total_bets, hit_rate, roi, "
            "mean_clv, brier, log_loss, max_drawdown, market_spec, mlflow_run_id) VALUES "
            "('empty', 'no bets', 'logistic', '2024-08-01T00:00:00Z', 0.02, 0.25, 0, '[]', "
            "'completed', '2024-09-02T10:00:00Z', 40, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "
            "'football_1x2_ft', 'already-linked')"
        )

    monkeypatch.setattr(sys, "argv", ["backfill", "--dry-run", "--normalize-sqlite"])
    assert backfill.main() == 0
    assert "would normalize metrics of 2 completed run(s)" in capsys.readouterr().out
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT sharpe_adjusted FROM backtest_runs WHERE id = 'old1'").fetchone()[0] == 0.0123

    # MLflow is disabled for this test: the SQLite pass still runs, the
    # MLflow backfill then reports it can't log.
    monkeypatch.setattr(sys, "argv", ["backfill", "--normalize-sqlite"])
    assert backfill.main() == 2
    with sqlite3.connect(db) as c:
        c.row_factory = sqlite3.Row
        old, empty = (
            c.execute("SELECT * FROM backtest_runs WHERE id = ?", (rid,)).fetchone()
            for rid in ("old1", "empty")
        )
    # Unit stakes, as in test_backfill_logs_completed_runs_once.
    assert old["sharpe_adjusted"] == pytest.approx(0.5 / 2.5 ** 0.5)
    assert old["mean_clv"] is None  # priced at the close
    assert old["roi"] == pytest.approx(0.1)  # defined values are kept
    for key in ("hit_rate", "roi", "mean_clv", "brier", "log_loss", "max_drawdown"):
        assert empty[key] is None, key
    assert empty["test_events"] == 40

    monkeypatch.setattr(sys, "argv", ["backfill", "--dry-run", "--normalize-sqlite"])
    assert backfill.main() == 0
    assert "would normalize metrics of 0 completed run(s)" in capsys.readouterr().out


def test_logging_recovers_after_a_failed_run_close(mlflow_store, monkeypatch):
    """If closing the MLflow run fails (server dropped mid-run), the
    fluent active-run stack of that thread must not keep the dead run:
    pool threads are reused, and a stale active run would make every
    later start_run on the thread fail."""
    import mlflow

    real_set_terminated = mlflow.MlflowClient.set_terminated
    calls = {"n": 0}

    def flaky_set_terminated(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("server went away while closing the run")
        return real_set_terminated(self, *args, **kwargs)

    monkeypatch.setattr(mlflow.MlflowClient, "set_terminated", flaky_set_terminated)
    report = _report([_bet(result=1.0)])
    assert _log_backtest(report) is None
    assert mlflow.active_run() is None
    second = _log_backtest(report)
    assert second is not None
    assert calls["n"] == 2  # the first close really failed, the second succeeded
    assert _client(mlflow_store).get_run(second).info.status == "FINISHED"


def test_redact_uri_strips_credentials(monkeypatch):
    from app.ml import tracking

    assert tracking.redact_uri("https://bob:s3cret@mlflow.example.com:8443/x?y=1") == "https://mlflow.example.com:8443/x?y=1"
    assert tracking.redact_uri("http://127.0.0.1:5050") == "http://127.0.0.1:5050"
    assert tracking.redact_uri(None) is None
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://u:p@127.0.0.1:1")
    monkeypatch.delenv("APP_MLFLOW_UI_URL", raising=False)
    assert tracking.ui_base_url() == "http://127.0.0.1:1"
