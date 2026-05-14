# Trainable model backtests, facets endpoint, ExploreTab fixes

**Status:** Draft
**Date:** 2026-05-14
**Branch:** `feat/model-backtest-retro-bets` (extending the in-flight Run-Backtest branch)
**Stage:** 1 of 3 in the larger "general pipeline" effort. Stages 2 (XGBoost + PCA) and 3 (second market / second sport) are separate brainstorms after this lands.

## Problem

Three distinct symptoms, one feature surface:

1. The backtest dropdown only exposes the two analytic baselines (`market_implied`, `vig_included`). The trained models that already power the live `/predict` endpoint and appear on the Models leaderboard — `logistic`, `dixon_coles` — cannot be backtested. The runtime registry (`app/ml/models.py:_REGISTRY`) doesn't contain them, and even if it did, using the on-disk artifact would leak (the artifact was trained on data overlapping the backtest test window).

2. The Explore tab's filter bar dropdowns (Model, Market, Sport, Country, Competition, Selection) all show only "All". `ExploreTab.tsx` passes `<FilterBar fields={...} />` but never passes the `options={...}` prop, so the bar has nothing to render.

3. `ExploreTab.tsx` doesn't read `source` or `run_id` from the URL. When the user switches to `source=backtest` on the Models tab and navigates to Explore, the Explore page silently falls back to live data.

## Goals

- Trainable models (`logistic`, `dixon_coles`) appear in the backtest dropdown and produce true walk-forward backtests with no leakage. Each run trains a fresh model at the chosen cutoff; existing on-disk artifacts are untouched.
- The Explore tab's filter dropdowns are populated with real options, sourced from the data currently selected (`source` + `run_id`).
- The Explore tab honors `source` and `run_id` exactly like the Models tab does.
- A minimal `MarketSpec` seam lands now (one dataclass, one instance, no plugin system), so Stage 3 becomes a config addition rather than a refactor.
- A `stage` column on `backtest_runs` so the UI shows `running · training` vs `running · backtesting` during long runs.

## Non-goals

- `hgb` model — exists in `train_hgb.py` but isn't on the dashboard. Trivial to add after this lands.
- "Use existing on-disk artifact" mode for backtests. Every backtest trains fresh.
- Cross-run caching of trained models keyed by `(name, train_until)`. Cheap to add later if it becomes painful.
- Progress percentage during training. The two-state `stage` column is enough.
- Stage 2 (XGBoost + PCA) and Stage 3 (second market, second sport). Separate brainstorms.
- A model-vs-sport routing system. The architectural premise (confirmed during brainstorming) is that one model serves one sport. `MarketSpec` carries the sport; models are paired with a spec, not multiplexed across sports.

## Architecture

### 1. `MarketSpec` — the minimal seam

New module `app/ml/market_spec.py`:

```python
from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple

@dataclass(frozen=True)
class MarketSpec:
    key: str                              # globally unique, e.g. "football_1x2_ft"
    sport: str                            # "football"
    market: str                           # "1x2_ft"
    selections: Tuple[str, ...]           # ("home", "draw", "away")
    scope: Tuple[Tuple[str, str], ...]    # ((country, competition), ...)
    label_fn: Callable[[Any], Dict[str, float]]  # event_summary -> {selection: 1.0/0.0}
    feature_window_unit: str              # "matches" | "days"

FOOTBALL_1X2_FT = MarketSpec(
    key="football_1x2_ft",
    sport="football",
    market="1x2_ft",
    selections=("home", "draw", "away"),
    scope=FOOTBALL_PHASE1_SCOPE,
    label_fn=_label_1x2_ft,
    feature_window_unit="matches",
)

REGISTRY: Dict[str, MarketSpec] = {FOOTBALL_1X2_FT.key: FOOTBALL_1X2_FT}

def get_spec(key: str) -> MarketSpec:
    if key not in REGISTRY:
        raise KeyError(f"unknown market_spec {key!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[key]
```

`_label_1x2_ft` extracts the existing 1X2 outcome logic from wherever it currently lives (likely `app/ml/labels.py` or inline in `run_backtest`). Identical behavior; just factored out so a future spec can supply its own `label_fn`.

**Threading points (all default to `FOOTBALL_1X2_FT` for back-compat):**

- `app/ml/backtest.py:run_backtest` gains `market_spec: MarketSpec = FOOTBALL_1X2_FT` keyword arg. The module-level `SELECTIONS = ("home", "draw", "away")` is replaced by `spec.selections` inside the function. Existing CLI (`scripts/run_backtest.py`) needs no change — it doesn't pass `market_spec`, the default applies.
- `BacktestManager._execute` reads `row.market_spec` from the DB (new column, default `"football_1x2_ft"`), resolves via `get_spec(...)`, passes to `run_backtest` and to the trainable adapter.
- Trainable adapters take `(train_until, spec)` so they know which `(sport, scope)` to fit on.

### 2. Trainable model registry

New module `app/ml/trainable.py`:

```python
from typing import Callable, Dict
from app.ml.market_spec import MarketSpec
from app.ml.models import ModelFn

# Each entry: (train_until_iso, spec) -> ModelFn
TRAINABLE: Dict[str, Callable[[str, MarketSpec], ModelFn]] = {
    "logistic": fit_logistic_at,
    "dixon_coles": fit_dixon_coles_at,
}

def resolve_model_for_backtest(
    name: str,
    train_until: str,
    spec: MarketSpec,
) -> ModelFn:
    """Return a callable model. Trains in-memory for trainable entries;
    falls through to the analytic registry for baselines."""
    if name in TRAINABLE:
        return TRAINABLE[name](train_until, spec)
    from app.ml.models import get as get_analytic
    return get_analytic(name)
```

`fit_logistic_at(train_until, spec)` factors out the in-memory training step from `scripts/train_logistic.py`:

1. Load Phase 1 events with `kickoff < train_until` AND `(country, competition) ∈ spec.scope`.
2. Compute features via `app.ml.features.get_features(event_id, as_of_ts=...)` for each.
3. Train using the same code the script uses (extract into a reusable function in `app/ml/training.py` if not already factored).
4. Wrap via `make_trained_model_fn(trained, calibrated=True, name_prefix="logistic")` (existing helper).
5. Return the `ModelFn`. **In-memory only; no disk writes; no touching of `app/ml/training/<label>/`.**

`fit_dixon_coles_at` mirrors the structure against `scripts/train_dixon_coles.py`.

**The existing `_REGISTRY` in `app/ml/models.py` is unchanged.** Analytic baselines (`market_implied`, `vig_included`) keep their direct path. Trainable names are visible only to the backtest pipeline through `TRAINABLE` — the live `/predict` path continues to use on-disk artifacts via `ServingModels`.

### 3. `stage` column

New column on `backtest_runs`:

```sql
ALTER TABLE backtest_runs ADD COLUMN stage TEXT;
ALTER TABLE backtest_runs ADD COLUMN market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft';
```

Mirrored in `frontend/prisma/schema.prisma` (`stage String?`, `marketSpec String @map("market_spec") @default("football_1x2_ft")`). `_ensure_backtest_tables` adds idempotent `ALTER TABLE` calls guarded by `PRAGMA table_info` checks (additive only, no destructive ops).

Worker writes:

- Before training (only when `name in TRAINABLE`): `UPDATE backtest_runs SET stage='training' WHERE id=?`
- Before `run_backtest`: `UPDATE backtest_runs SET stage='backtesting' WHERE id=?`
- On `finalize_run` and `_mark_failed_sync`: `stage` returns to NULL.

`BacktestRunSummary` (Pydantic + TypeScript) and `BacktestRunDetail` gain `stage: string | null`. `BacktestRunsPanel.tsx` renders `{r.status}{r.stage ? ` · ${r.stage}` : ""}` in the status cell.

### 4. `/backtest/models` enrichment

Today: `{"names": [...]}` over the analytic `_REGISTRY` only.

New shape:

```json
{
  "items": [
    {"name": "market_implied", "kind": "analytic"},
    {"name": "vig_included",   "kind": "analytic"},
    {"name": "logistic",       "kind": "trainable"},
    {"name": "dixon_coles",    "kind": "trainable"}
  ]
}
```

Backend: union the analytic `_REGISTRY` keys and the `TRAINABLE` keys, stamp `kind`. Frontend (`api-backtest.ts:listBacktestModels`) returns `string[]` (just the names) for v1 — the `kind` field is reserved for future UI (no visible distinction in Stage 1).

### 5. Facets endpoint

New module `app/ml/picks_facets.py`:

```python
@dataclass(frozen=True)
class FacetsResponse:
    models: List[str]
    markets: List[str]
    sports: List[str]
    countries: List[str]
    competitions: List[str]
    selections: List[str]

def facets_for_live(filters: ...) -> FacetsResponse: ...
def facets_for_backtest(run_id: str, filters: ...) -> FacetsResponse: ...
def facets_for_both(run_id: str, filters: ...) -> FacetsResponse: ...   # union
```

Implementation: one `SELECT DISTINCT` per facet, joined to `match_event_summaries`. Caller passes the existing `StatsFilter` shape so the facet list respects active filters (e.g., when `country="ENGLAND"` is selected, the Competition dropdown shows only English competitions).

New route in `src.py`:

```python
@app.get("/picks/facets")
async def picks_facets(
    source: str = "live",
    run_id: Optional[str] = None,
    # ... same filter query params as /picks/stats ...
) -> FacetsResponse:
    if source == "live":
        return facets_for_live(filters)
    if source == "backtest":
        if not run_id:
            raise HTTPException(400, "run_id required when source=backtest")
        return facets_for_backtest(run_id, filters)
    if source == "both":
        if not run_id:
            raise HTTPException(400, "run_id required when source=both")
        return facets_for_both(run_id, filters)
    raise HTTPException(400, f"unknown source={source!r}")
```

### 6. Frontend `usePicksFacets` hook

New `frontend/src/hooks/usePicksFacets.ts`:

```ts
export type FacetsResponse = {
  models: string[];
  markets: string[];
  sports: string[];
  countries: string[];
  competitions: string[];
  selections: string[];
};

export function usePicksFacets(
  source: "live" | "backtest" | "both",
  runId?: string,
): FacetsResponse | null {
  const [data, setData] = useState<FacetsResponse | null>(null);
  useEffect(() => {
    if (source !== "live" && !runId) { setData(null); return; }
    const qs = new URLSearchParams({ source });
    if (runId) qs.set("run_id", runId);
    fetch(`/api/picks/facets?${qs.toString()}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => setData(j));
  }, [source, runId]);
  return data;
}
```

New Next.js proxy `frontend/src/app/api/picks/facets/route.ts` — standard pattern matching `frontend/src/app/api/picks/stats/route.ts`.

### 7. ExploreTab integration

`frontend/src/components/picks/tabs/ExploreTab.tsx` changes:

- Read `source` and `run_id` from `searchParams` (top of component, same as ModelsTab line 90-91).
- Call `const facets = usePicksFacets(source, runId)`.
- Pass `options={facets ?? undefined}` to `<FilterBar />`.
- Thread `source` + `runId` into all 4 fetch calls. The raw scatter (`fetchHistory({status:"settled", limit:1000})`) honors `source` too — comment in current code says "intentionally not driven by the FilterBar" but that's about filter state, not data source. We document the change inline.
- Add `needsRun = source !== "live" && !runId` guard. When true, render empty state with the link to `/picks/models` (where the user can start a backtest run).

### 8. ModelsTab (no changes required in Stage 1)

ModelsTab today derives filter options ad-hoc from its aggregation responses. It works. We could swap to `usePicksFacets` for consistency, but that's not what's broken, so we don't touch it. Stage 2 or a separate cleanup PR can do this.

## Data flow

```
User opens BacktestAdvancedDialog
  → GET /api/backtest/models → returns 4 items
  → dropdown lists market_implied, vig_included, logistic, dixon_coles

User picks "logistic", submits
  → POST /backtest/runs {model:"logistic", train_until:"2024-08-01", ...}
  → BacktestManager.create_run inserts queued row with stage=NULL, market_spec="football_1x2_ft"
  → worker dequeues

Worker._execute:
  → row = get_run(id)
  → spec = get_spec(row.market_spec)
  → if row.model in TRAINABLE: update stage='training'
  → fn = resolve_model_for_backtest(row.model, row.train_until, spec)
      → for logistic: fit_logistic_at("2024-08-01", spec)
        → load events kickoff<train_until && (country,comp) in spec.scope
        → compute features
        → fit, calibrate
        → return make_trained_model_fn(...)
  → update stage='backtesting'
  → report = run_backtest(model_fn=fn, market_spec=spec, train_until, ...)
  → leakage assertion per bet
  → insert_bets + finalize_run (stage=NULL, status=completed)

UI:
  → BacktestRunsPanel polls /backtest/runs every 5s
  → renders "logistic · running · training" then "logistic · running · backtesting" then "logistic · completed"

User opens /picks/explore?source=backtest&run_id=<id>
  → usePicksFacets("backtest", id) → GET /api/picks/facets?source=backtest&run_id=...
  → FilterBar receives populated options
  → Country/Competition dropdowns show only what's in the backtest run
  → All 4 fetches receive source+runId, hit /picks/stats and /picks/history backtest paths
  → charts render
```

## Testing

- **`MarketSpec`:** instantiation + `get_spec("football_1x2_ft")` round trip; `get_spec("nope")` raises KeyError.
- **`fit_logistic_at`:** call with `train_until="2024-08-01", spec=FOOTBALL_1X2_FT`. Assert returned callable accepts a feature dict and returns `{home, draw, away}` with values summing to ≈1.0 (±0.001). No numeric-stability assertions on individual probabilities.
- **`fit_dixon_coles_at`:** same shape assertion.
- **`resolve_model_for_backtest`:** trainable name routes to `TRAINABLE`; analytic name routes to `_REGISTRY`; unknown name raises KeyError.
- **Worker stage transitions:** stub `resolve_model_for_backtest` and `run_backtest`. Capture `stage` writes via a row-update spy. Assert order: `stage=NULL → training → backtesting → NULL`.
- **`/backtest/models`:** asserts 4 items with correct `kind` annotations.
- **`/picks/facets`:** seed two `paper_bets` rows with different countries + one `backtest_bets` row with a third country. Assert:
  - `source=live` returns the two live countries (not the backtest one).
  - `source=backtest&run_id=X` returns only the backtest country.
  - `source=both&run_id=X` returns all three.
- **ExploreTab preview verification:** open `/picks/explore`, confirm Country dropdown lists ≥1 option. Open `/picks/explore?source=backtest&run_id=<existing-run>`, confirm the dropdowns repopulate.

## Migration

1. Prisma migration adding `stage TEXT` and `market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'` to `backtest_runs`. Hand-written if Prisma's drift detection complains (same pattern as the initial backtest tables migration in this branch).
2. `_ensure_backtest_tables` in `app/services/storage.py` gains idempotent `ALTER TABLE` calls. Pattern:
   ```python
   cols = {r[1] for r in connection.execute("PRAGMA table_info(backtest_runs)").fetchall()}
   if "stage" not in cols:
       connection.execute("ALTER TABLE backtest_runs ADD COLUMN stage TEXT")
   if "market_spec" not in cols:
       connection.execute("ALTER TABLE backtest_runs ADD COLUMN market_spec TEXT NOT NULL DEFAULT 'football_1x2_ft'")
   ```
3. Existing rows: `stage=NULL`, `market_spec='football_1x2_ft'`. Backwards compatible.

## Effort estimate

3 days. Breakdown:

- MarketSpec module + threading through `run_backtest`: ~0.5 day.
- Trainable adapters (factoring out training scripts into reusable fits): ~1 day. The fiddly part is loading data with the right cutoff + scope without depending on whatever the scripts assume about CWD or env.
- Stage column + worker plumbing: ~0.25 day.
- `/backtest/models` enrichment: ~0.1 day.
- Facets endpoint + hook: ~0.5 day (backend SQL + frontend hook + proxy).
- ExploreTab fixes (facets + source threading + empty state): ~0.4 day.
- Tests + smoke: ~0.25 day.

## Out of scope (explicit, again)

- `hgb` model — add by appending to `TRAINABLE`.
- "Use existing on-disk artifact" backtest mode.
- Cross-run trained-model caching.
- Progress percentage.
- Stage 2 (XGBoost + PCA) — separate brainstorm.
- Stage 3 (second market, second sport, generalization of label/feature/closing-price extraction) — separate brainstorm.
- ModelsTab swap to `usePicksFacets` — cosmetic, defer.
