# Stage 2 — HGB and HGB+PCA trainable models

**Status:** Draft
**Date:** 2026-05-15
**Branch:** `claude/epic-saha-1c8754`
**Stage:** 2 of 3 in the "general pipeline" effort. Stage 1 (trainable backtests + facets endpoint + ExploreTab fixes) is merged to master. Stage 3 (second market / second sport) is a separate brainstorm.

## Problem

Stage 1 made `logistic` and `dixon_coles` runnable as walk-forward backtests through the `TRAINABLE` registry in `app/ml/trainable.py`. The `hgb` (HistGradientBoostingClassifier) trainer exists at `scripts/train_hgb.py` and is wired into the live `/predict` path, but it cannot be run as a backtest — Stage 1's "trivial follow-up." The dropdown also lacks a non-linear model that can use the market-prob features (`market_prob_home/draw/away`) the logistic-on-BASE deliberately doesn't see.

Beyond closing the `hgb` gap, the question Stage 2 answers empirically: **does a fixed dimensionality reduction (PCA) help a boosted-tree model on this 12-feature space, or hurt?** That answer informs whether PCA generalizes into Stage 3 as a reusable transform.

## Goals

- `hgb` and `hgb_pca` appear in the `/backtest/models` dropdown as `trainable` and produce walk-forward backtests with the same no-leakage discipline as the Stage 1 logistic/dixon-coles entries.
- Both adapters use `HGB_FEATURE_COLUMNS` (BASE 9 + MARKET 3), so the dropdown comparison answers two questions cleanly: (a) does adding market features help vs. logistic-on-BASE, (b) does PCA on top of that help.
- Isotonic-per-class calibration mirrors the logistic adapter exactly — same ≥100 pre-cutoff event threshold, same chronological 75/25 split inside the pre-cutoff window.
- `TrainedHGB.save/load` and the live `/predict` path's existing on-disk artifacts continue working unchanged.

## Non-goals

- XGBoost or LightGBM as a new dependency. HGB answers the "boosted trees + PCA" question on a 12-feature dataset at least as well, with zero new deps.
- Hyperparameter search over HGB knobs (`max_depth`, `learning_rate`, `max_iter`). Use the defaults `train_hgb` already exposes.
- PCA as a general feature transform reusable across multiple models. Kept inside the two new adapters; if PCA proves consistently useful, Stage 3 or a separate refactor can generalize it.
- Tuning `n_components`. Variance-threshold rule (`n_components=0.95`) is the chosen default.
- MLflow logging of PCA-specific artifacts (explained-variance plot, scree, etc.). The Local MLflow Phase A workstream picks this up separately.
- Frontend changes. Stage 1's `/backtest/models` endpoint unions analytic + TRAINABLE keys — the two new entries appear in the dropdown automatically.
- Any change to `scripts/train_hgb.py` or to the on-disk-artifact `/predict` path. `hgb_pca` is a backtest-only entry in Stage 2; promoting it to live serving requires `scripts/train_hgb.py` to write the preprocessor into its on-disk artifact, which is deferred until the MLflow Phase B (Registry-as-serving-gate) workstream.

## Architecture

### 1. `TrainedHGB.preprocessor` field

Additive change to the dataclass in `app/ml/training.py`:

```python
@dataclass
class TrainedHGB:
    model: object                                              # unchanged
    calibrators: Optional[Tuple[object, object, object]] = None  # unchanged
    feature_columns: Tuple[str, ...] = HGB_FEATURE_COLUMNS      # unchanged
    preprocessor: Optional[object] = None                       # NEW

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.preprocessor is not None:
            X = self.preprocessor.transform(X)
        return self.model.predict_proba(X)

    # predict_proba_calibrated unchanged — it routes through predict_proba.
```

`feature_columns` stays at `HGB_FEATURE_COLUMNS` even for the PCA variant. `make_trained_model_fn` reads raw columns from the feature dict + market context as today; the PCA projection happens inside `predict_proba`, invisible to callers (Q10 decision).

`preprocessor=None` for any existing pickled artifact — full back-compat for `scripts/train_hgb.py` output and the live `/predict` path.

`pickle.dump(self)` in `TrainedHGB.save` automatically serializes the new field — no `save/load` changes needed.

### 2. `isotonic_calibrate` one-line extension

In `app/ml/training.py`, the `isinstance(model, TrainedHGB)` branch of `isotonic_calibrate` currently constructs a new `TrainedHGB` with `model`, `calibrators`, `feature_columns`. Add one field copy:

```python
return TrainedHGB(
    model=model.model,
    calibrators=tuple(calibrators),
    feature_columns=model.feature_columns,
    preprocessor=getattr(model, "preprocessor", None),  # NEW
)
```

This preserves the preprocessor across calibration so the new `TrainedHGB` calibrates correctly when its `predict_proba_calibrated` later runs raw 12-col features through the saved scaler+PCA pipeline.

### 3. `fit_hgb_at` adapter

New function in `app/ml/trainable.py`, mirroring `fit_logistic_at` structurally:

```python
def fit_hgb_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train fresh HGB on events strictly before train_until, scoped to
    spec.scope. Uses HGB_FEATURE_COLUMNS (BASE 9 + MARKET 3)."""
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
    pre = [(ev, ts) for ev, ts in zip(matrix.event_ids, matrix.kickoffs)
           if ts < train_until]

    if len(pre) < 100:
        split = chronological_split(matrix, train_until=train_until,
                                    calib_until=train_until)
        raw = train_hgb(split.train)
        return make_trained_model_fn(raw, calibrated=False, name_prefix="hgb")

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(matrix, train_until=calib_until,
                                calib_until=train_until)
    raw = train_hgb(split.train)
    cal = isotonic_calibrate(raw, split.calib)
    return make_trained_model_fn(cal, calibrated=True, name_prefix="hgb")
```

`train_hgb`'s existing defaults apply (`max_iter=300, learning_rate=0.05, max_depth=4, validation_fraction=0.1`). The adapter passes no kwargs.

### 4. `fit_hgb_pca_at` adapter

Same chronological discipline, with a `StandardScaler → PCA(n_components=0.95, svd_solver="full")` preprocessor fitted on the train block only, then frozen.

```python
def fit_hgb_pca_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Same as fit_hgb_at, with PCA on top of standardization. The
    projection is fit on the train block and frozen for calibration and
    backtest."""
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
    pre = [(ev, ts) for ev, ts in zip(matrix.event_ids, matrix.kickoffs)
           if ts < train_until]

    if len(pre) < 100:
        split = chronological_split(matrix, train_until=train_until,
                                    calib_until=train_until)
        prep, transformed_train = _fit_and_apply_preprocessor(split.train)
        raw = train_hgb(transformed_train)
        raw.preprocessor = prep
        return make_trained_model_fn(raw, calibrated=False, name_prefix="hgb_pca")

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(matrix, train_until=calib_until,
                                calib_until=train_until)
    prep, transformed_train = _fit_and_apply_preprocessor(split.train)
    transformed_calib = _apply_preprocessor(prep, split.calib)
    raw = train_hgb(transformed_train)
    raw.preprocessor = prep
    # isotonic_calibrate calls raw.predict_proba(calib.X). With prep
    # attached, that would re-transform an already-transformed matrix.
    # Detach for the calibration call, then reattach to the new model.
    raw.preprocessor = None
    cal = isotonic_calibrate(raw, transformed_calib)
    cal.preprocessor = prep
    return make_trained_model_fn(cal, calibrated=True, name_prefix="hgb_pca")
```

**Why the detach/reattach:** `isotonic_calibrate(raw, transformed_calib)` calls `raw.predict_proba(transformed_calib.X)`. Once `raw.preprocessor` is set, `predict_proba` transforms its input — but `transformed_calib.X` was already transformed by `_apply_preprocessor`. Detaching `prep` before the call avoids double-transform; reattaching it onto the returned `cal` preserves the prep for serving.

The one-line `isotonic_calibrate` extension in §2 means the prep would copy automatically — but only after we've detached it on `raw`. The explicit attach on `cal` is defensive and easy to read.

### 5. Preprocessor helpers

Two small helpers in `app/ml/trainable.py`:

```python
def _fit_and_apply_preprocessor(train):
    """Fit StandardScaler+PCA on train.X. Returns (fitted_pipeline, projected FeatureMatrix)."""
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


def _apply_preprocessor(prep, fm):
    """Apply a fitted preprocessor to a FeatureMatrix, returning a new one."""
    from app.ml.training import FeatureMatrix
    Xp = prep.transform(fm.X)
    proj_cols = tuple(f"pc{i+1}" for i in range(Xp.shape[1]))
    return FeatureMatrix(
        X=Xp, y=fm.y, event_ids=fm.event_ids, kickoffs=fm.kickoffs,
        columns=proj_cols,
    )
```

Projected column names (`pc1`, `pc2`, …) are synthesized so downstream code that prints `FeatureMatrix.columns` has something useful. They never leave the projected matrix — `TrainedHGB.feature_columns` stays at the raw 12 names.

### 6. TRAINABLE registry update

```python
TRAINABLE: Dict[str, Callable[[str, MarketSpec], ModelFn]] = {
    "logistic": fit_logistic_at,
    "dixon_coles": fit_dixon_coles_at,
    "hgb": fit_hgb_at,
    "hgb_pca": fit_hgb_pca_at,
}
```

`resolve_model_for_backtest(name, train_until, spec)` automatically routes the two new names. `/backtest/models` unions analytic + TRAINABLE keys and stamps `kind="trainable"` on both new entries.

## Data flow

```
User picks "hgb_pca" in BacktestAdvancedDialog
  → POST /backtest/runs {model:"hgb_pca", train_until:"2024-08-01", ...}
  → BacktestManager.create_run inserts queued row
  → worker dequeues, reads row, resolves spec
  → stage='training' (Stage 1 plumbing)
  → fn = resolve_model_for_backtest("hgb_pca", "2024-08-01", spec)
      → fit_hgb_pca_at("2024-08-01", spec)
        → build_feature_matrix(columns=HGB_FEATURE_COLUMNS)  // 12 cols
        → split train/calib chronologically
        → _fit_and_apply_preprocessor(split.train)
          → Pipeline([StandardScaler, PCA(0.95)]).fit_transform → ~6–9 components
        → transformed_calib = _apply_preprocessor(prep, split.calib)
        → raw = train_hgb(transformed_train)  // HGB on projected space
        → detach prep, calibrate, reattach
        → return ModelFn wrapping a TrainedHGB w/ prep + calibrators
  → stage='backtesting'
  → run_backtest(model=fn, market_spec=spec, train_until, ...)
      // run_backtest invokes fn(features, market) per event
      // make_trained_model_fn extracts the 12 raw cols and calls
      // trained.predict_proba_calibrated(X) which internally:
      //   1. preprocessor.transform(X)         # 12 → k components
      //   2. self.model.predict_proba          # HGB on projected
      //   3. per-class isotonic calibration    # k unchanged
  → insert_bets + finalize_run
  → BacktestRunsPanel shows the new run; KPI strip + comparisons available
```

## Testing

New file `tests/ml/test_trainable_hgb.py`. Fixture seeds a temp SQLite with ≥100 `bet_labels` rows and matching `match_event_summaries` so calibration is exercised; smaller secondary fixture (~30 rows) for the <100 branch.

- **`fit_hgb_at` shape:** with ≥100 pre-cutoff events, returned `ModelFn(features, market)` returns `{"home", "draw", "away"}` summing to ≈1.0 (±0.001). `__name__` ends in `_calibrated`.
- **`fit_hgb_at` small data:** with <100 events, `__name__` ends in `_uncalibrated`; probabilities still sum to ≈1.0.
- **`fit_hgb_pca_at` shape:** same probability sum + name suffix assertions as `fit_hgb_at`.
- **`fit_hgb_pca_at` preprocessor present:** the underlying `TrainedHGB` (extracted from the closure or via a test-only inspection helper) has `preprocessor is not None`, and `preprocessor.named_steps["pca"].n_components_ <= 12`.
- **`fit_hgb_at` preprocessor absent:** plain `hgb` returns a `TrainedHGB` with `preprocessor is None`.
- **TRAINABLE wiring:** `resolve_model_for_backtest("hgb", "2024-08-01", spec)` and `("hgb_pca", ...)` both return callables; `("nope", ...)` raises `KeyError`.
- **No-leakage smoke:** the matrix passed to `train_hgb` inside `fit_hgb_at` has only `kickoff < train_until` rows. Verifiable by counting rows in the fixture vs. what `chronological_split` produced.
- **Calibration plumbing across PCA:** call `cal.predict_proba_calibrated(X_raw_12_col)` directly and confirm output sums to ≈1.0 — this exercises scaler → PCA → HGB → isotonic in one shot.

## Migration

None. Stage 1 schema (`stage`, `market_spec` columns on `backtest_runs`) is sufficient. `TrainedHGB.preprocessor` is a Python-side dataclass field; SQLite is untouched. Existing pickled `TrainedHGB` artifacts under `$APP_ML_MODELS_DIR` continue to load with `preprocessor=None` (dataclass default applies for older pickles missing the field, courtesy of `field(default=None)`).

## Effort estimate

~1 day:

- `TrainedHGB.preprocessor` field + `isotonic_calibrate` one-line extension: ~0.1 day.
- `fit_hgb_at` + `fit_hgb_pca_at` adapters + two helpers: ~0.3 day.
- TRAINABLE registry update: 1 line.
- Tests: ~0.3 day.
- Smoke run against the real DB at multiple `train_until` values, compare to existing logistic/market_implied runs: ~0.3 day.

## Out of scope (explicit, again)

- XGBoost / LightGBM.
- HGB hyperparameter tuning.
- PCA as a general transform across models.
- Tuning `n_components` away from 0.95.
- MLflow PCA-artifact logging (Phase A separate workstream).
- Frontend changes — `/backtest/models` already surfaces TRAINABLE entries.
- Touching `scripts/train_hgb.py` or the live `/predict` artifact path.
- Stage 3 (second market, second sport, generalized label/feature/closing-price extraction).
