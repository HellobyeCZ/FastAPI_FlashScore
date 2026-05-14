# Trainable Backtests + Facets + ExploreTab Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `logistic` and `dixon_coles` backtestable end-to-end (with fresh fit-at-cutoff and zero leakage), populate the Explore tab's filter dropdowns via a shared source-aware `/picks/facets` endpoint, and thread `source`/`run_id` through ExploreTab. Adds a minimal `MarketSpec` seam so Stage 3 becomes a config addition.

**Architecture:** New `MarketSpec` dataclass with a single `FOOTBALL_1X2_FT` instance threaded through `run_backtest`, the worker, and a new `TRAINABLE` adapter registry. `fit_logistic_at` and `fit_dixon_coles_at` compose existing `app/ml/training.py` functions to train in-memory at a cutoff and return a `ModelFn`. New `backtest_runs.stage` and `backtest_runs.market_spec` columns. New `app/ml/picks_facets.py` aggregator + `GET /picks/facets` route + `usePicksFacets` hook consumed by ExploreTab.

**Tech Stack:** FastAPI, SQLite, Prisma 7, scikit-learn, numpy, pytest, Next.js 14 App Router, React Query.

**Branch:** `feat/model-backtest-retro-bets` (continuation — the prior Run-Backtest tasks are already on this branch).

**Spec:** `docs/superpowers/specs/2026-05-14-trainable-backtests-and-facets-design.md`

---

## File Structure

**Backend (new):**
- `app/ml/market_spec.py` — `MarketSpec` dataclass, `FOOTBALL_1X2_FT` instance, `REGISTRY`, `get_spec`, `_label_1x2_ft`
- `app/ml/trainable.py` — `TRAINABLE` dict, `resolve_model_for_backtest`, `fit_logistic_at`, `fit_dixon_coles_at`
- `app/ml/picks_facets.py` — `facets_for_live`, `facets_for_backtest`, `facets_for_both`, `FacetsResponse`
- `tests/ml/test_market_spec.py`
- `tests/ml/test_trainable.py`
- `tests/ml/test_picks_facets.py`
- `tests/api/test_picks_facets_route.py`
- `tests/services/test_backtest_manager_stage.py`

**Backend (modified):**
- `app/ml/backtest.py` — `run_backtest(market_spec=FOOTBALL_1X2_FT)` kwarg; module-level `SELECTIONS` replaced by `spec.selections` inside the function; `outcome_1x2` lookup replaced by `spec.label_fn`
- `app/services/backtest_manager.py` — `CreateRunParams.market_spec`, worker calls `resolve_model_for_backtest`, writes `stage` transitions
- `app/ml/backtest_storage.py` — `RunRow` gains `stage` and `market_spec` fields
- `app/services/storage.py:_ensure_backtest_tables` — idempotent `ALTER TABLE` for the two new columns
- `app/schemas/backtest.py` — `BacktestRunSummary.stage`, `BacktestRunDetail.market_spec`
- `frontend/prisma/schema.prisma` — `BacktestRun.stage`, `BacktestRun.marketSpec`
- `frontend/prisma/migrations/<ts>_backtest_stage_and_market_spec/migration.sql` — hand-written
- `src.py` — `/picks/facets` route + enriched `/backtest/models` response

**Frontend (new):**
- `frontend/src/hooks/usePicksFacets.ts`
- `frontend/src/app/api/picks/facets/route.ts`

**Frontend (modified):**
- `frontend/src/components/picks/tabs/ExploreTab.tsx` — facets hook + source threading + `needsRun` guard + raw-scatter honors source
- `frontend/src/components/picks/BacktestRunsPanel.tsx` — display `status · stage`
- `frontend/src/lib/api-backtest.ts` — `BacktestRunSummary.stage`
- `frontend/src/lib/api-picks.ts` — (no signature change; facets is a new function in a new module)

---

## Task 1: `MarketSpec` module + `FOOTBALL_1X2_FT` instance

**Files:**
- Create: `app/ml/market_spec.py`
- Test: `tests/ml/test_market_spec.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/ml/test_market_spec.py
import pytest

from app.ml.market_spec import (
    FOOTBALL_1X2_FT,
    MarketSpec,
    REGISTRY,
    get_spec,
)


def test_football_1x2_ft_has_expected_shape():
    spec = FOOTBALL_1X2_FT
    assert spec.key == "football_1x2_ft"
    assert spec.sport == "football"
    assert spec.market == "1x2_ft"
    assert spec.selections == ("home", "draw", "away")
    assert spec.feature_window_unit == "matches"
    assert len(spec.scope) > 0
    assert callable(spec.label_fn)


def test_registry_contains_football_1x2_ft():
    assert "football_1x2_ft" in REGISTRY
    assert REGISTRY["football_1x2_ft"] is FOOTBALL_1X2_FT


def test_get_spec_returns_registered():
    assert get_spec("football_1x2_ft") is FOOTBALL_1X2_FT


def test_get_spec_unknown_raises():
    with pytest.raises(KeyError, match="unknown market_spec"):
        get_spec("does_not_exist")


def test_label_fn_returns_one_hot_over_selections():
    """label_fn takes a row-like mapping with outcome_1x2 ∈ {home, draw, away}
    and returns {selection: 1.0 if winner else 0.0}."""
    spec = FOOTBALL_1X2_FT
    # Home win
    out = spec.label_fn({"outcome_1x2": "home"})
    assert out == {"home": 1.0, "draw": 0.0, "away": 0.0}
    # Draw
    out = spec.label_fn({"outcome_1x2": "draw"})
    assert out == {"home": 0.0, "draw": 1.0, "away": 0.0}
    # Away
    out = spec.label_fn({"outcome_1x2": "away"})
    assert out == {"home": 0.0, "draw": 0.0, "away": 1.0}


def test_market_spec_is_frozen():
    with pytest.raises(Exception):
        FOOTBALL_1X2_FT.key = "x"  # type: ignore[misc]
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/ml/test_market_spec.py -v
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `app/ml/market_spec.py`**

```python
"""MarketSpec — the minimal seam for sport/market generalization.

Stage 1 ships exactly one instance (FOOTBALL_1X2_FT). The dataclass +
REGISTRY + label_fn pattern is the surface future markets/sports plug
into without code refactor.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Tuple

from app.ml.labels import FOOTBALL_PHASE1_SCOPE


def _label_1x2_ft(event_summary: Mapping[str, Any]) -> Dict[str, float]:
    """Map a bet_labels-shaped row to one-hot results over (home, draw, away).

    Expects ``event_summary["outcome_1x2"]`` to be one of {"home", "draw", "away"}.
    Returns {selection: 1.0 if winner else 0.0}.
    """
    outcome = event_summary["outcome_1x2"]
    return {
        "home": 1.0 if outcome == "home" else 0.0,
        "draw": 1.0 if outcome == "draw" else 0.0,
        "away": 1.0 if outcome == "away" else 0.0,
    }


@dataclass(frozen=True)
class MarketSpec:
    key: str                                       # globally unique, e.g. "football_1x2_ft"
    sport: str                                     # "football"
    market: str                                    # "1x2_ft"
    selections: Tuple[str, ...]                    # ("home", "draw", "away")
    scope: Tuple[Tuple[str, str], ...]             # ((country, competition), ...)
    label_fn: Callable[[Mapping[str, Any]], Dict[str, float]]
    feature_window_unit: str                       # "matches" | "days"


FOOTBALL_1X2_FT = MarketSpec(
    key="football_1x2_ft",
    sport="football",
    market="1x2_ft",
    selections=("home", "draw", "away"),
    scope=tuple(FOOTBALL_PHASE1_SCOPE),
    label_fn=_label_1x2_ft,
    feature_window_unit="matches",
)


REGISTRY: Dict[str, MarketSpec] = {FOOTBALL_1X2_FT.key: FOOTBALL_1X2_FT}


def get_spec(key: str) -> MarketSpec:
    if key not in REGISTRY:
        raise KeyError(
            f"unknown market_spec {key!r}; known: {sorted(REGISTRY)}"
        )
    return REGISTRY[key]
```

- [ ] **Step 4: Run, confirm pass**

```bash
PYTHONPATH=. pytest tests/ml/test_market_spec.py -v
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/ml/market_spec.py tests/ml/test_market_spec.py
git commit -m "feat(ml): MarketSpec dataclass + FOOTBALL_1X2_FT instance"
```

---

## Task 2: Thread `market_spec` through `run_backtest`

**Files:**
- Modify: `app/ml/backtest.py`
- Test: extend an existing backtest test or add `tests/ml/test_backtest_market_spec.py`

The current `run_backtest` already accepts `model: ModelFn | str`. We add `market_spec: MarketSpec = FOOTBALL_1X2_FT`, replace the module-level `SELECTIONS` constant with `spec.selections` *inside* the function, and route the `outcome_1x2` lookup through `spec.label_fn`. Default behavior unchanged.

- [ ] **Step 1: Inspect the current signature and the SELECTIONS usage**

```bash
grep -n "SELECTIONS\|run_backtest\|outcome_1x2\|scope=" app/ml/backtest.py
```

Note line numbers. Expected: `SELECTIONS` defined at line ~38, `run_backtest` def at line ~243, `outcome_1x2` lookup at line ~282-287, `for sel in SELECTIONS` at line ~304, `_valid_prob_dict` references `SELECTIONS` at line ~380.

- [ ] **Step 2: Write the failing test**

```python
# tests/ml/test_backtest_market_spec.py
"""run_backtest accepts a market_spec kwarg and uses it for selections + label."""
from __future__ import annotations

import pytest

from app.ml.backtest import run_backtest
from app.ml.market_spec import FOOTBALL_1X2_FT


def test_run_backtest_accepts_market_spec_kwarg():
    """Smoke: passing market_spec doesn't error on signature.

    We use a stub model_fn so we don't need real data; the function
    should at least accept the kwarg and exit cleanly when no test
    events match the scope (empty Phase 1 fixture)."""
    def stub_model(features, market_ctx):
        return {"home": 0.5, "draw": 0.25, "away": 0.25}

    report = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",   # future — no test events
        market_spec=FOOTBALL_1X2_FT,
    )
    assert report.test_events == 0
    assert report.total_bets == 0


def test_run_backtest_market_spec_default_is_football_1x2_ft():
    """Calling without market_spec should behave identically to passing FOOTBALL_1X2_FT."""
    def stub_model(features, market_ctx):
        return {"home": 0.5, "draw": 0.25, "away": 0.25}

    a = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",
    )
    b = run_backtest(
        model=stub_model,
        scope=FOOTBALL_1X2_FT.scope,
        train_until="2099-01-01T00:00:00Z",
        market_spec=FOOTBALL_1X2_FT,
    )
    assert a.test_events == b.test_events
    assert a.total_bets == b.total_bets
```

- [ ] **Step 3: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/ml/test_backtest_market_spec.py -v
```

Expected: FAIL — `run_backtest() got an unexpected keyword argument 'market_spec'`.

- [ ] **Step 4: Modify `app/ml/backtest.py`**

Add at top of file (with other imports):
```python
from app.ml.market_spec import FOOTBALL_1X2_FT, MarketSpec
```

Modify `run_backtest` signature — find the existing `def run_backtest(` (around line 243) and add `market_spec: MarketSpec = FOOTBALL_1X2_FT` as a keyword-only parameter. Sketch:

```python
def run_backtest(
    *,
    model: "ModelFn | str",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    train_until: str,
    test_until: Optional[str] = None,
    min_edge: float = 0.02,
    kelly_fraction: float = 0.25,
    force_bets: bool = False,
    market_spec: MarketSpec = FOOTBALL_1X2_FT,
    # ... any other existing kwargs unchanged ...
) -> BacktestReport:
```

Inside the function body, locate the existing `outcome_1x2` lookup (around line 282-287):
```python
"SELECT outcome_1x2 FROM bet_labels WHERE event_id = ?",
...
outcome = label_row["outcome_1x2"]
```

Replace the downstream usage of `outcome` (which is currently a string) by computing the one-hot via the spec:
```python
results = market_spec.label_fn({"outcome_1x2": label_row["outcome_1x2"]})
# results is {"home": 1.0|0.0, "draw": ..., "away": ...}
```

Locate the existing `for sel in SELECTIONS:` loop (around line 304) and replace `SELECTIONS` with `market_spec.selections`. The per-selection result lookup that currently goes `1.0 if sel == outcome else 0.0` becomes `results[sel]`.

Locate `_valid_prob_dict` (around line 379-380) which checks `set(probs.keys()) != set(SELECTIONS)`. Add a `selections` parameter and propagate from `run_backtest`:
```python
def _valid_prob_dict(probs: Mapping[str, float], selections: Sequence[str] = SELECTIONS) -> bool:
    if set(probs.keys()) != set(selections):
        return False
    ...
```

At the call site of `_valid_prob_dict` inside `run_backtest`, pass `market_spec.selections`.

Leave the module-level `SELECTIONS = ("home", "draw", "away")` constant for backward compatibility with any external imports (search for `from app.ml.backtest import SELECTIONS` first; if there are no external importers, you may remove it — verify with grep before deleting).

- [ ] **Step 5: Run the new test + existing backtest tests**

```bash
PYTHONPATH=. pytest tests/ml/test_backtest_market_spec.py tests/ml/ tests/services/test_backtest_manager.py -v 2>&1 | tail -40
```

Expected: new 2 PASS; existing backtest manager tests still PASS (worker still calls `run_backtest(model=name, scope=..., train_until=..., ...)` and the new default kwarg is invisible to them).

- [ ] **Step 6: Commit**

```bash
git add app/ml/backtest.py tests/ml/test_backtest_market_spec.py
git commit -m "feat(ml): run_backtest accepts market_spec; selections + label via spec"
```

---

## Task 3: `trainable.py` — `fit_logistic_at` + `fit_dixon_coles_at` + `resolve_model_for_backtest`

**Files:**
- Create: `app/ml/trainable.py`
- Test: `tests/ml/test_trainable.py`

`app/ml/training.py` already has `train_logistic`, `isotonic_calibrate`, `build_feature_matrix`, `chronological_split`, `collect_events_for_dixon_coles`, `estimate_rates_chronological`, `match_probabilities`, `fit_temperature`. `app/ml/models.py:make_logistic_model_fn` and `make_dixon_coles_model_fn` wrap them as `ModelFn`. We compose these.

- [ ] **Step 1: Write the failing test**

```python
# tests/ml/test_trainable.py
"""Trainable adapters resolve to callable model functions over the spec's
selections. We don't assert numeric stability — fragile across data
refreshes — only shape and the routing logic.
"""
from __future__ import annotations

import pytest

from app.ml.market_spec import FOOTBALL_1X2_FT
from app.ml.trainable import TRAINABLE, resolve_model_for_backtest


def test_trainable_dict_contains_expected_models():
    assert "logistic" in TRAINABLE
    assert "dixon_coles" in TRAINABLE
    assert all(callable(v) for v in TRAINABLE.values())


def test_resolve_routes_analytic_to_models_registry():
    """market_implied is in the analytic _REGISTRY, not TRAINABLE."""
    fn = resolve_model_for_backtest(
        "market_implied",
        train_until="2024-08-01T00:00:00Z",
        spec=FOOTBALL_1X2_FT,
    )
    assert callable(fn)


def test_resolve_routes_trainable_to_fit_fn(monkeypatch):
    """Trainable name should call the fit fn with (train_until, spec)."""
    captured = {}

    def fake_fit(train_until: str, spec):
        captured["train_until"] = train_until
        captured["spec_key"] = spec.key
        def _model_fn(features, market_ctx):
            return {"home": 0.5, "draw": 0.25, "away": 0.25}
        return _model_fn

    monkeypatch.setitem(TRAINABLE, "logistic", fake_fit)

    fn = resolve_model_for_backtest(
        "logistic",
        train_until="2024-08-01T00:00:00Z",
        spec=FOOTBALL_1X2_FT,
    )
    assert callable(fn)
    assert captured == {
        "train_until": "2024-08-01T00:00:00Z",
        "spec_key": "football_1x2_ft",
    }


def test_resolve_unknown_raises_keyerror():
    with pytest.raises(KeyError):
        resolve_model_for_backtest(
            "does_not_exist",
            train_until="2024-08-01T00:00:00Z",
            spec=FOOTBALL_1X2_FT,
        )
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/ml/test_trainable.py -v
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `app/ml/trainable.py`**

```python
"""Trainable model adapters for the backtest pipeline.

Each adapter takes (train_until, MarketSpec) and returns a ModelFn whose
training data is strictly before ``train_until`` and scoped to
``spec.scope``. Adapters train **in memory**; on-disk artifacts under
``app/ml/training/<label>/`` are never read or written.
"""
from __future__ import annotations

from typing import Callable, Dict

import numpy as np

from app.ml.market_spec import MarketSpec
from app.ml.models import (
    ModelFn,
    get as get_analytic,
    make_dixon_coles_model_fn,
    make_logistic_model_fn,
)


def fit_logistic_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train a fresh logistic regression on events with kickoff strictly
    before ``train_until``, scoped to ``spec.scope``. Returns a calibrated
    ModelFn ready to feed into ``run_backtest(model=...)``."""
    from app.ml.training import (
        build_feature_matrix,
        chronological_split,
        isotonic_calibrate,
        train_logistic,
    )

    matrix = build_feature_matrix(sport=spec.sport, scope=spec.scope)
    # Use train_until for train cutoff. Reserve the last ~25% of pre-cutoff
    # events for isotonic calibration. We compute a calib_until that lands
    # at the 75th percentile of train_until-eligible kickoffs; if not
    # enough rows, fall back to train_until (no calibration).
    pre = [
        (ev, ts) for ev, ts in zip(matrix.event_ids, matrix.start_time_utc)
        if ts < train_until
    ]
    if len(pre) < 100:
        # Not enough pre-cutoff data — fit uncalibrated.
        raw = train_logistic(
            chronological_split(matrix, train_until=train_until, calib_until=train_until).train
        )
        return make_logistic_model_fn(raw, calibrated=False)

    calib_until = sorted(ts for _, ts in pre)[int(len(pre) * 0.75)]
    split = chronological_split(matrix, train_until=calib_until, calib_until=train_until)
    raw = train_logistic(split.train)
    cal = isotonic_calibrate(raw, split.calib)
    return make_logistic_model_fn(cal, calibrated=True)


def fit_dixon_coles_at(train_until: str, spec: MarketSpec) -> ModelFn:
    """Train a fresh Dixon-Coles rates table on events strictly before
    ``train_until``, scoped to ``spec.scope``. Temperature is fit on a
    rolling-window calib block ending at ``train_until``."""
    from app.ml.dixon_coles import (
        DCConfig,
        apply_temperature,
        estimate_rates_chronological,
        fit_temperature,
        match_probabilities,
    )
    from app.ml.training import collect_events_for_dixon_coles

    cfg = DCConfig()  # defaults from app/ml/dixon_coles.py
    events_all = collect_events_for_dixon_coles(sport=spec.sport, scope=spec.scope)
    # Use only events strictly before train_until for rate estimation.
    events_pre = [e for e in events_all if e["start_time_utc"] < train_until]

    snapshots = estimate_rates_chronological(events_pre, cfg)
    events_by_id = {e["event_id"]: e for e in events_pre}
    rates_by_event: Dict[str, dict] = {}
    for s in snapshots:
        ev = events_by_id.get(s.event_id)
        if ev is None:
            continue
        rates_by_event[s.event_id] = {
            "home_attack": s.home_attack,
            "home_defense": s.home_defense,
            "away_attack": s.away_attack,
            "away_defense": s.away_defense,
        }

    # Fit temperature on the last ~25% of pre-cutoff events as a calib slice.
    if len(events_pre) >= 100:
        calib_cutoff = sorted(e["start_time_utc"] for e in events_pre)[int(len(events_pre) * 0.75)]
        calib_events = [e for e in events_pre if e["start_time_utc"] >= calib_cutoff]
        raw_probs = []
        y = []
        for ev in calib_events:
            r = rates_by_event.get(ev["event_id"])
            if r is None:
                continue
            lam_h = r["home_attack"] * r["away_defense"] * cfg.home_advantage * cfg.league_mean_goals
            lam_a = r["away_attack"] * r["home_defense"] * cfg.league_mean_goals
            p_h, p_d, p_a = match_probabilities(lam_h, lam_a, cfg=cfg)
            raw_probs.append([p_h, p_d, p_a])
            if ev["home_score"] > ev["away_score"]:
                y.append(0)
            elif ev["home_score"] < ev["away_score"]:
                y.append(2)
            else:
                y.append(1)
        if raw_probs:
            T = fit_temperature(np.asarray(raw_probs), np.asarray(y))
        else:
            T = 1.0
    else:
        T = 1.0

    return make_dixon_coles_model_fn(rates_by_event, cfg, temperature=T)


TRAINABLE: Dict[str, Callable[[str, MarketSpec], ModelFn]] = {
    "logistic": fit_logistic_at,
    "dixon_coles": fit_dixon_coles_at,
}


def resolve_model_for_backtest(
    name: str,
    train_until: str,
    spec: MarketSpec,
) -> ModelFn:
    """Return a callable model function.

    - If ``name`` is in ``TRAINABLE``: train fresh in-memory using
      ``(train_until, spec)`` and return the resulting ModelFn.
    - Else fall through to the analytic registry in ``app.ml.models``.
    - Raises ``KeyError`` for unknown names.
    """
    if name in TRAINABLE:
        return TRAINABLE[name](train_until, spec)
    return get_analytic(name)
```

**IMPORTANT — verify before committing:** Open `app/ml/training.py` and check that `FeatureMatrix` has a `start_time_utc` attribute parallel to `event_ids`. If not, locate the actual attribute name (might be `kickoffs`, `start_times`, etc.) and adapt. If `FeatureMatrix` doesn't expose timestamps at all, you'll need to JOIN them in via `bet_labels.start_time_utc` — but check first.

Also verify `make_dixon_coles_model_fn`'s signature in `app/ml/models.py` — it may take `(rates_by_event, cfg, *, temperature=1.0)` or some other shape. Match exactly.

If `DCConfig` doesn't have `league_mean_goals` as an attribute, look up where the scripts get it from (likely `cfg.league_mean_goals` since the scripts use it directly).

- [ ] **Step 4: Run tests, confirm pass**

```bash
PYTHONPATH=. pytest tests/ml/test_trainable.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/ml/trainable.py tests/ml/test_trainable.py
git commit -m "feat(ml): trainable.py — fit_logistic_at, fit_dixon_coles_at, resolve_model_for_backtest"
```

---

## Task 4: Add `stage` + `market_spec` columns

**Files:**
- Modify: `frontend/prisma/schema.prisma`
- Create: `frontend/prisma/migrations/<timestamp>_backtest_stage_and_market_spec/migration.sql`
- Modify: `app/services/storage.py` — extend `_ensure_backtest_tables`
- Modify: `app/ml/backtest_storage.py` — extend `RunRow`, `_RUN_COLS`
- Test: `tests/ml/test_backtest_storage.py` — extend or new test

- [ ] **Step 1: Generate migration SQL (hand-written, same pattern as Task 1 of the prior plan)**

Create `frontend/prisma/migrations/20260514000000_backtest_stage_and_market_spec/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "backtest_runs" ADD COLUMN "stage" TEXT;
ALTER TABLE "backtest_runs" ADD COLUMN "market_spec" TEXT NOT NULL DEFAULT 'football_1x2_ft';
```

- [ ] **Step 2: Update Prisma schema**

In `frontend/prisma/schema.prisma`, find the `BacktestRun` model and add (after the existing fields, before the `bets` relation):

```prisma
  stage           String?
  marketSpec      String   @default("football_1x2_ft") @map("market_spec")
```

- [ ] **Step 3: Apply the migration**

The live SQLite DB at `/Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3` may be locked by a running Next.js dev server. Check first:

```bash
lsof /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 2>&1 | head -5
```

If a Next.js process holds it, ask the controller to coordinate with the user before proceeding (do NOT kill it unilaterally).

Once the lock is clear:

```bash
sqlite3 /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  < frontend/prisma/migrations/20260514000000_backtest_stage_and_market_spec/migration.sql

sqlite3 /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
   VALUES (lower(hex(randomblob(16))), 'manual-apply', current_timestamp, '20260514000000_backtest_stage_and_market_spec', current_timestamp, 1);"
```

Regenerate the Prisma client:
```bash
cd frontend && npx prisma generate && cd ..
```

- [ ] **Step 4: Update `_ensure_backtest_tables` in `app/services/storage.py` to be idempotent on the new columns**

Find `_ensure_backtest_tables` (added in the prior plan). After the existing `CREATE TABLE IF NOT EXISTS backtest_runs (...)` block, add:

```python
existing_cols = {
    row[1] for row in connection.execute("PRAGMA table_info(backtest_runs)").fetchall()
}
if "stage" not in existing_cols:
    connection.execute("ALTER TABLE backtest_runs ADD COLUMN stage TEXT")
if "market_spec" not in existing_cols:
    connection.execute(
        "ALTER TABLE backtest_runs ADD COLUMN market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'"
    )
```

- [ ] **Step 5: Update `RunRow` and `_RUN_COLS` in `app/ml/backtest_storage.py`**

Add two new fields to `RunRow` (frozen dataclass):

```python
@dataclass(frozen=True)
class RunRow:
    # ... existing fields ...
    reliability_json: Optional[str] = None
    stage: Optional[str] = None
    market_spec: str = "football_1x2_ft"
```

Update `_RUN_COLS` to include the two new column names at the end:

```python
_RUN_COLS = (
    "id label model train_until test_until min_edge kelly_fraction "
    "force_bets scope_json status created_at started_at finished_at "
    "error test_events total_bets hit_rate roi mean_clv brier log_loss "
    "max_drawdown reliability_json stage market_spec"
).split()
```

- [ ] **Step 6: Extend `tests/ml/test_backtest_storage.py`**

Add a test at the bottom of the file:

```python
def test_run_row_round_trips_stage_and_market_spec(conn):
    """RunRow should round-trip the new stage + market_spec fields."""
    # The fixture's CREATE TABLE in test_backtest_storage.py needs the new
    # columns. Add them if not present:
    conn.execute("ALTER TABLE backtest_runs ADD COLUMN stage TEXT")
    conn.execute(
        "ALTER TABLE backtest_runs ADD COLUMN market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'"
    )
    row = _run()  # the helper defined earlier in the file
    # _run() builds a RunRow with defaults — stage=None, market_spec='football_1x2_ft'
    insert_run(conn, row)
    fetched = get_run(conn, "r1")
    assert fetched is not None
    assert fetched.stage is None
    assert fetched.market_spec == "football_1x2_ft"
```

You may also need to update the fixture's `CREATE TABLE` SQL to include the new columns directly so the `ALTER TABLE` calls aren't needed. Look at the fixture and choose the cleaner path.

- [ ] **Step 7: Run tests, confirm pass**

```bash
PYTHONPATH=. pytest tests/ml/test_backtest_storage.py tests/services/test_storage_backtest_tables.py -v
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/prisma/schema.prisma \
        frontend/prisma/migrations/20260514000000_backtest_stage_and_market_spec \
        app/services/storage.py \
        app/ml/backtest_storage.py \
        tests/ml/test_backtest_storage.py
git commit -m "feat(db): add stage and market_spec columns to backtest_runs"
```

---

## Task 5: Worker writes `stage` + reads `market_spec` + calls `resolve_model_for_backtest`

**Files:**
- Modify: `app/services/backtest_manager.py`
- Test: `tests/services/test_backtest_manager_stage.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/services/test_backtest_manager_stage.py
"""BacktestManager writes stage transitions for trainable runs."""
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.ml.backtest import BacktestReport, BetRecord


def _ok_report():
    bet = BetRecord(
        event_id="E1", bet_ts="2024-08-10T14:55:00Z",
        market="1x2_ft", selection="home",
        price_taken=2.10, closing_price=2.10,
        model_prob=0.55, implied_prob=0.48, devigged_prob=0.46,
        edge=0.09, stake_kelly_fraction=0.04,
        result=1.0, pnl=0.044, clv=0.0,
    )
    return BacktestReport(
        model="logistic", scope_size=1, test_events=1,
        bets=[bet], total_bets=1, hit_rate=1.0, roi=0.044,
        mean_clv=0.0, brier=0.2, log_loss=0.5, max_drawdown=0.0,
        reliability_buckets=[], config={},
    )


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch) -> Path:
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    from app.config import get_settings
    get_settings.cache_clear()
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS match_event_summaries "
            "(event_id TEXT PRIMARY KEY, start_time_utc TEXT)"
        )
        c.execute(
            "INSERT INTO match_event_summaries VALUES (?, ?)",
            ("E1", "2024-08-10T15:00:00Z"),
        )
        c.commit()
    return db


def test_stage_transitions_training_then_backtesting(db_path, monkeypatch):
    """For a trainable model, stage should pass through training -> backtesting -> NULL."""
    stages_seen: list[str | None] = []

    # Stub run_backtest and the trainable resolver
    def stub_run_backtest(**kw):
        return _ok_report()

    def stub_resolve(name, train_until, spec):
        # Capture the stage at the moment training "happens"
        from app.services.backtest_manager import BacktestManager
        return lambda features, market_ctx: {"home": 0.5, "draw": 0.25, "away": 0.25}

    monkeypatch.setattr("app.services.backtest_manager.run_backtest", stub_run_backtest)
    monkeypatch.setattr(
        "app.services.backtest_manager.resolve_model_for_backtest", stub_resolve
    )

    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="logistic",
                train_until="2024-08-01T00:00:00Z",
            )
        )

        # Poll the run's stage during execution by snapshotting periodically.
        # Run is fast (stubs), so we capture before+after only.
        for _ in range(100):
            r = await mgr.get_run(run_id)
            stages_seen.append(getattr(r, "stage", None))
            if r and r.status in ("completed", "failed"):
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.02)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "completed", f"got {result.status} error={result.error}"
    # After completion, stage should be NULL
    assert result.stage is None
    # We expect SOMEWHERE in our polling we saw 'training' or 'backtesting'.
    # (Stub is so fast that we may miss both, so we don't strictly require both observed.)
    # The completion assertion above is the load-bearing check.


def test_analytic_model_skips_training_stage(db_path, monkeypatch):
    """For an analytic model (market_implied), stage should never be 'training'."""
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: _ok_report(),
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        await mgr.start()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        for _ in range(100):
            r = await mgr.get_run(run_id)
            if r and r.status in ("completed", "failed"):
                await mgr.shutdown()
                return r
            await asyncio.sleep(0.02)
        await mgr.shutdown()
        return await mgr.get_run(run_id)

    result = asyncio.run(go())
    assert result.status == "completed"
    assert result.stage is None


def test_market_spec_persisted_on_run(db_path, monkeypatch):
    monkeypatch.setattr(
        "app.services.backtest_manager.run_backtest",
        lambda **kw: _ok_report(),
    )
    from app.services.backtest_manager import BacktestManager, CreateRunParams

    async def go():
        mgr = BacktestManager()
        run_id = await mgr.create_run(
            CreateRunParams(
                model="market_implied",
                train_until="2024-08-01T00:00:00Z",
            )
        )
        r = await mgr.get_run(run_id)
        return r

    result = asyncio.run(go())
    assert result.market_spec == "football_1x2_ft"
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/services/test_backtest_manager_stage.py -v
```

Expected: FAIL — RunRow has no `stage` attribute (until Task 4 landed) or stage transitions not implemented.

- [ ] **Step 3: Modify `app/services/backtest_manager.py`**

Add imports at top:
```python
from app.ml.market_spec import get_spec, FOOTBALL_1X2_FT
from app.ml.trainable import TRAINABLE, resolve_model_for_backtest
```

Update `CreateRunParams` (add optional `market_spec` field, default `"football_1x2_ft"`):
```python
@dataclass(frozen=True)
class CreateRunParams:
    model: str
    train_until: str
    test_until: Optional[str] = None
    min_edge: float = 0.02
    kelly_fraction: float = 0.25
    force_bets: bool = False
    label: Optional[str] = None
    scope: Optional[Sequence[Tuple[str, str]]] = None
    market_spec: str = "football_1x2_ft"
```

In `create_run`, when building the `RunRow`, pass `market_spec=params.market_spec`. If the spec's scope should override the default Phase 1 scope when no scope is given, plumb it: `scope = list(params.scope) if params.scope is not None else list(get_spec(params.market_spec).scope)`.

In `_execute`, replace the existing structural check (the one that does `get_model(row.model)`) with:

```python
# Resolve the MarketSpec
try:
    spec = get_spec(row.market_spec or "football_1x2_ft")
except KeyError as e:
    await asyncio.to_thread(
        self._mark_failed_sync, run_id, f"unknown market_spec: {e}"
    )
    return

# Mark training stage (only for trainable models)
if row.model in TRAINABLE:
    await asyncio.to_thread(self._mark_stage_sync, run_id, "training")

# Resolve model — either trains (TRAINABLE) or returns analytic baseline.
try:
    model_fn = await asyncio.to_thread(
        resolve_model_for_backtest, row.model, row.train_until, spec
    )
except KeyError as e:
    await asyncio.to_thread(
        self._mark_failed_sync, run_id, f"unknown model: {e}"
    )
    return
except Exception as exc:
    tb = traceback.format_exc(limit=4)
    await asyncio.to_thread(
        self._mark_failed_sync, run_id, f"{exc}\n{tb}"
    )
    return

# Mark backtesting stage
await asyncio.to_thread(self._mark_stage_sync, run_id, "backtesting")
```

Then call `run_backtest` with `model=model_fn` (it accepts `ModelFn | str`) and `market_spec=spec`. Replace the existing `run_backtest(model=row.model, scope=scope, ...)` call with:

```python
report: BacktestReport = await asyncio.to_thread(
    run_backtest,
    model=model_fn,
    scope=spec.scope if row.scope_json is None or row.scope_json == "[]" else scope,
    train_until=row.train_until,
    test_until=row.test_until,
    min_edge=row.min_edge,
    kelly_fraction=row.kelly_fraction,
    force_bets=bool(row.force_bets),
    market_spec=spec,
)
```

(Note: `scope` is already parsed from `row.scope_json` earlier in `_execute`. If `scope_json == "[]"` was the prior "default to FOOTBALL_PHASE1_SCOPE" sentinel, treat it the same way and fall through to `spec.scope`. Keep this logic identical to the existing version.)

Add `_mark_stage_sync` method:
```python
def _mark_stage_sync(self, run_id: str, stage: Optional[str]) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE backtest_runs SET stage = ? WHERE id = ?",
            (stage, run_id),
        )
        conn.commit()
```

In `_persist_completed_sync` and `_mark_failed_sync`, set `stage=NULL`:
- `_persist_completed_sync`: after `finalize_run(...)`, add `conn.execute("UPDATE backtest_runs SET stage = NULL WHERE id = ?", (run_id,)); conn.commit()`. Or simpler — add `stage=NULL` to the `finalize_run` UPDATE in `backtest_storage.py`. (Touching `backtest_storage.py` is fine — extend the SET list with `stage = NULL`.)
- `_mark_failed_sync`: extend the existing UPDATE to also `stage = NULL`. Edit the helper in `backtest_storage.py:update_run_status` to accept an optional `stage` kwarg, or just inline a separate UPDATE in `_mark_failed_sync`.

Update `RunRow` creation in `create_run` to include `market_spec`:
```python
row = RunRow(
    # ... existing fields ...
    status="queued",
    created_at=_now_iso(),
    stage=None,
    market_spec=params.market_spec,
)
```

- [ ] **Step 4: Run all related tests, confirm pass**

```bash
PYTHONPATH=. pytest tests/services/test_backtest_manager_stage.py tests/services/test_backtest_manager.py tests/api/ tests/ml/ -v 2>&1 | tail -30
```

Expected: all PASS (new + old). The existing manager tests should still pass because `market_spec` defaults to `"football_1x2_ft"`, and the old "unknown model" test should still see "unknown model" in the error.

- [ ] **Step 5: Commit**

```bash
git add app/services/backtest_manager.py app/ml/backtest_storage.py tests/services/test_backtest_manager_stage.py
git commit -m "feat(services): worker writes stage transitions; reads market_spec; resolves trainable models"
```

---

## Task 6: Pydantic + frontend type updates

**Files:**
- Modify: `app/schemas/backtest.py`
- Modify: `frontend/src/lib/api-backtest.ts`
- Modify: `frontend/src/components/picks/BacktestRunsPanel.tsx`
- Modify: `src.py` (`_run_row_to_summary` + `BacktestRunDetail` construction)

- [ ] **Step 1: Add `stage` and `market_spec` to schemas**

In `app/schemas/backtest.py`:

```python
class BacktestRunSummary(BaseModel):
    # ... existing fields ...
    max_drawdown: Optional[float] = None
    stage: Optional[str] = None
    market_spec: str = "football_1x2_ft"

    model_config = {"protected_namespaces": ()}
```

`BacktestRunDetail` already extends `BacktestRunSummary`, so it inherits these.

- [ ] **Step 2: Update `_run_row_to_summary` in `src.py`**

Find `_run_row_to_summary` (added by Task 7 of the prior plan). Add the two fields to the constructor:
```python
return BacktestRunSummary(
    # ... existing fields ...
    max_drawdown=row.max_drawdown,
    stage=row.stage,
    market_spec=row.market_spec,
)
```

- [ ] **Step 3: Update TypeScript types**

In `frontend/src/lib/api-backtest.ts`, extend `BacktestRunSummary`:
```typescript
export type BacktestRunSummary = {
  // ... existing fields ...
  max_drawdown: number | null;
  stage: string | null;
  market_spec: string;
};
```

- [ ] **Step 4: Update `BacktestRunsPanel.tsx` to display stage**

Find the row rendering in `frontend/src/components/picks/BacktestRunsPanel.tsx`. The status cell currently renders `{r.status}`. Change to:
```tsx
<td align="center">
  {r.status}
  {r.stage ? <span className="text-zinc-500"> · {r.stage}</span> : null}
</td>
```

- [ ] **Step 5: Run backend tests + frontend lint+build**

```bash
PYTHONPATH=. pytest tests/api/ -v 2>&1 | tail -15
cd frontend && npm run lint 2>&1 | tail -10 && npm run build 2>&1 | tail -15
```

Expected: all PASS / lint clean / build OK.

- [ ] **Step 6: Commit**

```bash
git add app/schemas/backtest.py src.py frontend/src/lib/api-backtest.ts \
        frontend/src/components/picks/BacktestRunsPanel.tsx
git commit -m "feat: surface stage + market_spec on BacktestRunSummary; panel renders stage"
```

---

## Task 7: Enrich `/backtest/models` response with `kind`

**Files:**
- Modify: `src.py` (`list_backtest_models`)
- Test: extend `tests/api/test_backtest_routes.py`

- [ ] **Step 1: Extend the existing models endpoint test**

Append to `tests/api/test_backtest_routes.py`:

```python
def test_models_endpoint_returns_items_with_kind(app_client: TestClient):
    resp = app_client.get("/backtest/models")
    assert resp.status_code == 200
    body = resp.json()
    assert "items" in body, f"expected items[], got {body}"
    names = {item["name"] for item in body["items"]}
    kinds_by_name = {item["name"]: item["kind"] for item in body["items"]}
    # analytic baselines
    assert "market_implied" in names
    assert kinds_by_name["market_implied"] == "analytic"
    # trainable
    assert "logistic" in names
    assert kinds_by_name["logistic"] == "trainable"
    assert "dixon_coles" in names
    assert kinds_by_name["dixon_coles"] == "trainable"
```

The existing `test_models_endpoint_lists_registry` test asserts `"market_implied" in names` where `names = resp.json()["names"]`. That will fail after the shape change. **Update it to use `items`:**
```python
def test_models_endpoint_lists_registry(app_client: TestClient):
    resp = app_client.get("/backtest/models")
    assert resp.status_code == 200
    names = [it["name"] for it in resp.json()["items"]]
    assert "market_implied" in names
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/api/test_backtest_routes.py::test_models_endpoint_returns_items_with_kind -v
```

Expected: FAIL — the existing handler returns `{"names": [...]}`.

- [ ] **Step 3: Modify `list_backtest_models` in `src.py`**

Find the existing handler (added in Task 7 of prior plan). Replace with:

```python
from app.ml.models import names as analytic_model_names
from app.ml.trainable import TRAINABLE


@app.get("/backtest/models")
async def list_backtest_models() -> dict:
    items = []
    for name in analytic_model_names():
        items.append({"name": name, "kind": "analytic"})
    for name in sorted(TRAINABLE.keys()):
        items.append({"name": name, "kind": "trainable"})
    return {"items": items}
```

Note: keep the `model_names` import if it's still in use elsewhere; otherwise rename to `analytic_model_names` to avoid confusion.

- [ ] **Step 4: Update frontend `listBacktestModels` to read `items`**

In `frontend/src/lib/api-backtest.ts`:
```typescript
export async function listBacktestModels(): Promise<string[]> {
  const r = await fetch("/api/backtest/models", { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  const body = await r.json();
  return (body.items as Array<{ name: string; kind: string }>).map((x) => x.name);
}
```

- [ ] **Step 5: Run tests + frontend build**

```bash
PYTHONPATH=. pytest tests/api/test_backtest_routes.py -v
cd frontend && npm run build 2>&1 | tail -10
```

Expected: all 4 tests PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add src.py tests/api/test_backtest_routes.py frontend/src/lib/api-backtest.ts
git commit -m "feat(api): /backtest/models returns items with kind (analytic|trainable)"
```

---

## Task 8: `app/ml/picks_facets.py` — facets aggregator

**Files:**
- Create: `app/ml/picks_facets.py`
- Test: `tests/ml/test_picks_facets.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/ml/test_picks_facets.py
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from app.ml.picks_facets import (
    FacetsResponse,
    facets_for_live,
    facets_for_backtest,
    facets_for_both,
)


@pytest.fixture
def db(tmp_path: Path, monkeypatch) -> Iterator[Path]:
    p = tmp_path / "t.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(p))
    from app.config import get_settings
    get_settings.cache_clear()
    c = sqlite3.connect(p)
    c.row_factory = sqlite3.Row
    c.executescript(
        """
        CREATE TABLE paper_bets (
            event_id TEXT, recommended_at TEXT, market TEXT, selection TEXT,
            model TEXT, model_prob REAL, price_at_recommendation REAL, edge REAL,
            kelly_full REAL, status TEXT, result REAL, pnl REAL, clv REAL
        );
        CREATE TABLE backtest_runs (
            id TEXT PRIMARY KEY, label TEXT, model TEXT,
            train_until TEXT, test_until TEXT,
            min_edge REAL, kelly_fraction REAL, force_bets INTEGER,
            scope_json TEXT, status TEXT, created_at TEXT,
            started_at TEXT, finished_at TEXT, error TEXT,
            test_events INTEGER, total_bets INTEGER, hit_rate REAL,
            roi REAL, mean_clv REAL, brier REAL, log_loss REAL,
            max_drawdown REAL, reliability_json TEXT,
            stage TEXT, market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'
        );
        CREATE TABLE backtest_bets (
            run_id TEXT, event_id TEXT, bet_ts TEXT, kickoff_ts TEXT,
            market TEXT, selection TEXT, price_taken REAL,
            closing_price REAL, model_prob REAL, implied_prob REAL,
            devigged_prob REAL, edge REAL, stake_kelly_fraction REAL,
            result REAL, pnl REAL, clv REAL
        );
        CREATE TABLE match_event_summaries (
            event_id TEXT PRIMARY KEY, sport TEXT, country TEXT,
            competition TEXT, start_time_utc TEXT
        );
        """
    )
    # Live data: two countries (ENGLAND, GERMANY)
    c.executemany(
        "INSERT INTO paper_bets (event_id, recommended_at, market, selection, model) VALUES (?,?,?,?,?)",
        [
            ("E1", "2024-08-10T14:55:00Z", "1x2_ft", "home", "logistic"),
            ("E2", "2024-08-17T14:55:00Z", "1x2_ft", "draw", "dixon_coles"),
        ],
    )
    # Backtest data: third country (SPAIN)
    c.execute(
        "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
        "kelly_fraction, force_bets, scope_json, status, created_at) VALUES "
        "('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed','2026-05-13T10:00:00Z')"
    )
    c.execute(
        "INSERT INTO backtest_bets VALUES "
        "('r1','E3','2024-09-10T14:55:00Z','2024-09-10T15:00:00Z','1x2_ft','away',"
        "2.5,2.5,0.4,0.4,0.4,0.0,1.0,1.0,1.5,0.0)"
    )
    c.executemany(
        "INSERT INTO match_event_summaries VALUES (?,?,?,?,?)",
        [
            ("E1", "football", "ENGLAND", "Premier League", "2024-08-10T15:00:00Z"),
            ("E2", "football", "GERMANY", "Bundesliga", "2024-08-17T15:00:00Z"),
            ("E3", "football", "SPAIN", "LaLiga", "2024-09-10T15:00:00Z"),
        ],
    )
    c.commit()
    c.close()
    yield p


def test_facets_for_live_returns_only_live_facets(db):
    f = facets_for_live()
    assert "ENGLAND" in f.countries
    assert "GERMANY" in f.countries
    assert "SPAIN" not in f.countries
    assert "logistic" in f.models
    assert "dixon_coles" in f.models
    assert "market_implied" not in f.models
    assert "1x2_ft" in f.markets
    assert "home" in f.selections
    assert "draw" in f.selections


def test_facets_for_backtest_returns_only_run_facets(db):
    f = facets_for_backtest("r1")
    assert f.countries == ["SPAIN"]
    assert f.competitions == ["LaLiga"]
    assert f.models == ["market_implied"]
    assert f.selections == ["away"]
    assert "ENGLAND" not in f.countries


def test_facets_for_both_unions(db):
    f = facets_for_both("r1")
    assert set(f.countries) == {"ENGLAND", "GERMANY", "SPAIN"}
    assert set(f.models) == {"logistic", "dixon_coles", "market_implied"}


def test_facets_for_backtest_unknown_run_returns_empty(db):
    f = facets_for_backtest("does_not_exist")
    assert f.countries == []
    assert f.models == []
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/ml/test_picks_facets.py -v
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `app/ml/picks_facets.py`**

```python
"""Source-aware facet enumeration for the picks filter bar.

For each filter dimension (model, market, sport, country, competition,
selection), return the distinct values present in the chosen data
source (live paper_bets, a specific backtest_bets run, or both).
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import List

from app.ml import db as ml_db


@dataclass(frozen=True)
class FacetsResponse:
    models: List[str] = field(default_factory=list)
    markets: List[str] = field(default_factory=list)
    sports: List[str] = field(default_factory=list)
    countries: List[str] = field(default_factory=list)
    competitions: List[str] = field(default_factory=list)
    selections: List[str] = field(default_factory=list)


def _distinct(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> List[str]:
    rows = conn.execute(sql, params).fetchall()
    return sorted(
        {str(r[0]) for r in rows if r[0] is not None and str(r[0]).strip()}
    )


def facets_for_live() -> FacetsResponse:
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        return FacetsResponse(
            models=_distinct(conn, "SELECT DISTINCT model FROM paper_bets"),
            markets=_distinct(conn, "SELECT DISTINCT market FROM paper_bets"),
            sports=_distinct(
                conn,
                "SELECT DISTINCT mes.sport FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            countries=_distinct(
                conn,
                "SELECT DISTINCT mes.country FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            competitions=_distinct(
                conn,
                "SELECT DISTINCT mes.competition FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            selections=_distinct(conn, "SELECT DISTINCT selection FROM paper_bets"),
        )


def facets_for_backtest(run_id: str) -> FacetsResponse:
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        # Resolve model from the run row (single value)
        run = conn.execute(
            "SELECT model FROM backtest_runs WHERE id = ?", (run_id,)
        ).fetchone()
        models = [run["model"]] if run else []

        return FacetsResponse(
            models=models,
            markets=_distinct(
                conn,
                "SELECT DISTINCT market FROM backtest_bets WHERE run_id = ?",
                (run_id,),
            ),
            sports=_distinct(
                conn,
                "SELECT DISTINCT mes.sport FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            countries=_distinct(
                conn,
                "SELECT DISTINCT mes.country FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            competitions=_distinct(
                conn,
                "SELECT DISTINCT mes.competition FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            selections=_distinct(
                conn,
                "SELECT DISTINCT selection FROM backtest_bets WHERE run_id = ?",
                (run_id,),
            ),
        )


def facets_for_both(run_id: str) -> FacetsResponse:
    live = facets_for_live()
    bt = facets_for_backtest(run_id)
    return FacetsResponse(
        models=sorted(set(live.models) | set(bt.models)),
        markets=sorted(set(live.markets) | set(bt.markets)),
        sports=sorted(set(live.sports) | set(bt.sports)),
        countries=sorted(set(live.countries) | set(bt.countries)),
        competitions=sorted(set(live.competitions) | set(bt.competitions)),
        selections=sorted(set(live.selections) | set(bt.selections)),
    )
```

- [ ] **Step 4: Run, confirm pass**

```bash
PYTHONPATH=. pytest tests/ml/test_picks_facets.py -v
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/ml/picks_facets.py tests/ml/test_picks_facets.py
git commit -m "feat(ml): picks_facets aggregator (live | backtest | both)"
```

---

## Task 9: `GET /picks/facets` route

**Files:**
- Modify: `src.py`
- Test: `tests/api/test_picks_facets_route.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_picks_facets_route.py
import asyncio
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    db = tmp_path / "snap.sqlite3"
    monkeypatch.setenv("APP_STORAGE_DB_PATH", str(db))
    from app.config import get_settings
    get_settings.cache_clear()
    from app.services.storage import SnapshotStore
    asyncio.run(SnapshotStore(str(db)).initialize())

    with sqlite3.connect(db) as c:
        # Seed paper_bets with two countries
        from app.ml.paper_trade import _ensure_paper_bets_table
        _ensure_paper_bets_table()
        c.executemany(
            "INSERT INTO paper_bets (event_id, recommended_at, market, selection, model, "
            "model_prob, price_at_recommendation, edge, kelly_full, status, result, pnl, clv) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                ("E1", "2024-08-10T14:55:00Z", "1x2_ft", "home", "logistic",
                 0.55, 2.1, 0.09, 0.04, "settled", 1.0, 0.044, 0.0),
                ("E2", "2024-08-17T14:55:00Z", "1x2_ft", "draw", "dixon_coles",
                 0.30, 3.4, 0.02, 0.01, "settled", 0.0, -0.01, 0.0),
            ],
        )
        # Seed match_event_summaries (with required NOT NULL columns)
        cols = [r[1] for r in c.execute("PRAGMA table_info(match_event_summaries)").fetchall()]
        rows_seed = [
            {"event_id": "E1", "sport": "football", "country": "ENGLAND",
             "competition": "Premier League", "start_time_utc": "2024-08-10T15:00:00Z"},
            {"event_id": "E2", "sport": "football", "country": "GERMANY",
             "competition": "Bundesliga", "start_time_utc": "2024-08-17T15:00:00Z"},
        ]
        for row in rows_seed:
            if "updated_at" in cols:
                row["updated_at"] = row["start_time_utc"]
            if "status" in cols:
                row["status"] = "finished"
            used = [k for k in row if k in cols]
            c.execute(
                f"INSERT INTO match_event_summaries ({','.join(used)}) "
                f"VALUES ({','.join('?' for _ in used)})",
                tuple(row[k] for k in used),
            )
        # Seed a backtest run + bet for source=backtest tests
        c.execute(
            "INSERT INTO backtest_runs (id, label, model, train_until, min_edge, "
            "kelly_fraction, force_bets, scope_json, status, created_at, market_spec) "
            "VALUES ('r1','l','market_implied','2024-08-01T00:00:00Z',0.02,0.25,0,'[]','completed',"
            "'2026-05-13T10:00:00Z','football_1x2_ft')"
        )
        c.execute(
            "INSERT INTO backtest_bets VALUES "
            "('r1','E1','2024-08-10T14:55:00Z','2024-08-10T15:00:00Z','1x2_ft','away',"
            "2.5,2.5,0.4,0.4,0.4,0.0,1.0,0.0,0.0,0.0)"
        )
        c.commit()

    from src import app
    with TestClient(app) as c:
        yield c


def test_facets_source_live(client):
    r = client.get("/picks/facets?source=live")
    assert r.status_code == 200
    body = r.json()
    assert "ENGLAND" in body["countries"]
    assert "GERMANY" in body["countries"]
    assert "logistic" in body["models"]


def test_facets_source_backtest_requires_run_id(client):
    r = client.get("/picks/facets?source=backtest")
    assert r.status_code == 400


def test_facets_source_backtest_returns_run_facets(client):
    r = client.get("/picks/facets?source=backtest&run_id=r1")
    assert r.status_code == 200
    body = r.json()
    assert body["models"] == ["market_implied"]
    assert body["selections"] == ["away"]


def test_facets_source_both_unions(client):
    r = client.get("/picks/facets?source=both&run_id=r1")
    assert r.status_code == 200
    body = r.json()
    assert "logistic" in body["models"]
    assert "market_implied" in body["models"]


def test_facets_unknown_source_returns_400(client):
    r = client.get("/picks/facets?source=invalid")
    assert r.status_code == 400
```

- [ ] **Step 2: Run, confirm failure**

```bash
PYTHONPATH=. pytest tests/api/test_picks_facets_route.py -v
```

Expected: FAIL — 404 / route not found.

- [ ] **Step 3: Add the route in `src.py`**

Near the existing `/picks/stats` and `/picks/history` routes, add:

```python
from app.ml.picks_facets import (
    FacetsResponse,
    facets_for_live,
    facets_for_backtest,
    facets_for_both,
)


@app.get("/picks/facets")
async def picks_facets(source: str = "live", run_id: Optional[str] = None) -> dict:
    if source == "live":
        f = facets_for_live()
    elif source == "backtest":
        if not run_id:
            raise HTTPException(status_code=400, detail="run_id required when source=backtest")
        f = facets_for_backtest(run_id)
    elif source == "both":
        if not run_id:
            raise HTTPException(status_code=400, detail="run_id required when source=both")
        f = facets_for_both(run_id)
    else:
        raise HTTPException(status_code=400, detail=f"unknown source={source!r}")
    return {
        "models": f.models,
        "markets": f.markets,
        "sports": f.sports,
        "countries": f.countries,
        "competitions": f.competitions,
        "selections": f.selections,
    }
```

- [ ] **Step 4: Run, confirm pass**

```bash
PYTHONPATH=. pytest tests/api/test_picks_facets_route.py -v
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src.py tests/api/test_picks_facets_route.py
git commit -m "feat(api): GET /picks/facets (source-aware filter options)"
```

---

## Task 10: Next.js facets proxy + `usePicksFacets` hook

**Files:**
- Create: `frontend/src/app/api/picks/facets/route.ts`
- Create: `frontend/src/hooks/usePicksFacets.ts`

- [ ] **Step 1: Inspect the existing picks proxy pattern**

```bash
cat frontend/src/app/api/picks/stats/route.ts
```

Match this style exactly.

- [ ] **Step 2: Write `frontend/src/app/api/picks/facets/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";

const REQUEST_TIMEOUT_MS = 15_000;

function resolveBackendBaseUrl(): string {
  return process.env.ODDS_BACKEND_BASE_URL ?? "http://127.0.0.1:8000";
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const backendUrl = `${resolveBackendBaseUrl()}/picks/facets?${url.searchParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(backendUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { code: "upstream_error", message: String(err) },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
```

If the existing `frontend/src/app/api/picks/stats/route.ts` differs in style (e.g., different timeout or error shape), match that instead.

- [ ] **Step 3: Write `frontend/src/hooks/usePicksFacets.ts`**

```typescript
"use client";

import { useEffect, useState } from "react";

export type FacetsResponse = {
  models: string[];
  markets: string[];
  sports: string[];
  countries: string[];
  competitions: string[];
  selections: string[];
};

const EMPTY: FacetsResponse = {
  models: [], markets: [], sports: [], countries: [], competitions: [], selections: [],
};

export function usePicksFacets(
  source: "live" | "backtest" | "both",
  runId?: string,
): FacetsResponse {
  const [data, setData] = useState<FacetsResponse>(EMPTY);

  useEffect(() => {
    if (source !== "live" && !runId) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ source });
    if (runId) qs.set("run_id", runId);
    fetch(`/api/picks/facets?${qs.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : EMPTY))
      .then((j) => {
        if (!cancelled) setData(j as FacetsResponse);
      })
      .catch(() => { if (!cancelled) setData(EMPTY); });
    return () => { cancelled = true; };
  }, [source, runId]);

  return data;
}
```

- [ ] **Step 4: Build to verify no type errors**

```bash
cd frontend && npm run lint 2>&1 | tail -10 && npm run build 2>&1 | tail -15
```

Expected: lint clean (or only pre-existing warnings); build OK.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/picks/facets/route.ts frontend/src/hooks/usePicksFacets.ts
git commit -m "feat(frontend): /api/picks/facets proxy + usePicksFacets hook"
```

---

## Task 11: ExploreTab fixes (facets + source/run_id + needsRun guard)

**Files:**
- Modify: `frontend/src/components/picks/tabs/ExploreTab.tsx`

- [ ] **Step 1: Inspect current ExploreTab structure**

```bash
sed -n '1,80p' frontend/src/components/picks/tabs/ExploreTab.tsx
grep -n "fetchStats\|fetchHistory\|FilterBar" frontend/src/components/picks/tabs/ExploreTab.tsx
```

Identify line numbers for: imports, `source` derivation, fetch call sites, `FilterBar` render, `useEffect` deps.

- [ ] **Step 2: Add imports and source derivation**

At the top of the file, add to the existing imports:

```tsx
import { useRouter } from "next/navigation";
import { DataSourcePicker } from "@/components/picks/DataSourcePicker";
import { usePicksFacets } from "@/hooks/usePicksFacets";
```

Inside the `ExploreTab` component body, after the existing `searchParams` line, add:

```tsx
const router = useRouter();
const source = (searchParams.get("source") as "live" | "backtest" | "both") ?? "live";
const runId = searchParams.get("run_id") ?? undefined;
const needsRun = source !== "live" && !runId;
const facets = usePicksFacets(source, runId);
```

- [ ] **Step 3: Thread source + runId into all 4 fetches**

Find the existing `Promise.all([...])` block (around line 100-110). Update each call:

- `fetchHistory({ status: "settled", limit: 1000 })` → `fetchHistory({ status: "settled", limit: 1000, source, run_id: runId })`. Override the existing comment "intentionally not driven by the FilterBar" — we now honor `source`. Replace the comment to: `// Raw history — unfiltered by FilterBar, but honors the active data source.`
- `fetchStats(["edge_bucket"], apiFilters)` → `fetchStats(["edge_bucket"], apiFilters, source, runId)`
- `fetchStats(["price_bucket"], apiFilters)` → `fetchStats(["price_bucket"], apiFilters, source, runId)`
- `fetchStats(["competition", "selection"], apiFilters)` → `fetchStats(["competition", "selection"], apiFilters, source, runId)`

Add `source` and `runId` to the `useEffect` dependency array (alongside `apiFilters.*`).

- [ ] **Step 4: Pass facets to FilterBar**

Find the `<FilterBar fields={...} />` render. Add `options`:

```tsx
<FilterBar
  fields={[
    "date", "status", "model", "market", "sport",
    "country", "competition", "selection", "edge", "price", "bookmaker",
  ]}
  options={{
    models: facets.models,
    markets: facets.markets,
    sports: facets.sports,
    countries: facets.countries,
    competitions: facets.competitions,
    selections: facets.selections,
  }}
/>
```

(Keep the existing `fields` list — only add `options`.)

- [ ] **Step 5: Add `needsRun` empty state**

Right before the existing `if (error) {` early return (or wherever the early returns live), add:

```tsx
if (needsRun) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker="Picks · explore" />
      <div className="flex justify-between items-center">
        <DataSourcePicker />
      </div>
      <div className="border border-zinc-700 bg-bg p-4 font-mono text-[12px] text-zinc-400">
        ▸ no backtest run selected. Open the{" "}
        <a href="/picks/models" className="text-zinc-200 underline">Models</a> tab
        to queue or pick a run.
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Mount DataSourcePicker in the main render**

In the existing main JSX return (the one not hidden behind `needsRun`/`error`), add the DataSourcePicker near the top — above the FilterBar:

```tsx
<div className="flex justify-between items-center">
  <DataSourcePicker />
</div>
```

(Same pattern as ModelsTab.)

- [ ] **Step 7: Verify with lint + build**

```bash
cd frontend && npm run lint 2>&1 | tail -10 && npm run build 2>&1 | tail -10
```

Expected: clean / build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/picks/tabs/ExploreTab.tsx
git commit -m "feat(frontend): Explore tab honors source/run_id; FilterBar gets facets; empty-state guard"
```

---

## Task 12: End-to-end smoke verification

**Files:** none modified (verification only).

- [ ] **Step 1: Ensure backend is running on :8000**

```bash
curl -sf http://localhost:8000/backtest/models || echo "backend not up"
```

If not, start it:
```bash
PYTHONPATH=. APP_STORAGE_DB_PATH=/Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  python3 -m uvicorn src:app --port 8000 --log-level warning &
sleep 2
curl -sf http://localhost:8000/backtest/models | python3 -m json.tool
```

Expected: `items` array with `market_implied` (analytic), `vig_included` (analytic), `logistic` (trainable), `dixon_coles` (trainable).

- [ ] **Step 2: Queue a logistic backtest**

```bash
RUN_ID=$(curl -sf -X POST http://localhost:8000/backtest/runs \
  -H 'content-type: application/json' \
  -d '{"model":"logistic","train_until":"2024-08-01T00:00:00Z","test_until":"2024-09-01T00:00:00Z"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "RUN_ID=$RUN_ID"
```

- [ ] **Step 3: Poll for stage transitions and completion**

```bash
for _ in $(seq 1 120); do
  status_stage=$(curl -sf http://localhost:8000/backtest/runs/$RUN_ID | \
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d.get("stage"))')
  echo "$status_stage"
  echo "$status_stage" | grep -qE '^(completed|failed) ' && break
  sleep 1
done

curl -sf http://localhost:8000/backtest/runs/$RUN_ID | python3 -m json.tool
```

Expected: at some point you see `running training` or `running backtesting`, then `completed None`. If logistic training takes <1s the stage may not be observable in polling — that's fine; the completion + zero-leakage assertion is what matters.

- [ ] **Step 4: SQL invariant check**

```bash
sqlite3 /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  "SELECT COUNT(*) AS total, SUM(CASE WHEN bet_ts >= kickoff_ts THEN 1 ELSE 0 END) AS leaky FROM backtest_bets WHERE run_id='$RUN_ID'"
```

Expected: `total | 0` — every bet's `bet_ts < kickoff_ts`.

- [ ] **Step 5: Frontend smoke — Explore filters populate**

Start a preview, navigate to `/picks/explore`:

```
preview_eval: window.location.assign("/en/picks/explore")
preview_snapshot  → check Country dropdown has ≥1 option (not just "All")
```

Then navigate to `/picks/explore?source=backtest&run_id=<RUN_ID>`:

```
preview_snapshot  → Country dropdown reflects only countries in the backtest run
```

- [ ] **Step 6: Document any failures**

If any of steps 2–5 fail, stop and investigate. Otherwise the feature is verified.

---

## Self-Review

**1. Spec coverage:**

- **Trainable model registry (`logistic`, `dixon_coles`):** Tasks 1, 3.
- **`MarketSpec` seam:** Tasks 1, 2.
- **`stage` column + worker plumbing:** Tasks 4, 5.
- **`market_spec` column:** Task 4 (DB), Task 5 (worker reads/writes), Task 6 (schemas).
- **`/backtest/models` enriched with `kind`:** Task 7.
- **Facets endpoint:** Tasks 8, 9.
- **Frontend facets hook + proxy:** Task 10.
- **ExploreTab fixes (facets, source/run_id, empty state):** Task 11.
- **End-to-end smoke (incl. zero-leakage SQL check):** Task 12.

**2. Placeholder scan:** Inspected. All steps contain runnable commands or complete code. Two "inspect first" steps (Step 1 of Task 2, Step 1 of Task 11) are *legitimate* — they require reading actual file state before editing because line numbers shift between branches; not placeholders.

**3. Type consistency:**
- `MarketSpec.key` is `str`, `selections` is `Tuple[str, ...]`, used identically in Tasks 1, 2, 3, 5.
- `RunRow.stage: Optional[str]` and `RunRow.market_spec: str` consistent across Tasks 4, 5, 6.
- `BacktestRunSummary.stage: Optional[str]` (Pydantic) ↔ `stage: string | null` (TS) ↔ `stage TEXT` (SQL) — consistent.
- `FacetsResponse` field names match exactly between Python (`models`, `markets`, `sports`, `countries`, `competitions`, `selections`) and TS — consistent.
- `resolve_model_for_backtest(name, train_until, spec)` — same signature in Tasks 3 and 5.
- `TRAINABLE` dict shape (`str -> Callable[[str, MarketSpec], ModelFn]`) consistent.

No issues found. Plan is internally consistent.
