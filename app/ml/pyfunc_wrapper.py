"""Universal MLflow pyfunc wrapper for every model in the picks zoo.

One class handles the sklearn-backed models (logistic, hgb, hgb_pca via
TrainedLogistic / TrainedHGB — hgb_pca's StandardScaler+PCA travels on
TrainedHGB.preprocessor) and the analytic baselines (market_implied,
vig_included — no trained object).

Input: pandas DataFrame with the raw feature columns plus, for models
that consume market context, `market_prob_<sel>` (devigged) and
`market_implied_<sel>` (1/price, vig included). Output: DataFrame with
columns ['home', 'draw', 'away'].

Dixon–Coles is logged (so its runs stay inspectable) but is NOT servable
through this pyfunc: its predictions need per-team attack/defence rates
that the artifact does not bundle. `predict` raises NotImplementedError
for it; live serving keeps loading Dixon–Coles from $APP_ML_MODELS_DIR.

Live serving does not call `predict` at all: app.ml.serving downloads a
registered version and unpickles `artifacts/model.pkl` directly. The
pyfunc flavor exists for MLflow-native consumers (`mlflow.pyfunc.
load_model`, `mlflow models serve`).

`mlflow` is imported lazily: `PicksModelWrapper` must subclass
mlflow.pyfunc.PythonModel, so the class is built on first attribute
access (PEP 562 module __getattr__) rather than at import time.
"""
from __future__ import annotations

import pickle
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

ARTIFACT_NAME = "picks_model"
MODEL_PICKLE = "model.pkl"
META_FILE = "meta.txt"

ANALYTIC_MODELS = frozenset({"market_implied", "vig_included"})
# Models the live serving layer can load from a registered version.
SERVABLE_MODELS = frozenset({"logistic", "hgb", "hgb_pca"})

# Absolute path of the `app` package, shipped with every logged model via
# code_paths so the pickled Trained* classes resolve wherever it's loaded.
APP_PACKAGE_DIR = Path(__file__).resolve().parents[1]

_SELECTIONS = ("home", "draw", "away")
_wrapper_class: Optional[type] = None


def _build_wrapper_class() -> type:
    from mlflow.pyfunc import PythonModel

    class PicksModelWrapper(PythonModel):
        """Single pyfunc that dispatches on the model_name meta file."""

        def load_context(self, context) -> None:
            with open(context.artifacts["model"], "rb") as f:
                self._trained = pickle.load(f)
            self._model_name = Path(context.artifacts["meta"]).read_text().strip()

        def predict(self, context, model_input, params=None):
            import pandas as pd

            from app.ml.models import get as get_analytic, make_trained_model_fn

            if self._model_name == "dixon_coles":
                raise NotImplementedError(
                    "dixon_coles is not servable through the picks pyfunc: "
                    "predictions need per-team rates the artifact does not "
                    "bundle. Serve it from $APP_ML_MODELS_DIR instead."
                )
            if self._model_name in ANALYTIC_MODELS:
                fn = get_analytic(self._model_name)
            else:
                fn = make_trained_model_fn(
                    self._trained, calibrated=True, name_prefix=self._model_name,
                )

            rows: list[dict[str, float]] = []
            for _, row in model_input.iterrows():
                features: dict[str, Any] = {}
                market: dict[str, Any] = {}
                for key, value in row.items():
                    value = None if pd.isna(value) else value
                    # The ModelFn market context uses devigged_prob_<sel> /
                    # implied_prob_<sel>; the pyfunc input convention is
                    # market_prob_<sel> / market_implied_<sel>.
                    if key.startswith("market_prob_"):
                        market[f"devigged_prob_{key.removeprefix('market_prob_')}"] = value
                    elif key.startswith("market_implied_"):
                        market[f"implied_prob_{key.removeprefix('market_implied_')}"] = value
                    else:
                        features[key] = value
                rows.append(fn(features, market))
            return pd.DataFrame(rows, columns=list(_SELECTIONS))

    # Pickle by reference (app.ml.pyfunc_wrapper.PicksModelWrapper), which
    # resolves through this module's __getattr__ at load time.
    PicksModelWrapper.__qualname__ = "PicksModelWrapper"
    PicksModelWrapper.__module__ = __name__
    return PicksModelWrapper


def __getattr__(name: str) -> Any:
    global _wrapper_class
    if name == "PicksModelWrapper":
        if _wrapper_class is None:
            _wrapper_class = _build_wrapper_class()
        return _wrapper_class
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _input_columns(model_name: str, trained_model: Any) -> list[str]:
    if model_name == "market_implied":
        return [f"market_prob_{s}" for s in _SELECTIONS]
    if model_name == "vig_included":
        return [f"market_implied_{s}" for s in _SELECTIONS]
    return list(getattr(trained_model, "feature_columns", ()) or ())


def _signature(model_name: str, trained_model: Any):
    """Column-level signature. None for models without a fixed input
    schema (Dixon–Coles keys on event_id)."""
    from mlflow.models import ModelSignature
    from mlflow.types import ColSpec, Schema

    columns = _input_columns(model_name, trained_model)
    if not columns:
        return None
    return ModelSignature(
        inputs=Schema([ColSpec("double", c) for c in columns]),
        outputs=Schema([ColSpec("double", s) for s in _SELECTIONS]),
    )


def _pip_requirements() -> list[str]:
    """Pinned to the logging environment. Explicit requirements also skip
    MLflow's dependency-inference subprocess (seconds per log)."""
    from importlib.metadata import PackageNotFoundError, version

    reqs = []
    for dist in ("mlflow", "scikit-learn", "numpy", "pandas"):
        try:
            reqs.append(f"{dist}=={version(dist)}")
        except PackageNotFoundError:
            reqs.append(dist)
    return reqs


def save_picks_model(
    *,
    model_name: str,
    trained_model: Any,
    artifact_path: str = ARTIFACT_NAME,
    extra_files: Optional[dict[str, str]] = None,
) -> str:
    """Pickle the trained model + a meta file and log them as a pyfunc
    model named `artifact_path` (default `picks_model`) into the active
    run. Returns the logged model URI (`models:/<model_id>`).

    Caller must be inside an `mlflow.start_run()` context. Registration
    is a separate, explicit step (app.ml.registry.register_run).

    Args:
        model_name: one of the keys recognized by PicksModelWrapper.
        trained_model: the picklable trained object, or None for the
            analytic baselines (market_implied, vig_included).
        artifact_path: logged-model name within the run.
        extra_files: optional {filename: text_content} extras (e.g.
            reliability SVGs) logged as separate run artifacts.
    """
    from app.ml.tracking import import_mlflow

    mlflow = import_mlflow()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        model_pkl = tmp_path / MODEL_PICKLE
        meta_txt = tmp_path / META_FILE
        with open(model_pkl, "wb") as f:
            pickle.dump(trained_model, f)
        meta_txt.write_text(model_name)
        # Ship the app package minus bytecode caches.
        code_dir = tmp_path / "code" / APP_PACKAGE_DIR.name
        shutil.copytree(
            APP_PACKAGE_DIR, code_dir,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )

        wrapper_cls = __getattr__("PicksModelWrapper")
        info = mlflow.pyfunc.log_model(
            name=artifact_path,
            python_model=wrapper_cls(),
            artifacts={"model": str(model_pkl), "meta": str(meta_txt)},
            code_paths=[str(code_dir)],
            signature=_signature(model_name, trained_model),
            pip_requirements=_pip_requirements(),
        )

    for filename, content in (extra_files or {}).items():
        mlflow.log_text(content, filename)
    return info.model_uri
