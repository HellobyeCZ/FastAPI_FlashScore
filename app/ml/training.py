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

# Phase 3a logistic uses the base team-state features only — no
# market_prob_* — so we measure pure team-state predictive power.
# Order is load-bearing: pickled scalers/models depend on this.
BASE_FEATURE_COLUMNS: Tuple[str, ...] = (
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

# Phase 3b adds the closing-line devigged probabilities. The HGB model
# is trained on this 12-column set so it can find *residual* edges
# beyond what the market already prices in.
MARKET_FEATURE_COLUMNS: Tuple[str, ...] = (
    "market_prob_home",
    "market_prob_draw",
    "market_prob_away",
)

HGB_FEATURE_COLUMNS: Tuple[str, ...] = BASE_FEATURE_COLUMNS + MARKET_FEATURE_COLUMNS

# Back-compat alias: existing callers and tests use LOGISTIC_FEATURE_COLUMNS.
LOGISTIC_FEATURE_COLUMNS = BASE_FEATURE_COLUMNS


@dataclass(frozen=True)
class FeatureMatrix:
    X: np.ndarray         # shape (n, len(columns))
    y: np.ndarray         # shape (n,) int labels 0=home, 1=draw, 2=away
    event_ids: List[str]
    kickoffs: List[str]   # ISO strings
    columns: Tuple[str, ...] = BASE_FEATURE_COLUMNS


@dataclass(frozen=True)
class TrainTestSplit:
    train: FeatureMatrix
    calib: FeatureMatrix
    test: FeatureMatrix


def feature_set_hash(columns: Sequence[str] = BASE_FEATURE_COLUMNS) -> str:
    """Stable hash of a feature column order. Logged with every run so
    a model's MLflow record pins exactly which inputs it expects."""
    payload = "|".join(columns)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Feature matrix
# ---------------------------------------------------------------------------

_OUTCOME_TO_LABEL = {"home": 0, "draw": 1, "away": 2}


def _row_from_features(
    features: Mapping[str, object],
    columns: Sequence[str] = BASE_FEATURE_COLUMNS,
) -> Optional[List[float]]:
    """Extract a numeric row from a feature dict. Returns None if any
    required column is missing."""
    row: List[float] = []
    for col in columns:
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
    columns: Sequence[str] = BASE_FEATURE_COLUMNS,
) -> FeatureMatrix:
    """Build an aligned ``(X, y, event_ids)`` matrix for every settled
    event in scope. ``as_of_ts = kickoff − CLOSING_LINE_BUFFER`` so
    market features are available at the closing-line moment."""
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
        feature_row = _row_from_features(features, columns)
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
        columns=tuple(columns),
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
    feature_columns: Tuple[str, ...] = BASE_FEATURE_COLUMNS

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
    model: "TrainedLogistic | TrainedHGB",
    calib: FeatureMatrix,
) -> "TrainedLogistic | TrainedHGB":
    """Fit per-class isotonic on the calibration block. Returns a NEW
    trained-model with calibrators attached; the input is unchanged.
    Works for both TrainedLogistic and TrainedHGB."""
    from sklearn.isotonic import IsotonicRegression

    raw = model.predict_proba(calib.X)
    calibrators = []
    for k in range(3):
        ir = IsotonicRegression(out_of_bounds="clip")
        binary_y = (calib.y == k).astype(int)
        ir.fit(raw[:, k], binary_y)
        calibrators.append(ir)
    if isinstance(model, TrainedHGB):
        return TrainedHGB(
            model=model.model,
            calibrators=tuple(calibrators),
            feature_columns=model.feature_columns,
            preprocessor=getattr(model, "preprocessor", None),  # NEW
        )
    return TrainedLogistic(
        pipeline=model.pipeline,
        calibrators=tuple(calibrators),
        feature_columns=model.feature_columns,
    )


# ---------------------------------------------------------------------------
# Histogram-gradient-boosted classifier (Phase 3b)
# ---------------------------------------------------------------------------

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

    def save(self, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path: str) -> "TrainedHGB":
        with open(path, "rb") as f:
            return pickle.load(f)


def collect_events_for_dixon_coles(
    *,
    sport: str = "football",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    min_kickoff: Optional[str] = None,
    max_kickoff: Optional[str] = None,
) -> List[Dict[str, object]]:
    """Pull (event_id, teams, scores, xG, start_time) rows for every
    terminal football event in scope, sorted chronologically. xG is
    extracted from the stats payload's 'Expected goals (xG)' stat in
    period 'Match', returned as None when absent."""
    import json
    placeholders = ",".join("(?, ?)" for _ in scope) if scope else ""
    params: List[str] = [sport]
    where_parts = ["m.sport = ?", "s.is_terminal = 1"]
    if scope:
        where_parts.append(f"(m.country, m.competition) IN (VALUES {placeholders})")
        for c, comp in scope:
            params.extend([c, comp])
    if min_kickoff:
        where_parts.append("m.start_time_utc >= ?")
        params.append(min_kickoff)
    if max_kickoff:
        where_parts.append("m.start_time_utc < ?")
        params.append(max_kickoff)

    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT s.event_id, s.match_stats_payload_json,
                   m.start_time_utc
            FROM match_stats_snapshots s
            JOIN match_event_summaries m USING(event_id)
            JOIN bet_labels b USING(event_id)
            WHERE {' AND '.join(where_parts)}
            ORDER BY m.start_time_utc ASC, s.event_id ASC
            """,
            params,
        ).fetchall()

    out: List[Dict[str, object]] = []
    for row in rows:
        try:
            payload = json.loads(row["match_stats_payload_json"])
        except (TypeError, ValueError):
            continue
        event = payload.get("event") if isinstance(payload, dict) else None
        if not isinstance(event, dict):
            continue
        home = event.get("home_team")
        away = event.get("away_team")
        if not home or not away:
            continue
        home_score = away_score = None
        home_xg = away_xg = None
        for period in event.get("periods") or ():
            if (period.get("name") or "").strip().lower() != "match":
                continue
            for category in period.get("categories") or ():
                cat = (category.get("name") or "").strip().lower()
                for stat in category.get("stats") or ():
                    label = (stat.get("label") or "").lower()
                    if cat == "score" and "final score" in label:
                        try:
                            home_score = int(stat["home"])
                            away_score = int(stat["away"])
                        except (KeyError, TypeError, ValueError):
                            pass
                    elif "expected goals" in label and "xg" in label:
                        try:
                            home_xg = float(stat["home"])
                            away_xg = float(stat["away"])
                        except (KeyError, TypeError, ValueError):
                            pass
        if home_score is None or away_score is None:
            continue
        out.append({
            "event_id": row["event_id"],
            "start_time_utc": row["start_time_utc"],
            "home_team": home,
            "away_team": away,
            "home_score": home_score,
            "away_score": away_score,
            "home_xg": home_xg,
            "away_xg": away_xg,
        })
    return out


def train_hgb(
    train: FeatureMatrix,
    *,
    max_iter: int = 300,
    learning_rate: float = 0.05,
    max_depth: int = 4,
    l2_regularization: float = 0.0,
    validation_fraction: float = 0.1,
    random_state: int = 42,
) -> TrainedHGB:
    """Fit a histogram-based gradient boosting classifier.

    sklearn's HistGradientBoostingClassifier is the same algorithmic
    family as LightGBM/XGBoost. We use it instead of LightGBM here
    because LightGBM's installed wheel has a numpy 2 ABI mismatch in
    this environment (see Phase 2 dependency notes). HGB is already
    available via the existing scikit-learn dep, no new requirements.

    Defaults are conservative: ``max_depth=4`` and a low learning rate
    (0.05) over up to 300 iterations with early stopping on an internal
    10% validation cut from the train block. Early stopping is disabled
    automatically if the train block is too small (under ~30 rows) since
    the stratified validation split needs at least one row per class.
    """
    from sklearn.ensemble import HistGradientBoostingClassifier

    use_early_stopping = train.X.shape[0] >= 30
    model = HistGradientBoostingClassifier(
        max_iter=max_iter,
        learning_rate=learning_rate,
        max_depth=max_depth,
        l2_regularization=l2_regularization,
        early_stopping=use_early_stopping,
        validation_fraction=validation_fraction if use_early_stopping else None,
        random_state=random_state,
    )
    model.fit(train.X, train.y)
    return TrainedHGB(model=model, feature_columns=tuple(train.columns))


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
