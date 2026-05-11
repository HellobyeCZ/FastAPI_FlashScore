"""Training utilities for Phase 3 models.

Provides:
  - :func:`build_feature_matrix` — calls ``get_features`` for every event
    in scope and returns aligned ``(X, y, event_ids)`` arrays.
  - :func:`train_logistic` — fits a scaled multinomial logistic on the
    train block.
  - :func:`isotonic_calibrate` — fits per-class isotonic on the
    calibration block's predictions; returns a callable that calibrates
    raw model probs into a re-normalised dict.
  - :func:`log_to_mlflow` — single-call helper that logs params,
    metrics, artifacts, and SVGs for a training run.

The trainers are stateless: caller supplies the chronological cutoffs.
This module deliberately does *not* know about backtest semantics —
it produces models, and ``scripts.train_logistic`` plugs them into the
backtest harness via ``app.ml.models.register``.
"""
from __future__ import annotations

import hashlib
import json
import pickle
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from app.ml import db as ml_db
from app.ml.features import CLOSING_LINE_BUFFER, _parse_iso, get_features
from app.ml.labels import FOOTBALL_PHASE1_SCOPE


SELECTIONS = ("home", "draw", "away")

# Feature columns used by the logistic model. Order is load-bearing —
# pickled scalers/models will only round-trip if this stays stable.
LOGISTIC_FEATURE_COLUMNS: Tuple[str, ...] = (
    "home_elo",
    "away_elo",
    "elo_diff",
    "home_form_ppg",
    "away_form_ppg",
    "home_form_matches",
    "away_form_matches",
    "home_days_rest",
    "away_days_rest",
)


@dataclass(frozen=True)
class FeatureMatrix:
    X: np.ndarray         # shape (n, len(LOGISTIC_FEATURE_COLUMNS))
    y: np.ndarray         # shape (n,) int labels 0=home, 1=draw, 2=away
    event_ids: List[str]
    kickoffs: List[str]   # ISO strings
    columns: Tuple[str, ...] = LOGISTIC_FEATURE_COLUMNS


@dataclass(frozen=True)
class TrainTestSplit:
    train: FeatureMatrix
    calib: FeatureMatrix
    test: FeatureMatrix


def feature_set_hash() -> str:
    """Stable hash of the feature column order. Logged with every run so
    a model's MLflow record pins exactly which inputs it expects."""
    payload = "|".join(LOGISTIC_FEATURE_COLUMNS)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Feature matrix
# ---------------------------------------------------------------------------

_OUTCOME_TO_LABEL = {"home": 0, "draw": 1, "away": 2}


def _row_from_features(features: Mapping[str, object]) -> Optional[List[float]]:
    """Extract a numeric row from a feature dict. Returns None if any
    required field is missing."""
    row: List[float] = []
    for col in LOGISTIC_FEATURE_COLUMNS:
        v = features.get(col)
        if v is None:
            return None
        try:
            row.append(float(v))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
    return row


def build_feature_matrix(
    *,
    sport: str = "football",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    min_kickoff: Optional[str] = None,
    max_kickoff: Optional[str] = None,
) -> FeatureMatrix:
    """Build an aligned ``(X, y, event_ids)`` matrix for every settled
    event in scope. ``as_of_ts = kickoff − CLOSING_LINE_BUFFER`` so
    market features are available at the closing-line moment, but the
    logistic doesn't consume them in Phase 3a."""
    placeholders = ",".join("(?, ?)" for _ in scope) if scope else ""
    params: List[str] = [sport]
    if scope:
        for c, comp in scope:
            params.extend([c, comp])
    if min_kickoff:
        params.append(min_kickoff)
    if max_kickoff:
        params.append(max_kickoff)

    where_parts = ["sport = ?"]
    if scope:
        where_parts.append(f"(country, competition) IN (VALUES {placeholders})")
    if min_kickoff:
        where_parts.append("start_time_utc >= ?")
    if max_kickoff:
        where_parts.append("start_time_utc < ?")
    where_clause = " AND ".join(where_parts)

    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT event_id, start_time_utc, outcome_1x2
            FROM bet_labels
            WHERE {where_clause}
              AND outcome_1x2 IN ('home', 'draw', 'away')
            ORDER BY start_time_utc ASC, event_id ASC
            """,
            params,
        ).fetchall()

    X_rows: List[List[float]] = []
    y_rows: List[int] = []
    event_ids: List[str] = []
    kickoffs: List[str] = []
    for row in rows:
        event_id = row["event_id"]
        kickoff_str = row["start_time_utc"]
        try:
            ko = _parse_iso(kickoff_str)
        except (ValueError, TypeError):
            continue
        as_of = (ko - CLOSING_LINE_BUFFER).isoformat().replace("+00:00", "Z")
        features = get_features(event_id, as_of)
        if features is None:
            continue
        feature_row = _row_from_features(features)
        if feature_row is None:
            continue
        X_rows.append(feature_row)
        y_rows.append(_OUTCOME_TO_LABEL[row["outcome_1x2"]])
        event_ids.append(event_id)
        kickoffs.append(kickoff_str)

    return FeatureMatrix(
        X=np.asarray(X_rows, dtype=float),
        y=np.asarray(y_rows, dtype=int),
        event_ids=event_ids,
        kickoffs=kickoffs,
    )


def chronological_split(
    matrix: FeatureMatrix,
    *,
    train_until: str,
    calib_until: str,
) -> TrainTestSplit:
    """Split a feature matrix into chronological train / calib / test.

    Both cutoffs are **exclusive upper bounds**:
      - train: kickoff <  train_until
      - calib: train_until <= kickoff <  calib_until
      - test:  kickoff >= calib_until
    """
    kickoffs = np.asarray(matrix.kickoffs)
    train_mask = kickoffs < train_until
    calib_mask = (kickoffs >= train_until) & (kickoffs < calib_until)
    test_mask = kickoffs >= calib_until

    def _slice(mask) -> FeatureMatrix:
        idx = np.where(mask)[0]
        return FeatureMatrix(
            X=matrix.X[idx],
            y=matrix.y[idx],
            event_ids=[matrix.event_ids[i] for i in idx],
            kickoffs=[matrix.kickoffs[i] for i in idx],
            columns=matrix.columns,
        )

    return TrainTestSplit(
        train=_slice(train_mask),
        calib=_slice(calib_mask),
        test=_slice(test_mask),
    )


# ---------------------------------------------------------------------------
# Logistic trainer
# ---------------------------------------------------------------------------

@dataclass
class TrainedLogistic:
    pipeline: object  # sklearn Pipeline with StandardScaler + LogisticRegression
    calibrators: Optional[Tuple[object, object, object]]  # per-class IsotonicRegression, or None
    feature_columns: Tuple[str, ...] = LOGISTIC_FEATURE_COLUMNS

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.pipeline.predict_proba(X)

    def predict_proba_calibrated(self, X: np.ndarray) -> np.ndarray:
        raw = self.predict_proba(X)
        if self.calibrators is None:
            return raw
        calibrated = np.zeros_like(raw)
        for k, cal in enumerate(self.calibrators):
            calibrated[:, k] = cal.predict(raw[:, k])
        # Re-normalise per row.
        row_sums = calibrated.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0
        return calibrated / row_sums

    def save(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path: str) -> "TrainedLogistic":
        with open(path, "rb") as f:
            return pickle.load(f)


def train_logistic(
    train: FeatureMatrix,
    *,
    C: float = 1.0,
    max_iter: int = 1000,
) -> TrainedLogistic:
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    # multi_class is deprecated in sklearn 1.5+; the default behaviour
    # for >=3 classes is multinomial, which is what we want.
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(C=C, max_iter=max_iter, solver="lbfgs")),
    ])
    pipeline.fit(train.X, train.y)
    return TrainedLogistic(pipeline=pipeline, calibrators=None)


def isotonic_calibrate(
    model: TrainedLogistic,
    calib: FeatureMatrix,
) -> TrainedLogistic:
    """Fit per-class isotonic on the calibration block. Returns a NEW
    :class:`TrainedLogistic` with calibrators attached; the input model
    is unchanged."""
    from sklearn.isotonic import IsotonicRegression

    raw = model.predict_proba(calib.X)
    calibrators = []
    for k in range(3):
        ir = IsotonicRegression(out_of_bounds="clip")
        # Binary y for this class: did this class occur?
        binary_y = (calib.y == k).astype(int)
        ir.fit(raw[:, k], binary_y)
        calibrators.append(ir)
    return TrainedLogistic(
        pipeline=model.pipeline,
        calibrators=tuple(calibrators),
        feature_columns=model.feature_columns,
    )


# ---------------------------------------------------------------------------
# MLflow logging
# ---------------------------------------------------------------------------

def log_run_to_mlflow(
    *,
    run_name: str,
    params: Dict[str, object],
    metrics_uncalibrated: Dict[str, float],
    metrics_calibrated: Dict[str, float],
    reliability_svg_uncalibrated: str,
    reliability_svg_calibrated: str,
    model_artifact_path: str,
    tracking_uri: Optional[str] = None,
) -> Optional[str]:
    """Log a single Phase 3 run to MLflow. Returns the run_id, or None
    if MLflow isn't available."""
    try:
        import mlflow
    except ImportError:
        return None

    if tracking_uri is None:
        tracking_uri = "file://" + str(Path("mlruns").absolute())
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment("phase3_models")

    with mlflow.start_run(run_name=run_name) as run:
        for k, v in params.items():
            mlflow.log_param(k, v)
        for k, v in metrics_uncalibrated.items():
            mlflow.log_metric(f"uncal_{k}", float(v))
        for k, v in metrics_calibrated.items():
            mlflow.log_metric(f"cal_{k}", float(v))

        artifact_dir = Path(mlflow.get_artifact_uri().replace("file://", ""))
        artifact_dir.mkdir(parents=True, exist_ok=True)
        uncal_path = artifact_dir / "reliability_uncalibrated.svg"
        cal_path = artifact_dir / "reliability_calibrated.svg"
        uncal_path.write_text(reliability_svg_uncalibrated)
        cal_path.write_text(reliability_svg_calibrated)
        mlflow.log_artifact(str(uncal_path))
        mlflow.log_artifact(str(cal_path))
        mlflow.log_artifact(model_artifact_path)

        return run.info.run_id
