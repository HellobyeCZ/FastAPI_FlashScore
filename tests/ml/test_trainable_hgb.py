"""Tests for fit_hgb_at and fit_hgb_pca_at adapters."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator

import numpy as np
import pytest

from app.ml.training import TrainedHGB


def _odds_upstream_payload(home_pid: str, away_pid: str) -> dict:
    """Minimal 1X2 FT odds upstream payload."""
    import json
    return {
        "data": {
            "findOddsByEventId": {
                "settings": {"bookmakers": [{"bookmaker": {"id": 1, "name": "TestBook"}}]},
                "odds": [
                    {
                        "bookmakerId": 1,
                        "bettingType": "HOME_DRAW_AWAY",
                        "bettingScope": "FULL_TIME",
                        "odds": [
                            {"eventParticipantId": home_pid, "position": None,
                             "selection": None, "handicap": None, "active": True, "value": "2.20"},
                            {"eventParticipantId": away_pid, "position": None,
                             "selection": None, "handicap": None, "active": True, "value": "3.50"},
                            {"eventParticipantId": None, "position": None,
                             "selection": None, "handicap": None, "active": True, "value": "3.30"},
                        ],
                    }
                ],
            }
        }
    }


@pytest.fixture
def db_with_events(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    """Seed a temp SQLite with enough Phase 1 + feature rows to exercise
    the ≥100-event calibration path.

    Strategy: seed 150 matches across 10 rotating team pairs into
    odds_snapshots + match_stats_snapshots, then run backfill_labels /
    backfill_closing_odds / backfill_elo to populate the derived tables
    with the correct schemas (same as production).
    """
    import json

    import app.ml.db as ml_db

    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    from app.config import get_settings
    get_settings.cache_clear()
    ml_db._TABLES_INITIALIZED = False

    # Seed the base snapshot tables (same minimal schema as conftest.py
    # fixture_db) then populate derived ML tables via backfill.
    c = sqlite3.connect(str(p))
    c.executescript("""
        CREATE TABLE odds_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            source TEXT,
            correlation_id TEXT,
            odds_payload_json TEXT NOT NULL,
            upstream_payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_odds_snapshots_event_fetched
            ON odds_snapshots(event_id, fetched_at);
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
        CREATE INDEX idx_match_stats_snapshots_event_fetched
            ON match_stats_snapshots(event_id, fetched_at);
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY,
            event_name TEXT, home_team TEXT, away_team TEXT,
            sport TEXT, country TEXT, competition TEXT,
            competition_stage TEXT, competition_path TEXT,
            start_time_utc TEXT, status TEXT, status_detail TEXT,
            outcome TEXT,
            odds_snapshot_count INTEGER NOT NULL DEFAULT 0,
            stats_snapshot_count INTEGER NOT NULL DEFAULT 0,
            latest_odds_fetched_at TEXT, latest_stats_fetched_at TEXT,
            updated_at TEXT NOT NULL
        );
    """)

    import random
    random.seed(0)
    outcomes = ("home", "draw", "away")
    # 10 teams, rotating pairings — warm-up 20 matches then 150 real ones
    teams = [f"Team{i}" for i in range(10)]
    all_events = []
    event_counter = 0
    for i in range(170):  # 170 total: first 20 warm-up, rest usable
        home_idx = i % 10
        away_idx = (i + 1) % 10
        home = teams[home_idx]
        away = teams[away_idx]
        eid = f"E{event_counter:04d}"
        event_counter += 1
        # Spread across Jan-Jun 2024 to stay before the "2024-08-01" cutoff
        month = (i % 6) + 1
        day = (i % 28) + 1
        ts = f"2024-{month:02d}-{day:02d}T15:00:00Z"
        outcome = outcomes[i % 3]
        home_score = 1 if outcome == "home" else 0
        away_score = 0 if outcome != "away" else 1
        # odds fetched 24h before kickoff (pre-kickoff, valid closing line)
        fetched_at = f"2024-{month:02d}-{day:02d}T15:00:00Z"
        home_pid = f"pid_{home_idx}"
        away_pid = f"pid_{away_idx}"
        upstream = _odds_upstream_payload(home_pid, away_pid)
        stats_payload = {
            "event": {
                "event_id": eid,
                "home_team": home,
                "away_team": away,
                "sport": "football",
                "country": "ENGLAND",
                "competition": "Premier League",
                "competition_stage": "Regular Season",
                "competition_path": "FOOTBALL/ENGLAND/PREMIER LEAGUE",
                "start_time_utc": ts,
                "status": "finished",
                "outcome": outcome,
                "periods": [
                    {
                        "name": "Match",
                        "categories": [
                            {"name": "Score", "stats": [
                                {"code": None, "label": "Final score",
                                 "home": str(home_score), "away": str(away_score)},
                            ]},
                        ],
                    },
                    {
                        "name": "1st Half",
                        "categories": [
                            {"name": "Score", "stats": [
                                {"code": None, "label": "Period score",
                                 "home": "0", "away": "0"},
                            ]},
                        ],
                    },
                ],
            }
        }
        c.execute(
            "INSERT INTO odds_snapshots "
            "(event_id, fetched_at, source, odds_payload_json, upstream_payload_json) "
            "VALUES (?, ?, 'test', '{}', ?)",
            (eid, fetched_at, json.dumps(upstream)),
        )
        c.execute(
            "INSERT INTO match_stats_snapshots "
            "(event_id, fetched_at, source, match_stats_payload_json, "
            "feed_payloads_json, is_terminal) VALUES (?, ?, 'test', ?, '{}', 1)",
            (eid, ts, json.dumps(stats_payload)),
        )
        c.execute(
            "INSERT INTO match_event_summaries "
            "(event_id, home_team, away_team, sport, country, competition, "
            "competition_path, start_time_utc, status, outcome, updated_at) "
            "VALUES (?, ?, ?, 'football', 'ENGLAND', 'Premier League', "
            "'FOOTBALL/ENGLAND/PREMIER LEAGUE', ?, 'finished', ?, datetime('now'))",
            (eid, home, away, ts, outcome),
        )
        all_events.append(eid)

    c.commit()
    c.close()

    # Backfill derived ML tables using the real pipeline functions.
    from app.ml.closing_odds import backfill_closing_odds
    from app.ml.elo import EloConfig, backfill_elo
    from app.ml.labels import backfill_labels

    scope = (("ENGLAND", "Premier League"),)
    backfill_labels(sport="football", scope=scope, rebuild=True)
    backfill_closing_odds(sport="football", scope=scope, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=scope, rebuild=True)

    yield p


def test_fit_hgb_at_returns_calibrated_model_fn(db_with_events):
    """≥100 pre-cutoff events → calibrated path."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import fit_hgb_at

    # Need a scope override so the seeded ENGLAND/Premier League events
    # match. FOOTBALL_1X2_FT.scope already includes that pairing.
    fn = fit_hgb_at("2024-08-01", FOOTBALL_1X2_FT)
    assert callable(fn)
    assert fn.__name__.endswith("_calibrated")


def test_fit_hgb_at_no_preprocessor(db_with_events):
    """Plain hgb does not attach a preprocessor."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import fit_hgb_at
    from app.ml.training import TrainedHGB

    fn = fit_hgb_at("2024-08-01", FOOTBALL_1X2_FT)
    # The closure captures the TrainedHGB; introspect via __closure__.
    trained = next(
        cell.cell_contents for cell in fn.__closure__
        if isinstance(cell.cell_contents, TrainedHGB)
    )
    assert trained.preprocessor is None


def test_trained_hgb_preprocessor_defaults_to_none():
    """Existing pickled artifacts (no preprocessor field) must keep loading."""
    th = TrainedHGB(model=object())
    assert th.preprocessor is None


def test_trained_hgb_predict_proba_skips_preprocessor_when_none():
    """When preprocessor is None, predict_proba calls self.model directly."""
    class FakeModel:
        def predict_proba(self, X):
            return np.array([[0.5, 0.3, 0.2]] * len(X))

    th = TrainedHGB(model=FakeModel())
    out = th.predict_proba(np.zeros((1, 12)))
    assert out.shape == (1, 3)
    assert pytest.approx(out[0].sum()) == 1.0


def test_trained_hgb_predict_proba_applies_preprocessor_when_set():
    """When preprocessor is set, predict_proba transforms first."""
    class FakePrep:
        def transform(self, X):
            # Project 12 -> 6 by halving (deterministic for the test).
            return X[:, :6]

    class FakeModel:
        last_X_shape = None

        def predict_proba(self, X):
            FakeModel.last_X_shape = X.shape
            return np.array([[0.5, 0.3, 0.2]] * len(X))

    th = TrainedHGB(model=FakeModel(), preprocessor=FakePrep())
    th.predict_proba(np.zeros((2, 12)))
    assert FakeModel.last_X_shape == (2, 6)


def test_isotonic_calibrate_preserves_preprocessor_on_trained_hgb():
    """isotonic_calibrate(TrainedHGB) returns a new TrainedHGB; the
    preprocessor must be carried over."""
    from app.ml.training import FeatureMatrix, isotonic_calibrate

    class FakePrep:
        def transform(self, X):
            return X[:, :6]

    class FakeModel:
        def predict_proba(self, X):
            # Calibration needs distinct prob values per row to fit
            # IsotonicRegression — synthesize a small spread.
            n = len(X)
            base = np.linspace(0.2, 0.8, n)
            return np.stack([base, 1 - base - 0.1, np.full(n, 0.1)], axis=1)

    raw = TrainedHGB(model=FakeModel(), preprocessor=FakePrep())
    calib = FeatureMatrix(
        X=np.zeros((30, 12)),
        y=np.array([0, 1, 2] * 10),
        event_ids=[f"E{i}" for i in range(30)],
        kickoffs=[f"2024-08-{i+1:02d}T15:00:00Z" for i in range(30)],
    )
    cal = isotonic_calibrate(raw, calib)
    assert isinstance(cal, TrainedHGB)
    assert cal.preprocessor is raw.preprocessor  # same fitted object
    assert cal.calibrators is not None


def test_fit_and_apply_preprocessor_returns_projected_matrix():
    """_fit_and_apply_preprocessor fits scaler+PCA(0.95) and projects."""
    from app.ml.trainable import _fit_and_apply_preprocessor
    from app.ml.training import FeatureMatrix, HGB_FEATURE_COLUMNS

    rng = np.random.default_rng(0)
    # Make last 6 columns near-duplicates of the first 6 so the effective
    # rank is ~6. StandardScaler whitens all columns to unit variance, so
    # small absolute variance doesn't help — redundancy (correlation) is
    # what causes PCA(0.95) to drop components.
    X = rng.normal(size=(200, 12))
    X[:, 6:] = X[:, :6] + rng.normal(size=(200, 6)) * 0.01
    fm = FeatureMatrix(
        X=X,
        y=rng.integers(0, 3, size=200),
        event_ids=[f"E{i}" for i in range(200)],
        kickoffs=[f"2024-08-{(i%28)+1:02d}T15:00:00Z" for i in range(200)],
        columns=HGB_FEATURE_COLUMNS,
    )

    prep, projected = _fit_and_apply_preprocessor(fm)
    assert projected.X.shape[0] == 200
    assert projected.X.shape[1] < 12  # PCA(0.95) drops the redundant cols
    # The pipeline must be runnable on new data.
    Xnew = rng.normal(size=(5, 12))
    Xnew[:, 6:] = Xnew[:, :6] + rng.normal(size=(5, 6)) * 0.01
    out = prep.transform(Xnew)
    assert out.shape == (5, projected.X.shape[1])
    # Column names are pcN
    assert projected.columns[0] == "pc1"


def test_apply_preprocessor_uses_existing_fit():
    """_apply_preprocessor must not refit."""
    from app.ml.trainable import _apply_preprocessor, _fit_and_apply_preprocessor
    from app.ml.training import FeatureMatrix, HGB_FEATURE_COLUMNS

    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, 12))
    X[:, 6:] = X[:, :6] + rng.normal(size=(200, 6)) * 0.01
    fm = FeatureMatrix(
        X=X, y=rng.integers(0, 3, size=200),
        event_ids=[f"E{i}" for i in range(200)],
        kickoffs=[f"2024-08-{(i%28)+1:02d}T15:00:00Z" for i in range(200)],
        columns=HGB_FEATURE_COLUMNS,
    )
    prep, _ = _fit_and_apply_preprocessor(fm)

    calib = FeatureMatrix(
        X=rng.normal(size=(30, 12)),
        y=rng.integers(0, 3, size=30),
        event_ids=[f"C{i}" for i in range(30)],
        kickoffs=[f"2024-09-{(i%28)+1:02d}T15:00:00Z" for i in range(30)],
        columns=HGB_FEATURE_COLUMNS,
    )
    out = _apply_preprocessor(prep, calib)
    assert out.X.shape[0] == 30
    assert out.X.shape[1] == prep.named_steps["pca"].n_components_
