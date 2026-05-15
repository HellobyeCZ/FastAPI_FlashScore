# Stage 2 — HGB and HGB+PCA Trainable Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `hgb` and `hgb_pca` to the `TRAINABLE` registry so both appear in the `/backtest/models` dropdown and produce walk-forward backtests with zero leakage. `hgb_pca` fits a `StandardScaler → PCA(0.95)` preprocessor on the train block, freezes it, and stores it on the trained model so calibration and serving go through the same projection.

**Architecture:** Additive `TrainedHGB.preprocessor` field (`Optional[Pipeline]`, default `None`) + one-line copy in `isotonic_calibrate`. Two new adapter functions `fit_hgb_at` and `fit_hgb_pca_at` in `app/ml/trainable.py` mirror `fit_logistic_at`. The PCA variant uses two small private helpers `_fit_and_apply_preprocessor` and `_apply_preprocessor` that fit/apply the sklearn `Pipeline` and return projected `FeatureMatrix` instances. The TRAINABLE registry gains two entries. No SQLite migration; no frontend changes; the live `/predict` artifact path is untouched.

**Tech Stack:** scikit-learn (`HistGradientBoostingClassifier`, `StandardScaler`, `PCA`, `Pipeline`, `IsotonicRegression`), numpy, pytest. Existing `app/ml/training.py` + `app/ml/trainable.py` modules.

**Branch:** `claude/epic-saha-1c8754`.

**Spec:** [docs/superpowers/specs/2026-05-15-stage2-hgb-pca-design.md](../specs/2026-05-15-stage2-hgb-pca-design.md).

---

## File Structure

**Backend (modified):**
- `app/ml/training.py` — `TrainedHGB.preprocessor: Optional[object] = None`; `predict_proba` applies it; `isotonic_calibrate` copies it into the returned model.
- `app/ml/trainable.py` — `fit_hgb_at`, `fit_hgb_pca_at`, `_fit_and_apply_preprocessor`, `_apply_preprocessor`; two new entries in `TRAINABLE`.

**Backend (new):**
- `tests/ml/test_trainable_hgb.py` — shape, calibration plumbing, preprocessor presence, no-leakage smoke, registry wiring.

**Touchpoints to leave alone:**
- `scripts/train_hgb.py` — unchanged. The on-disk artifact path stays back-compat.
- `app/ml/serving.py` — unchanged. Existing pickled `TrainedHGB` artifacts load with `preprocessor=None` (dataclass default).
- `src.py` — unchanged. `/backtest/models` unions analytic + TRAINABLE keys; new entries appear automatically.
- Frontend — unchanged.

---

## Task 1: `TrainedHGB.preprocessor` field

Adds the dataclass field so the PCA adapter has somewhere to stash the fitted preprocessor.

**Files:**
- Modify: `app/ml/training.py` (around lines 314-342, the `TrainedHGB` dataclass)
- Test: `tests/ml/test_trainable_hgb.py` (new file; this task seeds it with one test)

- [ ] **Step 1: Write the failing test**

```python
# tests/ml/test_trainable_hgb.py
"""Tests for fit_hgb_at and fit_hgb_pca_at adapters."""
from __future__ import annotations

import numpy as np
import pytest

from app.ml.training import TrainedHGB


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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: FAIL with `TypeError: TrainedHGB() got an unexpected keyword argument 'preprocessor'` on the third test (the first two pass against the current code by coincidence).

- [ ] **Step 3: Add the `preprocessor` field and route `predict_proba` through it**

In `app/ml/training.py`, find the `TrainedHGB` dataclass (around line 314). Add the field and modify `predict_proba`:

```python
@dataclass
class TrainedHGB:
    model: object  # sklearn HistGradientBoostingClassifier
    calibrators: Optional[Tuple[object, object, object]] = None
    feature_columns: Tuple[str, ...] = HGB_FEATURE_COLUMNS
    preprocessor: Optional[object] = None  # NEW: fitted sklearn Pipeline or None

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.preprocessor is not None:
            X = self.preprocessor.transform(X)
        return self.model.predict_proba(X)

    def predict_proba_calibrated(self, X: np.ndarray) -> np.ndarray:
        raw = self.predict_proba(X)
        if self.calibrators is None:
            return raw
        calibrated = np.zeros_like(raw)
        for k, cal in enumerate(self.calibrators):
            calibrated[:, k] = cal.predict(raw[:, k])
        row_sums = calibrated.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0
        return calibrated / row_sums
```

`save`/`load` need no changes — `pickle.dump(self)` automatically serializes the new field.

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Run the broader training-module tests to confirm no regression**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/ -v
```

Expected: all green. Pay special attention to anything that pickles/unpickles `TrainedHGB` — older pickles deserialize without the new field, which dataclass `default=None` handles correctly.

- [ ] **Step 6: Commit**

```bash
git add app/ml/training.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): TrainedHGB gains optional preprocessor field

predict_proba runs preprocessor.transform first when set. Defaults to
None so existing pickled artifacts and scripts/train_hgb.py output keep
working unchanged."
```

---

## Task 2: `isotonic_calibrate` preserves preprocessor

Without this, calibrating an HGB+PCA model would lose the projection on the returned object.

**Files:**
- Modify: `app/ml/training.py` (the `isotonic_calibrate` function, around lines 281-307)
- Test: `tests/ml/test_trainable_hgb.py`

- [ ] **Step 1: Write the failing test**

Add this test to `tests/ml/test_trainable_hgb.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py::test_isotonic_calibrate_preserves_preprocessor_on_trained_hgb -v
```

Expected: FAIL with `assert None is <FakePrep object>` because `isotonic_calibrate` doesn't copy `preprocessor`.

- [ ] **Step 3: Add the one-line copy**

In `app/ml/training.py`, find the `isinstance(model, TrainedHGB)` branch of `isotonic_calibrate` (around line 297-302). Replace the `TrainedHGB(...)` constructor call with:

```python
    if isinstance(model, TrainedHGB):
        return TrainedHGB(
            model=model.model,
            calibrators=tuple(calibrators),
            feature_columns=model.feature_columns,
            preprocessor=getattr(model, "preprocessor", None),  # NEW
        )
```

`getattr` with a default keeps the call safe against any future caller that passes an object missing the field.

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: all tests in the file pass (now 4).

- [ ] **Step 5: Confirm no regression**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/ -v
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/ml/training.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): isotonic_calibrate carries preprocessor across

Calibrating a TrainedHGB now preserves the fitted preprocessor on the
returned object, so the calibrated model still applies its
StandardScaler+PCA projection at predict time."
```

---

## Task 3: Preprocessor helpers in `trainable.py`

Two small private functions that the PCA adapter will call. Lives in `trainable.py` (not `training.py`) so `training.py` stays the pure training-mechanics module.

**Files:**
- Modify: `app/ml/trainable.py`
- Test: `tests/ml/test_trainable_hgb.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/ml/test_trainable_hgb.py`:

```python
def test_fit_and_apply_preprocessor_returns_projected_matrix():
    """_fit_and_apply_preprocessor fits scaler+PCA(0.95) and projects."""
    from app.ml.trainable import _fit_and_apply_preprocessor
    from app.ml.training import FeatureMatrix, HGB_FEATURE_COLUMNS

    rng = np.random.default_rng(0)
    # Construct a matrix where features have varying variance so
    # PCA(0.95) keeps fewer than 12 components.
    X = rng.normal(size=(200, 12))
    X[:, 6:] *= 0.01  # last 6 columns have tiny variance → PCA drops them
    fm = FeatureMatrix(
        X=X,
        y=rng.integers(0, 3, size=200),
        event_ids=[f"E{i}" for i in range(200)],
        kickoffs=[f"2024-08-{(i%28)+1:02d}T15:00:00Z" for i in range(200)],
        columns=HGB_FEATURE_COLUMNS,
    )

    prep, projected = _fit_and_apply_preprocessor(fm)
    assert projected.X.shape[0] == 200
    assert projected.X.shape[1] < 12  # PCA(0.95) drops the tiny-variance cols
    # The pipeline must be runnable on new data.
    Xnew = rng.normal(size=(5, 12))
    Xnew[:, 6:] *= 0.01
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
    X[:, 6:] *= 0.01
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py::test_fit_and_apply_preprocessor_returns_projected_matrix tests/ml/test_trainable_hgb.py::test_apply_preprocessor_uses_existing_fit -v
```

Expected: FAIL with `ImportError: cannot import name '_fit_and_apply_preprocessor' from 'app.ml.trainable'`.

- [ ] **Step 3: Add the helpers**

In `app/ml/trainable.py`, append before the `TRAINABLE` registry:

```python
def _fit_and_apply_preprocessor(train: "FeatureMatrix"):
    """Fit StandardScaler+PCA(0.95) on ``train.X``. Returns the fitted
    sklearn Pipeline and a new FeatureMatrix with the projected X and
    synthesized ``pc1..pcK`` column names. ``y``, ``event_ids``, and
    ``kickoffs`` carry over unchanged."""
    from sklearn.decomposition import PCA
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    from app.ml.training import FeatureMatrix

    prep = Pipeline([
        ("scaler", StandardScaler()),
        ("pca", PCA(n_components=0.95, svd_solver="full")),
    ])
    Xp = prep.fit_transform(train.X)
    proj_cols = tuple(f"pc{i+1}" for i in range(Xp.shape[1]))
    return prep, FeatureMatrix(
        X=Xp, y=train.y, event_ids=train.event_ids,
        kickoffs=train.kickoffs, columns=proj_cols,
    )


def _apply_preprocessor(prep, fm: "FeatureMatrix"):
    """Apply an already-fitted preprocessor to a FeatureMatrix. Returns
    a new FeatureMatrix with the projected X and synthesized column
    names. Does NOT refit."""
    from app.ml.training import FeatureMatrix

    Xp = prep.transform(fm.X)
    proj_cols = tuple(f"pc{i+1}" for i in range(Xp.shape[1]))
    return FeatureMatrix(
        X=Xp, y=fm.y, event_ids=fm.event_ids, kickoffs=fm.kickoffs,
        columns=proj_cols,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/ml/trainable.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): _fit_and_apply_preprocessor + _apply_preprocessor helpers

Wraps StandardScaler+PCA(0.95) into a fitted sklearn Pipeline and
returns a projected FeatureMatrix with synthesized pcN column names.
Used by the upcoming fit_hgb_pca_at adapter."
```

---

## Task 4: `fit_hgb_at` adapter (no PCA)

Closes the Stage 1 "trivial follow-up" — plain HGB as a TRAINABLE entry.

**Files:**
- Modify: `app/ml/trainable.py`
- Test: `tests/ml/test_trainable_hgb.py`

- [ ] **Step 1: Write the failing test**

Tests need a seeded SQLite DB. Add a fixture and the first adapter test:

```python
# Add to tests/ml/test_trainable_hgb.py
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest


@pytest.fixture
def db_with_events(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    """Seed a temp SQLite with enough Phase 1 + feature rows to exercise
    the ≥100-event calibration path."""
    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    from app.config import get_settings
    get_settings.cache_clear()

    c = sqlite3.connect(p)
    c.row_factory = sqlite3.Row
    c.executescript("""
        CREATE TABLE bet_labels (
            event_id TEXT PRIMARY KEY,
            sport TEXT NOT NULL,
            country TEXT NOT NULL,
            competition TEXT NOT NULL,
            start_time_utc TEXT NOT NULL,
            outcome_1x2 TEXT NOT NULL
        );
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY, sport TEXT, country TEXT,
            competition TEXT, start_time_utc TEXT
        );
        CREATE TABLE closing_odds (
            event_id TEXT, market TEXT, selection TEXT,
            devigged_prob REAL, price REAL,
            PRIMARY KEY(event_id, market, selection)
        );
        CREATE TABLE team_elo_history (
            event_id TEXT, team TEXT, side TEXT,
            elo_pre REAL, elo_post REAL,
            PRIMARY KEY(event_id, team)
        );
    """)
    # Seed 150 events, all in scope for FOOTBALL_1X2_FT, kicking off
    # before "2024-08-01" so the adapter has ≥100 pre-cutoff events.
    import random
    random.seed(0)
    outcomes = ("home", "draw", "away")
    for i in range(150):
        eid = f"E{i:04d}"
        ts = f"2024-{((i % 6) + 1):02d}-{((i % 28) + 1):02d}T15:00:00Z"
        outcome = outcomes[i % 3]
        c.execute(
            "INSERT INTO bet_labels VALUES (?,?,?,?,?,?)",
            (eid, "football", "ENGLAND", "Premier League", ts, outcome),
        )
        c.execute(
            "INSERT INTO match_event_summaries VALUES (?,?,?,?,?)",
            (eid, "football", "ENGLAND", "Premier League", ts),
        )
        for sel, p in zip(outcomes, (0.45, 0.27, 0.28)):
            c.execute(
                "INSERT INTO closing_odds VALUES (?,?,?,?,?)",
                (eid, "1x2_ft", sel, p, 1.0 / p),
            )
        for team, side in (("H", "home"), ("A", "away")):
            c.execute(
                "INSERT INTO team_elo_history VALUES (?,?,?,?,?)",
                (eid, team, side, 1500.0 + random.uniform(-50, 50), 1500.0),
            )
    c.commit()
    c.close()
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
```

Note on the `__closure__` introspection: `make_trained_model_fn` returns a closure that captures the `trained` model. We pull it back out for the test. This is brittle but fine for a single test asserting a structural invariant.

- [ ] **Step 2: Run tests to verify they fail**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py::test_fit_hgb_at_returns_calibrated_model_fn -v
```

Expected: FAIL with `ImportError: cannot import name 'fit_hgb_at' from 'app.ml.trainable'`.

- [ ] **Step 3: Add the adapter**

In `app/ml/trainable.py`, append before the `TRAINABLE` registry:

```python
def fit_hgb_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train a fresh HistGradientBoostingClassifier on events strictly
    before ``train_until``, scoped to ``spec.scope``. Uses
    ``HGB_FEATURE_COLUMNS`` (BASE 9 + market 3 = 12 columns). Returns a
    calibrated ModelFn when ≥100 pre-cutoff events exist; otherwise
    falls through uncalibrated."""
    from app.ml.training import (
        HGB_FEATURE_COLUMNS,
        build_feature_matrix,
        chronological_split,
        isotonic_calibrate,
        train_hgb,
    )

    matrix = build_feature_matrix(
        sport=spec.sport, scope=spec.scope, columns=HGB_FEATURE_COLUMNS,
    )
    pre = [
        (ev, ts) for ev, ts in zip(matrix.event_ids, matrix.kickoffs)
        if ts < train_until
    ]
    if len(pre) < 100:
        split = chronological_split(
            matrix, train_until=train_until, calib_until=train_until,
        )
        raw = train_hgb(split.train)
        from app.ml.models import make_trained_model_fn
        return make_trained_model_fn(raw, calibrated=False, name_prefix="hgb")

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(
        matrix, train_until=calib_until, calib_until=train_until,
    )
    raw = train_hgb(split.train)
    cal = isotonic_calibrate(raw, split.calib)
    from app.ml.models import make_trained_model_fn
    return make_trained_model_fn(cal, calibrated=True, name_prefix="hgb")
```

The `from app.ml.models import make_trained_model_fn` is intentionally local (inside the function) to mirror the existing pattern in `fit_logistic_at` — it keeps top-of-module imports light and avoids any circular-import risk if `models.py` ever imports from `trainable.py`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add app/ml/trainable.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): fit_hgb_at adapter

Trains HistGradientBoostingClassifier on the 12-col HGB_FEATURE_COLUMNS
strictly before train_until, scoped to the MarketSpec. Closes Stage 1's
'trivial follow-up' for plain hgb as a backtestable trainable."
```

---

## Task 5: `fit_hgb_pca_at` adapter (with PCA)

The Stage 2 headline feature.

**Files:**
- Modify: `app/ml/trainable.py`
- Test: `tests/ml/test_trainable_hgb.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/ml/test_trainable_hgb.py`:

```python
def test_fit_hgb_pca_at_returns_calibrated_model_fn(db_with_events):
    """≥100 pre-cutoff events → calibrated path with PCA preprocessor."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import fit_hgb_pca_at

    fn = fit_hgb_pca_at("2024-08-01", FOOTBALL_1X2_FT)
    assert callable(fn)
    assert fn.__name__.endswith("_calibrated")


def test_fit_hgb_pca_at_attaches_preprocessor(db_with_events):
    """The PCA variant must store a fitted scaler+PCA pipeline on the
    TrainedHGB."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import fit_hgb_pca_at
    from app.ml.training import TrainedHGB

    fn = fit_hgb_pca_at("2024-08-01", FOOTBALL_1X2_FT)
    trained = next(
        cell.cell_contents for cell in fn.__closure__
        if isinstance(cell.cell_contents, TrainedHGB)
    )
    assert trained.preprocessor is not None
    pca = trained.preprocessor.named_steps["pca"]
    assert pca.n_components_ <= 12
    assert pca.n_components_ >= 1


def test_fit_hgb_pca_at_predict_proba_calibrated_sums_to_one(db_with_events):
    """End-to-end: raw 12-col input → scaler → PCA → HGB → isotonic →
    normalized 3-class output."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import fit_hgb_pca_at

    fn = fit_hgb_pca_at("2024-08-01", FOOTBALL_1X2_FT)
    # Build a synthetic feature dict + market context the closure can
    # consume. make_trained_model_fn reads feature_columns from the
    # captured trained model — for hgb_pca that's HGB_FEATURE_COLUMNS.
    features = {
        "home_elo": 1500.0, "away_elo": 1500.0, "elo_diff": 0.0,
        "home_form_ppg": 1.4, "away_form_ppg": 1.4,
        "home_form_matches": 5, "away_form_matches": 5,
        "home_days_rest": 7, "away_days_rest": 7,
    }
    market = {
        "devigged_prob_home": 0.45,
        "devigged_prob_draw": 0.27,
        "devigged_prob_away": 0.28,
    }
    out = fn(features, market)
    assert set(out) == {"home", "draw", "away"}
    assert pytest.approx(sum(out.values()), abs=1e-3) == 1.0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py::test_fit_hgb_pca_at_returns_calibrated_model_fn -v
```

Expected: FAIL with `ImportError: cannot import name 'fit_hgb_pca_at'`.

- [ ] **Step 3: Add the adapter**

In `app/ml/trainable.py`, append before the `TRAINABLE` registry (after `fit_hgb_at`):

```python
def fit_hgb_pca_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Same chronological discipline as fit_hgb_at, with a frozen
    StandardScaler+PCA(0.95) preprocessor fitted on the train block.
    The preprocessor is attached to the returned TrainedHGB so calls
    to predict_proba(raw_12_col_X) project before the classifier runs."""
    from app.ml.training import (
        HGB_FEATURE_COLUMNS,
        build_feature_matrix,
        chronological_split,
        isotonic_calibrate,
        train_hgb,
    )

    matrix = build_feature_matrix(
        sport=spec.sport, scope=spec.scope, columns=HGB_FEATURE_COLUMNS,
    )
    pre = [
        (ev, ts) for ev, ts in zip(matrix.event_ids, matrix.kickoffs)
        if ts < train_until
    ]

    if len(pre) < 100:
        split = chronological_split(
            matrix, train_until=train_until, calib_until=train_until,
        )
        prep, transformed_train = _fit_and_apply_preprocessor(split.train)
        raw = train_hgb(transformed_train)
        raw.preprocessor = prep
        from app.ml.models import make_trained_model_fn
        return make_trained_model_fn(raw, calibrated=False, name_prefix="hgb_pca")

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(
        matrix, train_until=calib_until, calib_until=train_until,
    )
    prep, transformed_train = _fit_and_apply_preprocessor(split.train)
    transformed_calib = _apply_preprocessor(prep, split.calib)
    raw = train_hgb(transformed_train)
    # Calibrate against the already-projected calib slice. raw.preprocessor
    # is still None at this point — isotonic_calibrate's predict_proba call
    # must NOT re-transform an already-transformed matrix. Attach prep AFTER
    # calibration completes. (Task 2's isotonic_calibrate change copies
    # preprocessor across, but raw still has None here — by design.)
    cal = isotonic_calibrate(raw, transformed_calib)
    cal.preprocessor = prep
    from app.ml.models import make_trained_model_fn
    return make_trained_model_fn(cal, calibrated=True, name_prefix="hgb_pca")
```

The comment block in the code captures the subtlety. The "raw.preprocessor is still None" is the load-bearing invariant.

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/ml/trainable.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): fit_hgb_pca_at adapter

StandardScaler+PCA(0.95) fitted on the train block, frozen, attached to
the returned TrainedHGB after calibration. predict_proba runs raw 12-col
input through scaler → PCA → HGB → isotonic transparently."
```

---

## Task 6: Register `hgb` and `hgb_pca` in TRAINABLE

The visible Stage 2 output: two new dropdown entries.

**Files:**
- Modify: `app/ml/trainable.py`
- Test: `tests/ml/test_trainable_hgb.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/ml/test_trainable_hgb.py`:

```python
def test_trainable_registry_includes_hgb_variants():
    """Both hgb and hgb_pca must be in the TRAINABLE dict."""
    from app.ml.trainable import TRAINABLE

    assert "hgb" in TRAINABLE
    assert "hgb_pca" in TRAINABLE


def test_resolve_model_routes_hgb_variants(db_with_events):
    """resolve_model_for_backtest dispatches both new names."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import resolve_model_for_backtest

    fn1 = resolve_model_for_backtest("hgb", "2024-08-01", FOOTBALL_1X2_FT)
    fn2 = resolve_model_for_backtest("hgb_pca", "2024-08-01", FOOTBALL_1X2_FT)
    assert callable(fn1)
    assert callable(fn2)


def test_resolve_model_unknown_name_raises(db_with_events):
    """Unknown model name still raises KeyError (existing behavior)."""
    from app.ml.market_spec import FOOTBALL_1X2_FT
    from app.ml.trainable import resolve_model_for_backtest

    with pytest.raises(KeyError):
        resolve_model_for_backtest("not_a_model", "2024-08-01", FOOTBALL_1X2_FT)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py::test_trainable_registry_includes_hgb_variants -v
```

Expected: FAIL with `assert 'hgb' in {'logistic': ..., 'dixon_coles': ...}`.

- [ ] **Step 3: Update the TRAINABLE registry**

In `app/ml/trainable.py`, find the `TRAINABLE` dict (currently the last meaningful block in the file) and extend it:

```python
TRAINABLE: Dict[str, Callable[[str, MarketSpec], ModelFn]] = {
    "logistic": fit_logistic_at,
    "dixon_coles": fit_dixon_coles_at,
    "hgb": fit_hgb_at,
    "hgb_pca": fit_hgb_pca_at,
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/test_trainable_hgb.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Confirm the wider trainable + endpoint tests still pass**

```bash
PYTHONPATH=. python3 -m pytest tests/ml/ tests/api/test_picks_stats_source.py tests/api/test_picks_facets_route.py -v
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/ml/trainable.py tests/ml/test_trainable_hgb.py
git commit -m "feat(ml): register hgb and hgb_pca in TRAINABLE

Both entries surface in /backtest/models as kind=trainable and run
through the existing backtest worker (Stage 1 plumbing). No frontend or
schema changes."
```

---

## Task 7: End-to-end smoke against the real DB

Confirms the worker can actually run an `hgb` and an `hgb_pca` backtest against `data/flashscore_snapshots.sqlite3`. This is a manual step — it produces real rows in `backtest_runs` and `backtest_bets`.

**Files:**
- None (read-only verification + DB writes via the API).

**Prerequisite:** the backend must be running from this worktree, not from master. If you're not sure, kill the running uvicorn (`lsof -ti:8000 | xargs kill`) and restart it:

```bash
cd /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/.claude/worktrees/epic-saha-1c8754
APP_STORAGE_DB_PATH=$PWD/../../../data/flashscore_snapshots.sqlite3 \
  python3 -m uvicorn src:app --host 127.0.0.1 --port 8000
```

- [ ] **Step 1: Confirm /backtest/models surfaces the new entries**

```bash
curl -s http://localhost:8000/backtest/models | python3 -m json.tool
```

Expected: an `items` array including both `{"name": "hgb", "kind": "trainable"}` and `{"name": "hgb_pca", "kind": "trainable"}`. The existing analytic and Stage 1 trainable entries must still be present.

- [ ] **Step 2: Queue an `hgb` backtest run**

```bash
curl -s -X POST http://localhost:8000/backtest/runs \
  -H "content-type: application/json" \
  -d '{
    "label": "hgb_smoke",
    "model": "hgb",
    "train_until": "2024-08-01T00:00:00Z",
    "test_until": "2024-12-01T00:00:00Z",
    "min_edge": 0.02,
    "kelly_fraction": 0.25,
    "force_bets": 0,
    "scope": [],
    "market_spec": "football_1x2_ft"
  }'
```

Expected: `{"id": "<hex>"}`. Save the id.

- [ ] **Step 3: Poll the run status**

```bash
curl -s http://localhost:8000/backtest/runs/<id> | python3 -m json.tool
```

Run repeatedly. Expected progression: `status: queued` → `status: running, stage: training` → `status: running, stage: backtesting` → `status: completed, stage: null`.

If the run takes more than ~5 minutes, something is wrong — the seeded data shouldn't be large enough for that. Check the uvicorn logs for the failing path.

- [ ] **Step 4: Confirm bets landed**

```bash
sqlite3 data/flashscore_snapshots.sqlite3 \
  "SELECT COUNT(*) FROM backtest_bets WHERE run_id='<id>'"
```

Expected: a positive integer (probably hundreds to thousands depending on `min_edge`).

- [ ] **Step 5: Queue the `hgb_pca` counterpart**

Same as Step 2 with `"model": "hgb_pca"`. Then repeat steps 3 and 4.

- [ ] **Step 6: Compare in the UI**

Open `http://localhost:3100/en/picks/models` (the worktree's frontend on port 3100; the master frontend on :3000 doesn't have the multi-select compare). Multi-select the two new completed runs alongside the existing `logistic` and `dixon_coles` runs at the same `train_until`. Confirm the leaderboard shows 4 distinct rows, P&L · time chart has 4 series, and ROI × Market / ROI × Competition heatmaps render 4 rows.

- [ ] **Step 7: Document the readout**

This step is the actual value of Stage 2 — it answers the empirical question. Compose a one-paragraph summary of the comparison:

- Which of the 4 models has the best ROI on the same test window?
- Did `hgb` beat `logistic`? If so, by how much? That's the "does adding market features help" answer.
- Did `hgb_pca` beat `hgb`? That's the "does PCA help" answer.
- Were any of them positive-ROI at all, or is the conclusion "none of these beat the closing line"?

Paste the summary into `docs/superpowers/specs/2026-05-15-stage2-hgb-pca-design.md` as a new `## Empirical readout` section, then:

```bash
git add docs/superpowers/specs/2026-05-15-stage2-hgb-pca-design.md
git commit -m "docs(spec): Stage 2 empirical readout"
```

---

## Self-review

**Spec coverage:**

- §1 `TrainedHGB.preprocessor` field → Task 1 ✓
- §2 `isotonic_calibrate` extension → Task 2 ✓
- §3 `fit_hgb_at` → Task 4 ✓
- §4 `fit_hgb_pca_at` → Task 5 ✓
- §5 preprocessor helpers → Task 3 ✓
- §6 TRAINABLE registry update → Task 6 ✓
- "Data flow" (worker invocation, predict_proba routing through preprocessor) → exercised by Task 7's end-to-end smoke ✓
- Testing section (shape, calibration, preprocessor presence/absence, registry wiring, no-leakage smoke, calibration plumbing across PCA) → Tasks 1, 2, 3, 4, 5, 6 collectively cover all ✓
- Migration: "none" → no task needed ✓
- Out-of-scope explicit items: not in the plan, by design ✓

**Placeholder scan:** none of the patterns trigger. All code blocks are concrete; the only descriptive step is Task 7 Step 7 ("compose a paragraph"), which is intentional — the readout content depends on the empirical run.

**Type consistency:** `TrainedHGB.preprocessor: Optional[object]` is the same field name across §1 and Tasks 1, 2, 5. `_fit_and_apply_preprocessor` and `_apply_preprocessor` keep the same names across §5, Task 3, and Task 5. `make_trained_model_fn` is referenced in Tasks 4 and 5 with consistent kwargs (`calibrated`, `name_prefix`). `train_hgb(split.train)` signature matches `app/ml/training.py:train_hgb`.

One detail worth flagging: Task 5's adapter sets `cal.preprocessor = prep` explicitly even though Task 2 makes `isotonic_calibrate` copy `preprocessor` automatically. The explicit assignment is defensive — `isotonic_calibrate` is called with `raw.preprocessor = None` (by design, to avoid double-transform), so its copy is `None`. The explicit `cal.preprocessor = prep` is the only way `prep` ends up on the calibrated object. The comment in the code makes this invariant visible.
