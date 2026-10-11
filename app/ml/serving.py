"""Live-serving glue for Phase 4 predictions.

Bridges trained Phase 3 models (logistic, HGB, HGB+PCA, Dixon-Coles) to
the FastAPI endpoints `/predict/{event_id}` and `/picks/upcoming`, the
refresh-now predict stage and ``scripts.record_picks``. Provides:

  - :func:`load_models` — resolves each servable model from the MLflow
    registry alias ``@champion`` (app.ml.registry), falling back to the
    ``$APP_ML_MODELS_DIR/<label>/`` pickles when the registry is
    disabled, unreachable, or has no champion. Dixon-Coles always loads
    from files (its registry artifact doesn't bundle team rates).
  - :func:`get_served_artifacts` / :func:`reload_models` — the process's
    served set, swappable at runtime (``POST /ml/reload``, champion
    changes) — and :func:`served_models_info` describing it.
  - :func:`predict_event` — per-(model, market, selection) records.
  - :func:`devig_from_live_snapshot` — pull the freshest
    ``live_odds_snapshots`` rows for a fixture, average across
    bookmakers per (market, selection), and produce devigged
    probabilities + live decimal prices.
  - :func:`kelly_fraction` — full Kelly given (model_prob, price).

For upcoming fixtures the model's effective as_of_ts is *now*. We use
the most recent ``live_odds_snapshots`` row for the market context so
predictions reflect what the market is offering right now, not the
archive's closing snapshot.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from app.ml import db as ml_db


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Loaded-model container
# ---------------------------------------------------------------------------

# Served model keys, in display order. Registry-servable ones are
# app.ml.pyfunc_wrapper.SERVABLE_MODELS; dixon_coles is file-only.
SERVED_MODELS = ("logistic", "hgb", "hgb_pca", "dixon_coles")


@dataclass
class ServedModelInfo:
    """Provenance of one served model; shaped like `ServedModel` in
    frontend/src/types/ops.ts."""
    name: str
    loaded: bool = False
    source: Optional[str] = None      # "registry" | "file" | None
    version: Optional[str] = None     # registry version; None for files
    run_id: Optional[str] = None      # MLflow source run of that version
    loaded_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ModelArtifacts:
    """All trained models we serve. Any can be None if its artifact is
    unavailable — the endpoint returns the available subset."""
    logistic: Optional[Any] = None              # TrainedLogistic
    hgb: Optional[Any] = None                   # TrainedHGB
    hgb_pca: Optional[Any] = None               # TrainedHGB with a fitted preprocessor
    dc_rates: Optional[Dict[str, Dict]] = None  # event_id -> rate dict (per-event pre-match)
    dc_team_rates: Optional[Dict[str, Dict]] = None  # team_name -> rate dict (latest state)
    dc_config: Optional[Any] = None             # DCConfig
    dc_temperature: float = 1.0
    feature_columns_logistic: Tuple[str, ...] = ()
    feature_columns_hgb: Tuple[str, ...] = ()
    served: Dict[str, ServedModelInfo] = field(
        default_factory=lambda: {name: ServedModelInfo(name=name) for name in SERVED_MODELS}
    )

    def model_version(self, model: str) -> Optional[str]:
        """What produced `model`'s predictions, as recorded on paper_bets:
        the registry version (e.g. "3"), "file", or None if not loaded."""
        info = self.served.get(model)
        if info is None or not info.loaded:
            return None
        return info.version if info.source == "registry" else "file"


def _resolve_artifact_dir() -> Path:
    return Path(os.environ.get("APP_ML_MODELS_DIR", "reports"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _registry_champions() -> Dict[str, Any]:
    """{model_name: LoadedVersion} for every servable model with an
    `@champion`. Empty when MLflow is disabled or unreachable; a broken
    version is skipped (that model falls back to its file)."""
    from app.ml import tracking

    if not tracking.is_enabled():
        return {}
    from app.ml.pyfunc_wrapper import SERVABLE_MODELS
    from app.ml.registry import MlflowUnavailable, load_champion

    loaded: Dict[str, Any] = {}
    for name in sorted(SERVABLE_MODELS):
        try:
            version = load_champion(name)
        except MlflowUnavailable as exc:
            logger.info("model registry unavailable, serving from files: %s", exc)
            return loaded
        except Exception:
            logger.exception("failed to load %s@champion; falling back to file", name)
            continue
        if version is not None:
            loaded[name] = version
    return loaded


def load_models(
    *,
    use_registry: bool = True,
    logistic_label: str = "logistic_phase3a",
    hgb_label: str = "hgb_phase3b",
    dc_label: str = "dixon_coles_phase3c",
) -> ModelArtifacts:
    """Load every servable model. logistic / hgb / hgb_pca come from the
    registry's ``@champion`` when available, else (logistic, hgb) from
    ``$APP_ML_MODELS_DIR/<label>/model.pkl``; Dixon-Coles always from
    ``$APP_ML_MODELS_DIR/<dc_label>/``. Each loader is independent; if
    one artifact is missing the others are still returned. Provenance is
    recorded in ``ModelArtifacts.served``."""
    from app.ml.dixon_coles import DCConfig
    from app.ml.training import TrainedHGB, TrainedLogistic

    base = _resolve_artifact_dir()
    out = ModelArtifacts()
    champions = _registry_champions() if use_registry else {}

    for name, champion in champions.items():
        setattr(out, name, champion.trained)
        out.served[name] = ServedModelInfo(
            name=name, loaded=True, source="registry", version=champion.version,
            run_id=champion.run_id, loaded_at=_now_iso(),
        )
        logger.info("loaded %s v%s from the model registry", name, champion.version)

    def _mark_file(name: str) -> None:
        out.served[name] = ServedModelInfo(
            name=name, loaded=True, source="file", loaded_at=_now_iso(),
        )

    log_path = base / logistic_label / "model.pkl"
    if out.logistic is None and log_path.exists():
        try:
            out.logistic = TrainedLogistic.load(str(log_path))
            _mark_file("logistic")
            logger.info("loaded logistic model from %s", log_path)
        except Exception:
            logger.exception("failed to load logistic from %s", log_path)

    hgb_path = base / hgb_label / "model.pkl"
    if out.hgb is None and hgb_path.exists():
        try:
            out.hgb = TrainedHGB.load(str(hgb_path))
            _mark_file("hgb")
            logger.info("loaded hgb model from %s", hgb_path)
        except Exception:
            logger.exception("failed to load hgb from %s", hgb_path)

    if out.logistic is not None:
        out.feature_columns_logistic = tuple(out.logistic.feature_columns)
    if out.hgb is not None:
        out.feature_columns_hgb = tuple(out.hgb.feature_columns)

    dc_team_rates_path = base / dc_label / "team_latest_rates.json"
    if dc_team_rates_path.exists():
        try:
            out.dc_team_rates = json.loads(dc_team_rates_path.read_text())
            logger.info("loaded dixon-coles team-latest rates (%d teams) from %s",
                        len(out.dc_team_rates), dc_team_rates_path)
        except Exception:
            logger.exception("failed to load dc team rates from %s", dc_team_rates_path)

    dc_rates_path = base / dc_label / "rates_snapshot.json"
    dc_metrics_path = base / dc_label / "metrics.json"
    if dc_rates_path.exists():
        try:
            out.dc_rates = json.loads(dc_rates_path.read_text())
            # Read DC config + temperature from the run's metrics.json so
            # serving reproduces the trained-time settings.
            if dc_metrics_path.exists():
                metrics = json.loads(dc_metrics_path.read_text())
                cfg_dict = metrics.get("config", {}) or {}
                out.dc_config = DCConfig(
                    xg_weight=cfg_dict.get("xg_weight", 0.4),
                    ewma_half_life=cfg_dict.get("ewma_half_life", 10),
                    home_advantage=cfg_dict.get("home_advantage", 1.30),
                    rho=cfg_dict.get("rho", -0.12),
                    max_goals=cfg_dict.get("max_goals", 10),
                    league_mean_goals=cfg_dict.get("league_mean_goals", 1.35),
                )
                out.dc_temperature = float(metrics.get("temperature", 1.0))
            else:
                out.dc_config = DCConfig()
            logger.info("loaded dixon-coles rates (%d events) from %s",
                        len(out.dc_rates), dc_rates_path)
        except Exception:
            logger.exception("failed to load dc rates from %s", dc_rates_path)

    if out.dc_config is not None and (out.dc_rates is not None or out.dc_team_rates is not None):
        _mark_file("dixon_coles")

    return out


# ---------------------------------------------------------------------------
# Process-wide served set
# ---------------------------------------------------------------------------

_served: Optional[ModelArtifacts] = None
_served_lock = threading.Lock()


def get_served_artifacts() -> ModelArtifacts:
    """The models this process serves, loaded on first use."""
    global _served
    current = _served
    if current is not None:
        return current
    with _served_lock:
        if _served is None:
            _served = load_models()
        return _served


def reload_models() -> ModelArtifacts:
    """Re-resolve every model (registry champion first, then files) and
    atomically swap the served set. Concurrent readers keep using the
    previous set until the swap. Blocking — call from a thread."""
    global _served
    with _served_lock:
        fresh = load_models()
        _served = fresh
    logger.info(
        "served_models_reloaded",
        extra={"event": "served_models_reloaded",
               "models": {k: v.to_dict() for k, v in fresh.served.items()}},
    )
    return fresh


def served_models_info() -> List[Dict[str, Any]]:
    """`ServedModel[]` for /ops/status and /ml/reload. Reads the current
    served set only — never loads models or touches the network."""
    current = _served
    if current is None:
        return [ServedModelInfo(name=name).to_dict() for name in SERVED_MODELS]
    return [current.served[name].to_dict() for name in SERVED_MODELS]


# ---------------------------------------------------------------------------
# Live market context from live_odds_snapshots
# ---------------------------------------------------------------------------

@dataclass
class LiveMarketSnapshot:
    market: str
    selections: Dict[str, Dict[str, float]] = field(default_factory=dict)
    # selections: { selection_key: { "price": float, "implied": float,
    #                                "devigged": float } }


def _latest_live_rows_for_event(
    event_id: str,
) -> Tuple[Optional[datetime], List[sqlite3.Row]]:
    """Pull the most recent fetched_at for ``event_id`` and return all
    rows captured at that same timestamp."""
    with ml_db.connect(read_only=True) as conn:
        latest = conn.execute(
            "SELECT MAX(fetched_at) AS t FROM live_odds_snapshots WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if latest is None or latest["t"] is None:
            return None, []
        rows = conn.execute(
            """
            SELECT bookmaker, market, selection_key, decimal_price, opening_price, fetched_at
            FROM live_odds_snapshots
            WHERE event_id = ? AND fetched_at = ?
            """,
            (event_id, latest["t"]),
        ).fetchall()
    fetched_dt = None
    if latest["t"]:
        ts = latest["t"]
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        try:
            fetched_dt = datetime.fromisoformat(ts)
        except (TypeError, ValueError):
            fetched_dt = None
    return fetched_dt, list(rows)


def _devig_rows(market: str, rows: List[sqlite3.Row]) -> LiveMarketSnapshot:
    """Group raw live rows by bookmaker, devig per market grouping, then
    average across bookmakers. Returns a LiveMarketSnapshot with
    ``selections[sel] = {price, implied, devigged}``."""
    from app.ml.closing_odds import _devig_market_group, _OutcomeRow

    by_bookmaker: Dict[str, List[_OutcomeRow]] = {}
    for r in rows:
        bk = r["bookmaker"] or "unknown"
        # Reconstruct an _OutcomeRow with just enough fields for the
        # devig_market_group dispatch — handicap is encoded in the
        # selection_key already (e.g. "OVER@2.5").
        handicap = None
        sel = r["selection_key"]
        if "@" in sel:
            handicap = sel.split("@", 1)[1]
        by_bookmaker.setdefault(bk, []).append(
            _OutcomeRow(
                bookmaker=bk,
                market=market,
                selection_key=sel,
                decimal_price=float(r["decimal_price"]),
                handicap=handicap,
                eventParticipantId=None,
            )
        )

    # Per-bookmaker devig, then average per selection_key across books.
    accumulator: Dict[str, Dict[str, float]] = {}
    for bk, bk_rows in by_bookmaker.items():
        devigged = _devig_market_group(market, bk_rows)
        for r in bk_rows:
            dv = devigged.get(r.selection_key)
            entry = accumulator.setdefault(r.selection_key, {
                "price_sum": 0.0,
                "implied_sum": 0.0,
                "devigged_sum": 0.0,
                "devigged_count": 0,
                "count": 0,
            })
            entry["price_sum"] += r.decimal_price
            entry["implied_sum"] += 1.0 / r.decimal_price
            entry["count"] += 1
            if dv is not None:
                entry["devigged_sum"] += dv
                entry["devigged_count"] += 1

    selections: Dict[str, Dict[str, float]] = {}
    for sel, agg in accumulator.items():
        n = agg["count"] or 1
        dv = (
            agg["devigged_sum"] / agg["devigged_count"]
            if agg["devigged_count"] else None
        )
        selections[sel] = {
            "price": agg["price_sum"] / n,
            "implied": agg["implied_sum"] / n,
            "devigged": dv,
        }
    return LiveMarketSnapshot(market=market, selections=selections)


def latest_market_snapshots(event_id: str) -> Tuple[Optional[datetime], Dict[str, LiveMarketSnapshot]]:
    """Return (fetched_at, {market: LiveMarketSnapshot}) for the most
    recent live_odds_snapshot capture of this event."""
    fetched_at, rows = _latest_live_rows_for_event(event_id)
    by_market: Dict[str, List[sqlite3.Row]] = {}
    for r in rows:
        by_market.setdefault(r["market"], []).append(r)
    snapshots = {market: _devig_rows(market, mrows) for market, mrows in by_market.items()}
    return fetched_at, snapshots


# ---------------------------------------------------------------------------
# Kelly + edge math
# ---------------------------------------------------------------------------

def kelly_fraction(prob: float, price: float) -> float:
    """Full-Kelly bankroll fraction. Negative or zero means don't bet."""
    b = price - 1.0
    if b <= 0:
        return 0.0
    f = (b * prob - (1.0 - prob)) / b
    return max(0.0, f)


# ---------------------------------------------------------------------------
# Per-event prediction
# ---------------------------------------------------------------------------

# Markets and selection identifiers we serve. The selection labels are
# canonical and used by paper_bets and the dashboard.
SELECTIONS_1X2 = ("home", "draw", "away")
SELECTIONS_OU = ("over", "under")
SELECTIONS_BTTS = ("yes", "no")


@dataclass
class PredictionRecord:
    model: str          # "logistic" | "hgb" | "hgb_pca" | "dixon_coles"
    market: str         # "1X2_FT" | "OVER_UNDER_2.5_FT" | "BTTS_FT"
    selection: str
    model_prob: float
    market_price: Optional[float]      # decimal odds from live snapshot
    market_implied: Optional[float]    # 1/price (vig included)
    market_devigged: Optional[float]   # devigged fair prob
    edge: Optional[float]              # model_prob − market_devigged
    kelly_full: Optional[float]        # full-Kelly fraction at live price
    notes: Dict[str, Any] = field(default_factory=dict)
    # Registry version that produced the prediction, "file" for
    # $APP_ML_MODELS_DIR pickles. Recorded on paper_bets.model_version.
    model_version: Optional[str] = None


def _logistic_or_hgb_predict_1x2(
    trained,
    feature_dict: Mapping[str, object],
    market_devigged: Optional[Tuple[Optional[float], Optional[float], Optional[float]]],
) -> Optional[Tuple[float, float, float]]:
    """Run logistic or HGB. Returns None if any required feature is missing."""
    row = []
    for col in trained.feature_columns:
        if col.startswith("market_prob_"):
            if market_devigged is None:
                return None
            sel = col.removeprefix("market_prob_")
            idx = {"home": 0, "draw": 1, "away": 2}[sel]
            v = market_devigged[idx]
        else:
            v = feature_dict.get(col)
        if v is None:
            return None
        row.append(float(v))
    X = np.asarray([row], dtype=float)
    probs = (
        trained.predict_proba_calibrated(X)[0]
        if trained.calibrators else trained.predict_proba(X)[0]
    )
    return float(probs[0]), float(probs[1]), float(probs[2])


def _dc_predict_event(
    artifacts: ModelArtifacts,
    event_id: str,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
) -> Optional[Dict[str, Tuple[float, ...]]]:
    """Return {"1X2": (p_h, p_d, p_a), "OU": (p_over, p_under),
    "BTTS": (p_yes, p_no)} for the configured DC line, or None if rates
    are unavailable for this event.

    Resolution order:
      1. Per-event pre-match rates from rates_snapshot.json (best —
         these are the rates used during training).
      2. Per-team latest rates from team_latest_rates.json, keyed by
         home_team / away_team. Used for upcoming fixtures whose
         event_id wasn't in the training set.
    """
    if artifacts.dc_config is None:
        return None
    cfg = artifacts.dc_config

    rates = None
    if artifacts.dc_rates is not None:
        rates = artifacts.dc_rates.get(event_id)
    if rates is None and artifacts.dc_team_rates is not None and home_team and away_team:
        home_state = artifacts.dc_team_rates.get(home_team)
        away_state = artifacts.dc_team_rates.get(away_team)
        if home_state and away_state:
            rates = {
                "home_attack": home_state["attack"],
                "home_defense": home_state["defense"],
                "away_attack": away_state["attack"],
                "away_defense": away_state["defense"],
            }
    if rates is None:
        return None

    lam_h = rates["home_attack"] * rates["away_defense"] * cfg.home_advantage * cfg.league_mean_goals
    lam_a = rates["away_attack"] * rates["home_defense"] * cfg.league_mean_goals

    from app.ml.dixon_coles import (
        apply_temperature,
        btts_probabilities,
        match_probabilities,
        over_under_probabilities,
    )

    p_h, p_d, p_a = match_probabilities(lam_h, lam_a, cfg=cfg)
    if artifacts.dc_temperature != 1.0:
        arr = apply_temperature(np.asarray([[p_h, p_d, p_a]]), artifacts.dc_temperature)
        p_h, p_d, p_a = float(arr[0, 0]), float(arr[0, 1]), float(arr[0, 2])
    p_over, p_under = over_under_probabilities(lam_h, lam_a, line=2.5, cfg=cfg)
    p_btts_yes, p_btts_no = btts_probabilities(lam_h, lam_a, cfg=cfg)
    return {
        "1X2": (p_h, p_d, p_a),
        "OU": (p_over, p_under),
        "BTTS": (p_btts_yes, p_btts_no),
    }


def _resolve_home_selection_key_live(rows: List[sqlite3.Row]) -> Optional[str]:
    """Same convention as the backtester's _resolve_home_selection_key,
    but for live rows. We can't read the upstream payload from the
    compact live_odds_snapshots rows, so we use the upcoming_fixtures
    table's home_team_raw column as a fallback hint — but the cleanest
    signal here is positional in the upstream odds. For Phase 4 we just
    pick the non-DRAW selection_key with the lowest price as the
    likely-home (favourite). This is imperfect; downstream consumers
    should refer to the canonical home_team from match metadata."""
    candidates = [
        (r["selection_key"], float(r["decimal_price"]))
        for r in rows if r["selection_key"] != "DRAW"
    ]
    if len(candidates) < 2:
        return None
    # In practice we want the canonical participant ID mapping. Since
    # the compact table doesn't carry it, we cannot reliably identify
    # home vs away from price alone. Return None to signal "use the
    # upstream payload via odds_snapshots if available".
    return None


def predict_event(
    event_id: str,
    artifacts: ModelArtifacts,
    *,
    as_of_ts: Optional[str] = None,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
) -> List[PredictionRecord]:
    """Produce per-(model, market, selection) predictions for an event.

    ``as_of_ts`` defaults to *now* — i.e. live prediction. If passed an
    earlier timestamp the team-state features still resolve to that
    moment, but the market context uses the latest live snapshot
    regardless (the model is asked "what would you pick now with what
    we now see").
    """
    from app.ml.features import get_features

    as_of = as_of_ts or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    features = get_features(event_id, as_of) or {}

    fetched_at, snapshots_by_market = latest_market_snapshots(event_id)

    # Identify which selection_key is home/away/draw in 1X2. We need a
    # team→participant mapping, available via odds_snapshots.upstream
    # for events the archive already scraped. Falls back to None when
    # the event has no archive entry (purely upcoming fixture seen only
    # via live snapshots).
    home_sel_key = None
    away_sel_key = None
    market_1x2_sel = snapshots_by_market.get("HOME_DRAW_AWAY:FULL_TIME")
    if market_1x2_sel:
        with ml_db.connect(read_only=True) as conn:
            row = conn.execute(
                "SELECT upstream_payload_json FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1",
                (event_id,),
            ).fetchone()
        if row and row["upstream_payload_json"]:
            try:
                up = json.loads(row["upstream_payload_json"])
                container = (up or {}).get("data", {}).get("findOddsByEventId")
                if isinstance(container, dict):
                    for entry in container.get("odds") or ():
                        if (entry.get("bettingType") == "HOME_DRAW_AWAY"
                                and entry.get("bettingScope") == "FULL_TIME"):
                            outcomes = entry.get("odds") or []
                            non_draw = [
                                str(o.get("eventParticipantId"))
                                for o in outcomes
                                if o.get("eventParticipantId")
                            ]
                            if len(non_draw) >= 2:
                                home_sel_key, away_sel_key = non_draw[0], non_draw[1]
                            break
            except (TypeError, ValueError):
                pass

    # Build canonical 1X2 market_prob_devigged tuple if we have the keys.
    market_devigged_1x2: Optional[Tuple[Optional[float], Optional[float], Optional[float]]] = None
    market_price_1x2: Dict[str, Optional[float]] = {"home": None, "draw": None, "away": None}
    market_implied_1x2: Dict[str, Optional[float]] = {"home": None, "draw": None, "away": None}
    market_dv_1x2: Dict[str, Optional[float]] = {"home": None, "draw": None, "away": None}
    if market_1x2_sel:
        def _pluck(sel_key: Optional[str]):
            if not sel_key:
                return None
            return market_1x2_sel.selections.get(sel_key)

        for canon, sel_key in (
            ("home", home_sel_key), ("draw", "DRAW"), ("away", away_sel_key)
        ):
            entry = _pluck(sel_key)
            if entry is not None:
                market_price_1x2[canon] = entry["price"]
                market_implied_1x2[canon] = entry["implied"]
                market_dv_1x2[canon] = entry["devigged"]

        if all(market_dv_1x2[k] is not None for k in ("home", "draw", "away")):
            market_devigged_1x2 = (
                market_dv_1x2["home"], market_dv_1x2["draw"], market_dv_1x2["away"],
            )

    records: List[PredictionRecord] = []

    # 1X2 — sklearn-backed models (hgb_pca projects inside TrainedHGB), then DC
    for model_name, trained in (
        ("logistic", artifacts.logistic),
        ("hgb", artifacts.hgb),
        ("hgb_pca", artifacts.hgb_pca),
    ):
        if trained is None:
            continue
        probs = _logistic_or_hgb_predict_1x2(trained, features, market_devigged_1x2)
        if probs is None:
            continue
        for i, sel in enumerate(SELECTIONS_1X2):
            price = market_price_1x2[sel]
            dv = market_dv_1x2[sel]
            edge = probs[i] - dv if dv is not None else None
            kelly = kelly_fraction(probs[i], price) if price is not None else None
            records.append(PredictionRecord(
                model=model_name, market="1X2_FT", selection=sel,
                model_prob=probs[i],
                market_price=price, market_implied=market_implied_1x2[sel],
                market_devigged=dv, edge=edge, kelly_full=kelly,
                model_version=artifacts.model_version(model_name),
            ))

    # Resolve home/away team names. Prefer values passed in by the
    # caller (e.g. upcoming_fixtures.home_team_raw); otherwise pull from
    # bet_labels (settled events) or fall back to upcoming_fixtures.
    resolved_home = home_team
    resolved_away = away_team
    if resolved_home is None or resolved_away is None:
        with ml_db.connect(read_only=True) as conn:
            row = conn.execute(
                "SELECT home_team, away_team FROM bet_labels WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if row is not None:
                resolved_home = resolved_home or row["home_team"]
                resolved_away = resolved_away or row["away_team"]
            else:
                row = conn.execute(
                    "SELECT home_team_raw, away_team_raw FROM upcoming_fixtures WHERE event_id = ?",
                    (event_id,),
                ).fetchone()
                if row is not None:
                    resolved_home = resolved_home or row["home_team_raw"]
                    resolved_away = resolved_away or row["away_team_raw"]

    dc_probs = _dc_predict_event(
        artifacts, event_id,
        home_team=resolved_home, away_team=resolved_away,
    )
    if dc_probs is not None:
        dc_version = artifacts.model_version("dixon_coles")
        # 1X2
        for i, sel in enumerate(SELECTIONS_1X2):
            p = dc_probs["1X2"][i]
            price = market_price_1x2[sel]
            dv = market_dv_1x2[sel]
            edge = p - dv if dv is not None else None
            kelly = kelly_fraction(p, price) if price is not None else None
            records.append(PredictionRecord(
                model="dixon_coles", market="1X2_FT", selection=sel,
                model_prob=p,
                market_price=price, market_implied=market_implied_1x2[sel],
                market_devigged=dv, edge=edge, kelly_full=kelly,
                model_version=dc_version,
            ))

        # O/U 2.5
        market_ou = snapshots_by_market.get("OVER_UNDER:FULL_TIME")
        for i, sel in enumerate(SELECTIONS_OU):
            p = dc_probs["OU"][i]
            entry = None
            if market_ou:
                sel_key = f"{sel.upper()}@2.5"
                entry = market_ou.selections.get(sel_key)
            price = entry["price"] if entry else None
            implied = entry["implied"] if entry else None
            dv = entry["devigged"] if entry else None
            edge = p - dv if dv is not None else None
            kelly = kelly_fraction(p, price) if price is not None else None
            records.append(PredictionRecord(
                model="dixon_coles", market="OVER_UNDER_2.5_FT", selection=sel,
                model_prob=p,
                market_price=price, market_implied=implied,
                market_devigged=dv, edge=edge, kelly_full=kelly,
                notes={"line": 2.5}, model_version=dc_version,
            ))

        # BTTS
        market_btts = snapshots_by_market.get("BOTH_TEAMS_TO_SCORE:FULL_TIME")
        for i, sel in enumerate(SELECTIONS_BTTS):
            p = dc_probs["BTTS"][i]
            entry = None
            if market_btts:
                sel_key = sel.upper()  # selections come through as "YES"/"NO"
                entry = market_btts.selections.get(sel_key)
            price = entry["price"] if entry else None
            implied = entry["implied"] if entry else None
            dv = entry["devigged"] if entry else None
            edge = p - dv if dv is not None else None
            kelly = kelly_fraction(p, price) if price is not None else None
            records.append(PredictionRecord(
                model="dixon_coles", market="BTTS_FT", selection=sel,
                model_prob=p,
                market_price=price, market_implied=implied,
                market_devigged=dv, edge=edge, kelly_full=kelly,
                model_version=dc_version,
            ))

    return records


def list_upcoming_events(*, hours_ahead: int = 72) -> List[Dict[str, Any]]:
    """Return upcoming_fixtures kicking off in the next ``hours_ahead``
    hours. Used by ``/picks/upcoming`` to enumerate candidates."""
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    upper = now + timedelta(hours=hours_ahead)
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """
            SELECT event_id, competition_path, sport, country, competition,
                   home_team_raw, away_team_raw, start_time_utc
            FROM upcoming_fixtures
            WHERE start_time_utc >= ? AND start_time_utc <= ?
            ORDER BY start_time_utc ASC
            """,
            (now.isoformat(), upper.isoformat()),
        ).fetchall()
    return [dict(row) for row in rows]
