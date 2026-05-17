"""Universal MLflow pyfunc wrapper for every model in the picks zoo.

One class handles sklearn-native models (logistic, hgb, hgb_pca via
TrainedLogistic / TrainedHGB), custom math (dixon_coles via the
DixonColesRates dataclass produced by app.ml.dixon_coles), and analytic
baselines (market_implied, vig_included — no trained object).

Input shape: pandas DataFrame whose columns are the raw feature columns
plus market_* columns for any model that consumes devigged market probs.
Output: pandas DataFrame with columns ['home', 'draw', 'away'].

Phase A: log_model with registered_model_name=None. Registry-aware
flavors land in Phase C.
"""
from __future__ import annotations

import pickle
import tempfile
from pathlib import Path
from typing import Any, Optional

import mlflow
import pandas as pd
from mlflow.pyfunc import PythonModel, PythonModelContext


class PicksModelWrapper(PythonModel):
    """Single pyfunc that dispatches based on a model_name meta file."""

    def load_context(self, context: PythonModelContext) -> None:
        model_path = context.artifacts["model"]
        meta_path = context.artifacts["meta"]
        with open(model_path, "rb") as f:
            self._trained = pickle.load(f)
        self._model_name = Path(meta_path).read_text().strip()

    def predict(self, context, model_input: pd.DataFrame, params=None) -> pd.DataFrame:
        # Local imports to avoid circular import at module top level.
        from app.ml.models import make_trained_model_fn, get as get_analytic

        if self._model_name in ("market_implied", "vig_included"):
            fn = get_analytic(self._model_name)
        else:
            fn = make_trained_model_fn(
                self._trained, calibrated=True, name_prefix=self._model_name,
            )

        rows: list[dict[str, float]] = []
        for _, row in model_input.iterrows():
            features = {k: row[k] for k in row.index if not k.startswith("market_")}
            market_raw = {k: row[k] for k in row.index if k.startswith("market_")}
            # make_trained_model_fn reads market.get(f"devigged_prob_<sel>");
            # the pyfunc input convention is market_prob_<sel>. Translate.
            market = {
                f"devigged_prob_{k.removeprefix('market_prob_')}": v
                for k, v in market_raw.items()
                if k.startswith("market_prob_")
            }
            rows.append(fn(features, market))
        return pd.DataFrame(rows, columns=["home", "draw", "away"])


def save_picks_model(
    *,
    model_name: str,
    trained_model: Any,
    artifact_path: str = "picks_model",
    extra_files: Optional[dict[str, str]] = None,
) -> None:
    """Pickle the trained model + a meta file, log via pyfunc.log_model.

    Caller must be inside an `mlflow.start_run()` context. Phase A logs
    without registering — `registered_model_name=None`.

    Args:
        model_name: one of the keys recognized by PicksModelWrapper.
        trained_model: the picklable trained object, or None for the
            analytic baselines (market_implied, vig_included).
        artifact_path: subpath within the run artifacts.
        extra_files: optional {filename: text_content} extras (e.g.
            reliability SVGs) logged as separate artifacts via log_text.
    """
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        model_pkl = tmp_path / "model.pkl"
        meta_txt = tmp_path / "meta.txt"
        with open(model_pkl, "wb") as f:
            pickle.dump(trained_model, f)
        meta_txt.write_text(model_name)

        mlflow.pyfunc.log_model(
            name=artifact_path,
            python_model=PicksModelWrapper(),
            artifacts={"model": str(model_pkl), "meta": str(meta_txt)},
            registered_model_name=None,  # Phase A: Registry in Phase C.
        )

    for filename, content in (extra_files or {}).items():
        mlflow.log_text(content, filename)
