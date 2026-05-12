# Model Behavior Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal Phase 4c `/picks` dashboard with a three-tab analytics surface (Health / Models / Exploration) plus a per-model deep-dive route, backed by a new `/picks/stats` aggregation endpoint.

**Architecture:** A single FastAPI endpoint (`/picks/stats`) handles all aggregation queries via a parameterized `group_by` + filter set; the existing `/picks/history` and `/picks/summary` continue to serve their current purposes. The frontend reorganizes into `frontend/src/components/picks/` with a tab dispatcher, per-tab content components, and visx-based chart primitives. Filter state lives in URL query params via Next.js `useSearchParams`.

**Tech Stack:** Python 3.10 + FastAPI + sqlite3 (backend), Next.js 14 + React + Tailwind + visx (frontend), pytest + Playwright (tests).

**Spec:** `docs/superpowers/specs/2026-05-12-model-behavior-dashboard-design.md` — read this if any task feels ambiguous.

---

## File Structure

### Backend — new files
- `app/ml/paper_trade_stats.py` — query templating + aggregation for `/picks/stats`.
- `tests/ml/test_paper_trade_stats.py` — unit tests against the fixture DB.

### Backend — modified files
- `src.py` — add two new endpoints: `GET /picks/stats` and `GET /picks/stats/calibration`.

### Frontend — new files
- `frontend/src/app/[locale]/picks/page.tsx` — replaces the existing minimal page; becomes a tab dispatcher.
- `frontend/src/app/[locale]/picks/model/[name]/page.tsx` — per-model deep-dive route.
- `frontend/src/app/api/picks/stats/route.ts` — Next.js proxy to FastAPI `/picks/stats`.
- `frontend/src/app/api/picks/stats/calibration/route.ts` — Next.js proxy to FastAPI `/picks/stats/calibration`.
- `frontend/src/components/picks/PicksLayout.tsx` — tab bar + page chrome.
- `frontend/src/components/picks/filters/FilterBar.tsx` — composes filter chips.
- `frontend/src/components/picks/filters/filter-types.ts` — typed `FiltersState` + URL serialization.
- `frontend/src/components/picks/tabs/HealthTab.tsx` — KPI cards + trend + freshness + per-model snapshot.
- `frontend/src/components/picks/tabs/ModelsTab.tsx` — leaderboard + cumulative + violin + heatmaps.
- `frontend/src/components/picks/tabs/ExploreTab.tsx` — scatter + bucket bars + heatmap + drill-down.
- `frontend/src/components/picks/charts/CumulativeLineChart.tsx`
- `frontend/src/components/picks/charts/ViolinChart.tsx`
- `frontend/src/components/picks/charts/ScatterChart.tsx`
- `frontend/src/components/picks/charts/HeatmapChart.tsx`
- `frontend/src/components/picks/charts/CalibrationPlot.tsx`
- `frontend/src/components/picks/charts/WaterfallChart.tsx`
- `frontend/src/components/picks/charts/BucketedBarChart.tsx`
- `frontend/src/components/picks/ModelDeepDive.tsx` — per-model page body.
- `frontend/src/lib/api-picks.ts` — typed wrappers around `/api/picks/*` routes.
- `frontend/tests/e2e/picks-dashboard.spec.ts` — Playwright tests.

### Frontend — modified files
- `frontend/src/lib/i18n.ts` — add `picks.stats.*` and `picks.deepDive.*` keys for `en` + `cs`.
- `frontend/package.json` — add `@visx/*` dependencies.

### Frontend — removed files
- `frontend/src/components/PicksDashboard.tsx` — functionality moves into `tabs/HealthTab.tsx`.

---

## Phasing

The plan is organized into five sequenced phases. Each phase ends in a working, committable surface.

- **Phase A:** Backend `/picks/stats` endpoint + tests (no frontend changes).
- **Phase B:** Frontend skeleton — tab dispatcher, URL filter state, Health tab replaces existing PicksDashboard.
- **Phase C:** Models tab + the charts it needs (cumulative, violin, heatmap, leaderboard table).
- **Phase D:** Explore tab + the remaining charts (scatter, bucket bars, drill-down table).
- **Phase E:** Per-model deep-dive page + calibration plot + waterfall.

---

# Phase A — Backend `/picks/stats`

## Task A1: Module skeleton + filter validation

**Files:**
- Create: `app/ml/paper_trade_stats.py`
- Test: `tests/ml/test_paper_trade_stats.py`

- [ ] **Step 1: Write failing tests for filter validation**

Create `tests/ml/test_paper_trade_stats.py` with:

```python
"""Unit tests for app.ml.paper_trade_stats — the /picks/stats backend.

Hermetic: uses the existing fixture DB pattern. Tests query templating,
filter validation, bucket math, and aggregation correctness.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.ml.closing_odds import backfill_closing_odds
from app.ml.labels import backfill_labels
from app.ml.paper_trade import PickInput, record_picks, settle_pending_bets
from app.ml.paper_trade_stats import (
    StatsFilter,
    StatsRequest,
    aggregate,
    calibration_buckets,
)


TEST_SCOPE = (("TESTLAND", "Test League"),)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def test_invalid_group_by_raises():
    with pytest.raises(ValueError, match="unknown group_by"):
        StatsRequest(group_by=("not_a_real_dim",))


def test_invalid_status_raises():
    with pytest.raises(ValueError, match="unknown status"):
        StatsRequest(group_by=("model",), filters=StatsFilter(status="weird"))


def test_empty_group_by_is_valid():
    # No group_by means a single global row.
    req = StatsRequest(group_by=())
    assert req.group_by == ()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/.claude/worktrees/goofy-mendel-5142e3
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.ml.paper_trade_stats'` or ImportError on the symbols.

- [ ] **Step 3: Implement the module skeleton**

Create `app/ml/paper_trade_stats.py`:

```python
"""Aggregation queries over paper_bets for /picks/stats.

Separate from paper_trade.py to keep that module focused on
record/settle and avoid growing it into a query toolbox.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple


# Allowed group_by tokens. Used both for validation and for the SQL
# SELECT/GROUP BY clause builder.
ALLOWED_GROUP_BY = (
    "model",
    "market",
    "sport",
    "country",
    "competition",
    "selection",
    "edge_bucket",
    "price_bucket",
    "day",
    "week",
    "month",
)

ALLOWED_STATUS = ("settled", "pending", "all")


@dataclass(frozen=True)
class StatsFilter:
    status: str = "settled"
    date_from: Optional[str] = None   # ISO8601
    date_to: Optional[str] = None
    model: Tuple[str, ...] = ()
    market: Tuple[str, ...] = ()
    sport: Tuple[str, ...] = ()
    country: Tuple[str, ...] = ()
    competition: Tuple[str, ...] = ()
    selection: Tuple[str, ...] = ()
    edge_min: Optional[float] = None
    edge_max: Optional[float] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None


@dataclass(frozen=True)
class StatsRequest:
    group_by: Tuple[str, ...] = ()
    filters: StatsFilter = field(default_factory=StatsFilter)
    min_n_per_group: int = 1

    def __post_init__(self) -> None:
        for token in self.group_by:
            if token not in ALLOWED_GROUP_BY:
                raise ValueError(
                    f"unknown group_by {token!r}. allowed: {ALLOWED_GROUP_BY}"
                )
        if self.filters.status not in ALLOWED_STATUS:
            raise ValueError(
                f"unknown status {self.filters.status!r}. allowed: {ALLOWED_STATUS}"
            )


def aggregate(request: StatsRequest) -> List[Dict[str, Any]]:
    """Stub — implemented in later tasks."""
    raise NotImplementedError


def calibration_buckets(
    *,
    model: str,
    filters: StatsFilter = StatsFilter(),
    n_buckets: int = 10,
) -> List[Dict[str, Any]]:
    """Stub — implemented in Task A4."""
    raise NotImplementedError
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add app/ml/paper_trade_stats.py tests/ml/test_paper_trade_stats.py
git commit -m "Phase A1: paper_trade_stats module skeleton + filter validation"
```

---

## Task A2: SQL templating with safe group_by

**Files:**
- Modify: `app/ml/paper_trade_stats.py`
- Test: `tests/ml/test_paper_trade_stats.py`

- [ ] **Step 1: Add failing test for SQL templating**

Append to `tests/ml/test_paper_trade_stats.py`:

```python
def test_aggregate_no_filters_no_group_returns_one_row(fixture_db):
    from app.ml.labels import backfill_labels
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    # Record a couple of synthetic picks and settle them.
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    from app.ml.closing_odds import backfill_closing_odds
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest())
    assert len(rows) == 1
    assert rows[0]["n"] == 1
    assert rows[0]["wins"] in (0, 1)


def test_aggregate_group_by_model(fixture_db):
    from app.ml.labels import backfill_labels
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
        PickInput(
            event_id="evt001", model="dixon_coles", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.60,
            devigged_prob=0.5, edge=0.10, kelly_full=0.20,
        ),
    ]
    record_picks(picks)
    from app.ml.closing_odds import backfill_closing_odds
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("model",)))
    by_model = {r["model"]: r for r in rows}
    assert "logistic" in by_model
    assert "dixon_coles" in by_model
    assert by_model["logistic"]["n"] == 1
    assert by_model["dixon_coles"]["n"] == 1
```

Also add to the file top (after existing imports):

```python
from app.ml.paper_trade import PickInput, record_picks, settle_pending_bets
```

And reuse the `fixture_db` fixture from `tests/ml/conftest.py` (it's already imported automatically when present in the package).

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 2 new tests FAIL with `NotImplementedError`.

- [ ] **Step 3: Implement `aggregate()` with SQL templating**

Replace the `aggregate` stub in `app/ml/paper_trade_stats.py` with:

```python
import os
from app.ml import db as ml_db


# Maps group_by token -> SQL SELECT expression. Keys are validated
# against ALLOWED_GROUP_BY in StatsRequest.__post_init__.
_GROUP_EXPR = {
    "model": "pb.model",
    "market": "pb.market",
    "sport": "mes.sport",
    "country": "mes.country",
    "competition": "mes.competition",
    "selection": "pb.selection",
    "edge_bucket": (
        "CASE "
        "WHEN pb.edge IS NULL THEN 'unknown' "
        "WHEN pb.edge < 0.02 THEN '0-2' "
        "WHEN pb.edge < 0.05 THEN '2-5' "
        "WHEN pb.edge < 0.10 THEN '5-10' "
        "WHEN pb.edge < 0.15 THEN '10-15' "
        "ELSE '15+' END"
    ),
    "price_bucket": (
        "CASE "
        "WHEN pb.price_at_recommendation <= 1.5 THEN '<=1.5' "
        "WHEN pb.price_at_recommendation <= 2.0 THEN '1.5-2' "
        "WHEN pb.price_at_recommendation <= 3.0 THEN '2-3' "
        "WHEN pb.price_at_recommendation <= 5.0 THEN '3-5' "
        "ELSE '5+' END"
    ),
    "day": (
        "substr(COALESCE(pb.settled_at, pb.recommended_at), 1, 10)"
    ),
    "week": (
        # ISO week — sqlite-friendly approximation: YYYY-MM-(weekno) via strftime.
        "strftime('%Y-W%W', COALESCE(pb.settled_at, pb.recommended_at))"
    ),
    "month": (
        "substr(COALESCE(pb.settled_at, pb.recommended_at), 1, 7)"
    ),
}


def _build_where(filters: StatsFilter) -> Tuple[str, List[Any]]:
    """Build the WHERE clause and parameter list. All parameter binding
    is positional ('?') — never string-interpolated."""
    where: List[str] = []
    params: List[Any] = []

    if filters.status != "all":
        where.append("pb.status = ?")
        params.append(filters.status)

    if filters.date_from:
        # When filtering by date, use settled_at for settled, else recommended_at.
        where.append(
            "COALESCE(pb.settled_at, pb.recommended_at) >= ?"
        )
        params.append(filters.date_from)
    if filters.date_to:
        where.append(
            "COALESCE(pb.settled_at, pb.recommended_at) <= ?"
        )
        params.append(filters.date_to)

    for col, values in [
        ("pb.model", filters.model),
        ("pb.market", filters.market),
        ("mes.sport", filters.sport),
        ("mes.country", filters.country),
        ("mes.competition", filters.competition),
        ("pb.selection", filters.selection),
    ]:
        if values:
            placeholders = ",".join("?" for _ in values)
            where.append(f"{col} IN ({placeholders})")
            params.extend(values)

    if filters.edge_min is not None:
        where.append("pb.edge >= ?")
        params.append(filters.edge_min)
    if filters.edge_max is not None:
        where.append("pb.edge <= ?")
        params.append(filters.edge_max)
    if filters.price_min is not None:
        where.append("pb.price_at_recommendation >= ?")
        params.append(filters.price_min)
    if filters.price_max is not None:
        where.append("pb.price_at_recommendation <= ?")
        params.append(filters.price_max)

    clause = " AND ".join(where) if where else "1=1"
    return clause, params


def aggregate(request: StatsRequest) -> List[Dict[str, Any]]:
    """Run the aggregation query and return a list of result rows.

    Each row carries the group_by columns plus aggregate metrics
    (n, wins, hit_rate, stake_total, pnl_total, roi, mean_clv,
    brier, max_drawdown). max_drawdown is computed in Python from a
    second pass over the matching rows ordered chronologically.
    """
    where_clause, where_params = _build_where(request.filters)

    select_parts: List[str] = []
    group_parts: List[str] = []
    for token in request.group_by:
        expr = _GROUP_EXPR[token]
        select_parts.append(f"{expr} AS {token}")
        group_parts.append(expr)
    aggregates = """
        COUNT(*) AS n,
        SUM(CASE WHEN pb.result = 1.0 THEN 1 ELSE 0 END) AS wins,
        SUM(COALESCE(pb.kelly_full, 0)) AS stake_total,
        SUM(COALESCE(pb.pnl, 0)) AS pnl_total,
        AVG(pb.clv) AS mean_clv,
        AVG(
            CASE WHEN pb.result IS NOT NULL
                 THEN (pb.model_prob - pb.result) * (pb.model_prob - pb.result)
                 ELSE NULL END
        ) AS brier
    """
    select_clause = ", ".join([*select_parts, aggregates.strip()])
    group_clause = f"GROUP BY {', '.join(group_parts)}" if group_parts else ""
    having_clause = (
        f"HAVING n >= ?" if request.min_n_per_group > 1 else ""
    )
    sql = f"""
        SELECT {select_clause}
        FROM paper_bets pb
        LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
        WHERE {where_clause}
        {group_clause}
        {having_clause}
    """
    final_params = list(where_params)
    if request.min_n_per_group > 1:
        final_params.append(request.min_n_per_group)

    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, final_params).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            entry: Dict[str, Any] = dict(row)
            n = entry.get("n", 0) or 0
            wins = entry.get("wins", 0) or 0
            stake = entry.get("stake_total", 0.0) or 0.0
            pnl = entry.get("pnl_total", 0.0) or 0.0
            entry["hit_rate"] = (wins / n) if n > 0 else None
            entry["roi"] = (pnl / stake) if stake > 0 else None
            out.append(entry)

        # Second pass: compute max_drawdown per group from individual bets.
        out = _attach_max_drawdown(conn, out, request, where_clause, where_params)
    return out


def _attach_max_drawdown(
    conn: sqlite3.Connection,
    rows: List[Dict[str, Any]],
    request: StatsRequest,
    where_clause: str,
    where_params: Sequence[Any],
) -> List[Dict[str, Any]]:
    """Compute max drawdown per group by scanning ordered settled bets."""
    if not request.group_by:
        bets = conn.execute(
            f"""
            SELECT pb.pnl, COALESCE(pb.settled_at, pb.recommended_at) AS t
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            WHERE {where_clause} AND pb.status = 'settled'
            ORDER BY t ASC
            """,
            where_params,
        ).fetchall()
        rows[0]["max_drawdown"] = _max_drawdown([b["pnl"] or 0.0 for b in bets])
        return rows

    # Group-by case: pull per-group ordered bets, compute per group.
    group_exprs = ", ".join(
        f"{_GROUP_EXPR[token]} AS {token}" for token in request.group_by
    )
    bets = conn.execute(
        f"""
        SELECT {group_exprs}, pb.pnl, COALESCE(pb.settled_at, pb.recommended_at) AS t
        FROM paper_bets pb
        LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
        WHERE {where_clause} AND pb.status = 'settled'
        ORDER BY t ASC
        """,
        where_params,
    ).fetchall()
    bucket: Dict[Tuple, List[float]] = {}
    for b in bets:
        key = tuple(b[token] for token in request.group_by)
        bucket.setdefault(key, []).append(b["pnl"] or 0.0)
    for row in rows:
        key = tuple(row[token] for token in request.group_by)
        row["max_drawdown"] = _max_drawdown(bucket.get(key, []))
    return rows


def _max_drawdown(pnls: Sequence[float]) -> float:
    """Scan cumulative P&L and return the largest peak-to-trough decline."""
    running = 0.0
    peak = 0.0
    max_dd = 0.0
    for x in pnls:
        running += x
        if running > peak:
            peak = running
        dd = peak - running
        if dd > max_dd:
            max_dd = dd
    return max_dd
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/ml/paper_trade_stats.py tests/ml/test_paper_trade_stats.py
git commit -m "Phase A2: aggregate() with safe SQL templating"
```

---

## Task A3: Bucket math + date filter tests

**Files:**
- Modify: `tests/ml/test_paper_trade_stats.py`

- [ ] **Step 1: Add tests for edge/price bucketing and date filtering**

Append to `tests/ml/test_paper_trade_stats.py`:

```python
def test_edge_bucket_grouping(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.51,
            devigged_prob=0.5, edge=0.01, kelly_full=0.10,
        ),
        PickInput(
            event_id="evt002", model="logistic", market="1X2_FT",
            selection="draw", bet_ts=_now_iso(),
            price_at_recommendation=3.5, model_prob=0.40,
            devigged_prob=0.30, edge=0.10, kelly_full=0.15,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("edge_bucket",)))
    buckets = {r["edge_bucket"] for r in rows}
    assert "0-2" in buckets
    assert "5-10" in buckets or "10-15" in buckets


def test_date_filter(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    # Filter that excludes everything.
    rows = aggregate(StatsRequest(
        filters=StatsFilter(date_from="2099-01-01T00:00:00Z"),
    ))
    assert len(rows) == 0 or rows[0]["n"] == 0


def test_min_n_per_group_drops_small_buckets(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = aggregate(StatsRequest(group_by=("model",), min_n_per_group=5))
    assert len(rows) == 0
```

- [ ] **Step 2: Run tests**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 8 passed total.

- [ ] **Step 3: Commit**

```bash
git add tests/ml/test_paper_trade_stats.py
git commit -m "Phase A3: bucket math + date filter tests"
```

---

## Task A4: Calibration buckets

**Files:**
- Modify: `app/ml/paper_trade_stats.py`
- Modify: `tests/ml/test_paper_trade_stats.py`

- [ ] **Step 1: Add failing test for calibration_buckets**

Append to `tests/ml/test_paper_trade_stats.py`:

```python
def test_calibration_buckets_empty(fixture_db):
    rows = calibration_buckets(model="logistic")
    assert rows == []


def test_calibration_buckets_one_settled_bet(fixture_db):
    from app.ml.labels import backfill_labels
    from app.ml.closing_odds import backfill_closing_odds
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    settle_pending_bets()

    rows = calibration_buckets(model="logistic")
    assert len(rows) == 1
    bucket = rows[0]
    assert 0.5 <= bucket["mean_pred"] <= 0.6
    assert bucket["lower"] == pytest.approx(0.5)
    assert bucket["upper"] == pytest.approx(0.6)
    assert bucket["n"] == 1
```

- [ ] **Step 2: Run tests**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 2 new tests FAIL with NotImplementedError.

- [ ] **Step 3: Implement `calibration_buckets()`**

Replace the stub in `app/ml/paper_trade_stats.py`:

```python
def calibration_buckets(
    *,
    model: str,
    filters: StatsFilter = StatsFilter(),
    n_buckets: int = 10,
) -> List[Dict[str, Any]]:
    """Bin settled bets for ``model`` by ``model_prob`` and return the
    per-bucket sample count, mean predicted prob, and empirical hit
    rate. Used by the per-model deep-dive calibration plot."""
    width = 1.0 / n_buckets
    # Force model filter to the given model, on top of caller filters.
    model_filters = filters.__class__(
        **{**filters.__dict__, "model": tuple([model])}
    )
    # Settled rows only.
    if model_filters.status == "pending":
        return []
    if model_filters.status == "all":
        model_filters = model_filters.__class__(
            **{**model_filters.__dict__, "status": "settled"}
        )

    where_clause, where_params = _build_where(model_filters)
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"""
            SELECT pb.model_prob AS p, pb.result AS r
            FROM paper_bets pb
            LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id
            WHERE {where_clause}
              AND pb.status = 'settled'
              AND pb.result IS NOT NULL
            """,
            where_params,
        ).fetchall()
    if not rows:
        return []

    buckets: List[List[Tuple[float, float]]] = [[] for _ in range(n_buckets)]
    for row in rows:
        p = float(row["p"])
        idx = min(int(p / width), n_buckets - 1)
        buckets[idx].append((p, float(row["r"])))
    out: List[Dict[str, Any]] = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        mean_pred = sum(p for p, _ in bucket) / len(bucket)
        hit_rate = sum(r for _, r in bucket) / len(bucket)
        out.append({
            "lower": i * width,
            "upper": (i + 1) * width,
            "n": len(bucket),
            "mean_pred": mean_pred,
            "hit_rate": hit_rate,
        })
    return out
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/ml/test_paper_trade_stats.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add app/ml/paper_trade_stats.py tests/ml/test_paper_trade_stats.py
git commit -m "Phase A4: calibration_buckets()"
```

---

## Task A5: FastAPI endpoints

**Files:**
- Modify: `src.py`

- [ ] **Step 1: Add the endpoints below `/picks/summary`**

Open `src.py` and locate the existing `/picks/summary` endpoint (search for `async def picks_summary`). Add the following two endpoints immediately after it, but before the `# You can include routers here` comment:

```python
@app.get("/picks/stats")
async def picks_stats(
    group_by: Optional[str] = Query(default=None),
    status: str = Query(default="settled"),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    model: Optional[str] = Query(default=None),
    market: Optional[str] = Query(default=None),
    sport: Optional[str] = Query(default=None),
    country: Optional[str] = Query(default=None),
    competition: Optional[str] = Query(default=None),
    selection: Optional[str] = Query(default=None),
    edge_min: Optional[float] = Query(default=None),
    edge_max: Optional[float] = Query(default=None),
    price_min: Optional[float] = Query(default=None),
    price_max: Optional[float] = Query(default=None),
    min_n_per_group: int = Query(default=1, ge=1),
) -> dict:
    """Aggregation over paper_bets. ``group_by`` is a comma-separated
    list of dimensions; multi-value filters are comma-separated too."""
    from app.ml.paper_trade_stats import StatsFilter, StatsRequest, aggregate

    def _csv(value: Optional[str]) -> tuple:
        if not value:
            return ()
        return tuple(v.strip() for v in value.split(",") if v.strip())

    try:
        request = StatsRequest(
            group_by=_csv(group_by),
            filters=StatsFilter(
                status=status,
                date_from=date_from,
                date_to=date_to,
                model=_csv(model),
                market=_csv(market),
                sport=_csv(sport),
                country=_csv(country),
                competition=_csv(competition),
                selection=_csv(selection),
                edge_min=edge_min,
                edge_max=edge_max,
                price_min=price_min,
                price_max=price_max,
            ),
            min_n_per_group=min_n_per_group,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    rows = aggregate(request)
    return {
        "group_by": list(request.group_by),
        "filters": {
            "status": status, "date_from": date_from, "date_to": date_to,
            "model": list(request.filters.model),
            "market": list(request.filters.market),
            "sport": list(request.filters.sport),
            "country": list(request.filters.country),
            "competition": list(request.filters.competition),
            "selection": list(request.filters.selection),
            "edge_min": edge_min, "edge_max": edge_max,
            "price_min": price_min, "price_max": price_max,
        },
        "rows": rows,
    }


@app.get("/picks/stats/calibration")
async def picks_stats_calibration(
    model: str = Query(...),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    market: Optional[str] = Query(default=None),
    competition: Optional[str] = Query(default=None),
    n_buckets: int = Query(default=10, ge=2, le=50),
) -> dict:
    """Calibration buckets for ``model``. Settled bets only."""
    from app.ml.paper_trade_stats import StatsFilter, calibration_buckets

    def _csv(value: Optional[str]) -> tuple:
        if not value:
            return ()
        return tuple(v.strip() for v in value.split(",") if v.strip())

    filters = StatsFilter(
        status="settled",
        date_from=date_from, date_to=date_to,
        market=_csv(market),
        competition=_csv(competition),
    )
    buckets = calibration_buckets(model=model, filters=filters, n_buckets=n_buckets)
    return {"model": model, "n_buckets": n_buckets, "buckets": buckets}
```

- [ ] **Step 2: Smoke-test against the live archive**

Start uvicorn locally (will fail if port 8000 is taken — skip if you don't have shell access):

```bash
APP_STORAGE_DB_PATH=/Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  python3 -c "
from fastapi.testclient import TestClient
import src
client = TestClient(src.app)
r = client.get('/picks/stats?group_by=model,market')
print(r.status_code, r.json().get('rows', [])[:2])
r = client.get('/picks/stats/calibration?model=dixon_coles')
print(r.status_code, r.json().get('buckets', []))
"
```

Expected: `200` on both. Response shape matches the spec.

- [ ] **Step 3: Run the full test suite**

```bash
python3 -m pytest tests/ml/ -v
```

Expected: all tests pass (43 prior + 10 new = 53).

- [ ] **Step 4: Commit**

```bash
git add src.py
git commit -m "Phase A5: /picks/stats and /picks/stats/calibration endpoints"
```

---

# Phase B — Frontend skeleton + Health tab

## Task B1: Install visx dependencies

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Add visx packages**

Open `frontend/package.json` and add to `dependencies` (keep alphabetical order with existing entries):

```json
"@visx/axis": "^3.10.0",
"@visx/group": "^3.10.0",
"@visx/scale": "^3.10.0",
"@visx/shape": "^3.10.0",
"@visx/stat": "^3.10.0",
"@visx/text": "^3.10.0",
"@visx/tooltip": "^3.10.0",
```

- [ ] **Step 2: Install**

```bash
cd frontend && npm install --no-audit --no-fund
```

Expected: install completes, no peer-dep errors.

- [ ] **Step 3: Verify the lint+build still pass**

```bash
cd frontend && npm run lint && npm run build
```

Expected: pass (build may warn about unused exports — those resolve in later tasks).

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "Phase B1: add visx dependencies"
```

---

## Task B2: typed API client

**Files:**
- Create: `frontend/src/lib/api-picks.ts`

- [ ] **Step 1: Write the client**

Create `frontend/src/lib/api-picks.ts`:

```ts
// Typed wrappers around /api/picks/* routes.
// Each function returns a parsed, type-safe object. Errors throw.

export type StatsFilters = {
  status?: "settled" | "pending" | "all";
  dateFrom?: string;
  dateTo?: string;
  model?: string[];
  market?: string[];
  sport?: string[];
  country?: string[];
  competition?: string[];
  selection?: string[];
  edgeMin?: number;
  edgeMax?: number;
  priceMin?: number;
  priceMax?: number;
  minNPerGroup?: number;
};

export type StatsGroupBy =
  | "model" | "market" | "sport" | "country" | "competition"
  | "selection" | "edge_bucket" | "price_bucket"
  | "day" | "week" | "month";

export type StatsRow = {
  [dim: string]: string | number | null | undefined;
  n: number;
  wins: number;
  hit_rate: number | null;
  stake_total: number;
  pnl_total: number;
  roi: number | null;
  mean_clv: number | null;
  brier: number | null;
  max_drawdown: number;
};

export type StatsResponse = {
  group_by: StatsGroupBy[];
  filters: Record<string, unknown>;
  rows: StatsRow[];
};

export type CalibrationBucket = {
  lower: number;
  upper: number;
  n: number;
  mean_pred: number;
  hit_rate: number;
};

export type CalibrationResponse = {
  model: string;
  n_buckets: number;
  buckets: CalibrationBucket[];
};

export type HistoryRow = {
  id: number;
  event_id: string;
  model: string;
  market: string;
  selection: string;
  recommended_at: string;
  bet_ts: string;
  price_at_recommendation: number;
  closing_price: number | null;
  model_prob: number;
  devigged_prob: number | null;
  edge: number | null;
  kelly_full: number | null;
  result: number | null;
  pnl: number | null;
  clv: number | null;
  status: string;
};

export type HistoryResponse = {
  count: number;
  rows: HistoryRow[];
};

function buildQuery(
  groupBy: StatsGroupBy[] | undefined,
  filters: StatsFilters
): string {
  const params = new URLSearchParams();
  if (groupBy && groupBy.length > 0) params.set("group_by", groupBy.join(","));
  if (filters.status) params.set("status", filters.status);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.model?.length) params.set("model", filters.model.join(","));
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.sport?.length) params.set("sport", filters.sport.join(","));
  if (filters.country?.length) params.set("country", filters.country.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  if (filters.selection?.length) params.set("selection", filters.selection.join(","));
  if (filters.edgeMin !== undefined) params.set("edge_min", String(filters.edgeMin));
  if (filters.edgeMax !== undefined) params.set("edge_max", String(filters.edgeMax));
  if (filters.priceMin !== undefined) params.set("price_min", String(filters.priceMin));
  if (filters.priceMax !== undefined) params.set("price_max", String(filters.priceMax));
  if (filters.minNPerGroup) params.set("min_n_per_group", String(filters.minNPerGroup));
  return params.toString();
}

export async function fetchStats(
  groupBy: StatsGroupBy[],
  filters: StatsFilters = {}
): Promise<StatsResponse> {
  const qs = buildQuery(groupBy, filters);
  const r = await fetch(`/api/picks/stats?${qs}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`stats: HTTP ${r.status}`);
  return (await r.json()) as StatsResponse;
}

export async function fetchCalibration(
  model: string,
  filters: StatsFilters = {}
): Promise<CalibrationResponse> {
  const params = new URLSearchParams({ model });
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  const r = await fetch(`/api/picks/stats/calibration?${params.toString()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`calibration: HTTP ${r.status}`);
  return (await r.json()) as CalibrationResponse;
}

export async function fetchHistory(opts: {
  status?: "settled" | "pending" | "voided";
  limit?: number;
} = {}): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  const r = await fetch(`/api/picks/history?${params.toString()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`history: HTTP ${r.status}`);
  return (await r.json()) as HistoryResponse;
}
```

- [ ] **Step 2: Verify type-check**

```bash
cd frontend && npm run lint
```

Expected: lint passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api-picks.ts
git commit -m "Phase B2: typed api-picks client"
```

---

## Task B3: Next.js API proxies for stats endpoints

**Files:**
- Create: `frontend/src/app/api/picks/stats/route.ts`
- Create: `frontend/src/app/api/picks/stats/calibration/route.ts`

- [ ] **Step 1: Write the proxy for /api/picks/stats**

Create `frontend/src/app/api/picks/stats/route.ts`:

```ts
import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 20_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const backendUrl = `${resolveBackendBaseUrl()}/picks/stats?${url.searchParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(backendUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stats backend unreachable";
    return NextResponse.json(
      { error: { code: "picks_stats_backend_unreachable", message } },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Write the proxy for /api/picks/stats/calibration**

Create `frontend/src/app/api/picks/stats/calibration/route.ts` with the same structure but pointing at `/picks/stats/calibration`:

```ts
import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 15_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const backendUrl = `${resolveBackendBaseUrl()}/picks/stats/calibration?${url.searchParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(backendUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "calibration backend unreachable";
    return NextResponse.json(
      { error: { code: "picks_calibration_backend_unreachable", message } },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 3: Verify build**

```bash
cd frontend && npm run build
```

Expected: build succeeds; both new routes appear in the route table.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/api/picks/stats
git commit -m "Phase B3: Next.js proxies for /picks/stats and /picks/stats/calibration"
```

---

## Task B4: Filter-state types + URL serialization

**Files:**
- Create: `frontend/src/components/picks/filters/filter-types.ts`

- [ ] **Step 1: Write the filter-state module**

Create the directory and file:

```ts
// FiltersState shape + URL serialization. Single source of truth.

export type DateRangePreset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

export type FiltersState = {
  status: "settled" | "pending" | "all";
  datePreset: DateRangePreset;
  dateFrom?: string;
  dateTo?: string;
  model?: string[];
  market?: string[];
  sport?: string[];
  country?: string[];
  competition?: string[];
  selection?: string[];
  edge?: string;       // bucket label e.g. "5-10"
  price?: string;      // bucket label e.g. "1.5-2"
};

export const DEFAULT_FILTERS: FiltersState = {
  status: "settled",
  datePreset: "90d",
};

export function filtersFromSearchParams(
  params: URLSearchParams,
): FiltersState {
  const get = (k: string) => params.get(k) ?? undefined;
  const getList = (k: string) => {
    const v = params.get(k);
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  };
  return {
    status: (get("status") as FiltersState["status"]) ?? DEFAULT_FILTERS.status,
    datePreset:
      (get("date") as DateRangePreset | undefined) ?? DEFAULT_FILTERS.datePreset,
    dateFrom: get("date_from"),
    dateTo: get("date_to"),
    model: getList("model"),
    market: getList("market"),
    sport: getList("sport"),
    country: getList("country"),
    competition: getList("competition"),
    selection: getList("selection"),
    edge: get("edge"),
    price: get("price"),
  };
}

export function filtersToSearchParams(
  filters: FiltersState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== DEFAULT_FILTERS.status) params.set("status", filters.status);
  if (filters.datePreset !== DEFAULT_FILTERS.datePreset) params.set("date", filters.datePreset);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.model?.length) params.set("model", filters.model.join(","));
  if (filters.market?.length) params.set("market", filters.market.join(","));
  if (filters.sport?.length) params.set("sport", filters.sport.join(","));
  if (filters.country?.length) params.set("country", filters.country.join(","));
  if (filters.competition?.length) params.set("competition", filters.competition.join(","));
  if (filters.selection?.length) params.set("selection", filters.selection.join(","));
  if (filters.edge) params.set("edge", filters.edge);
  if (filters.price) params.set("price", filters.price);
  return params;
}

export function presetToDateRange(
  preset: DateRangePreset,
): { dateFrom?: string; dateTo?: string } {
  if (preset === "all" || preset === "custom") return {};
  const now = new Date();
  const ms = { "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, "90d": 90 * 86400e3 }[preset];
  const from = new Date(now.getTime() - ms);
  return { dateFrom: from.toISOString() };
}

export function edgeBucketToRange(bucket: string): { edgeMin?: number; edgeMax?: number } {
  switch (bucket) {
    case "0-2": return { edgeMin: 0, edgeMax: 0.02 };
    case "2-5": return { edgeMin: 0.02, edgeMax: 0.05 };
    case "5-10": return { edgeMin: 0.05, edgeMax: 0.10 };
    case "10-15": return { edgeMin: 0.10, edgeMax: 0.15 };
    case "15+": return { edgeMin: 0.15 };
    default: return {};
  }
}

export function priceBucketToRange(bucket: string): { priceMin?: number; priceMax?: number } {
  switch (bucket) {
    case "<=1.5": return { priceMax: 1.5 };
    case "1.5-2": return { priceMin: 1.5, priceMax: 2.0 };
    case "2-3": return { priceMin: 2.0, priceMax: 3.0 };
    case "3-5": return { priceMin: 3.0, priceMax: 5.0 };
    case "5+": return { priceMin: 5.0 };
    default: return {};
  }
}
```

- [ ] **Step 2: Lint-check**

```bash
cd frontend && npm run lint
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/filters/filter-types.ts
git commit -m "Phase B4: filter-state types + URL serialization"
```

---

## Task B5: i18n keys for stats + deep-dive

**Files:**
- Modify: `frontend/src/lib/i18n.ts`

- [ ] **Step 1: Add new keys to the en catalog**

In `frontend/src/lib/i18n.ts`, locate the `enMessages` declaration's closing `};` and add these keys before it (extend the last existing key with a trailing comma if needed):

```ts
  "picks.tabs.health": "Health",
  "picks.tabs.models": "Models",
  "picks.tabs.explore": "Explore",
  "picks.kpi.picksToday": "Picks today",
  "picks.kpi.hitRate7d": "7-day hit rate",
  "picks.kpi.pnl7d": "7-day P&L",
  "picks.kpi.clv7d": "7-day mean CLV",
  "picks.freshness.title": "Pipeline freshness",
  "picks.freshness.liveOdds": "Last live-odds cycle",
  "picks.freshness.recordPicks": "Last record_picks",
  "picks.freshness.settle": "Last settle",
  "picks.freshness.pending": "Pending bets",
  "picks.freshness.upcoming": "Upcoming fixtures",
  "picks.trend.title": "Cumulative P&L & CLV (90 days)",
  "picks.snapshot.title": "Per-model snapshot (last 7 days)",
  "picks.filter.date": "Date",
  "picks.filter.status": "Status",
  "picks.filter.model": "Model",
  "picks.filter.market": "Market",
  "picks.filter.sport": "Sport",
  "picks.filter.country": "Country",
  "picks.filter.competition": "Competition",
  "picks.filter.selection": "Selection",
  "picks.filter.edge": "Edge",
  "picks.filter.price": "Price",
  "picks.filter.bookmaker": "Bookmaker (coming soon)",
  "picks.filter.all": "All",
  "picks.filter.reset": "Reset",
  "picks.leaderboard.title": "Leaderboard",
  "picks.leaderboard.brier": "Brier",
  "picks.leaderboard.maxDrawdown": "Max DD",
  "picks.heatmap.modelMarket": "ROI: model × market",
  "picks.heatmap.modelCompetition": "ROI: model × competition",
  "picks.violin.title": "CLV distribution per model",
  "picks.scatter.title": "Edge vs Realized Return",
  "picks.buckets.hitByEdge": "Hit rate by edge bucket",
  "picks.buckets.roiByPrice": "ROI by price bucket",
  "picks.heatmap.competitionSelection": "Mean CLV: competition × selection",
  "picks.drilldown.title": "Filtered bets",
  "picks.deepDive.calibration": "Calibration plot",
  "picks.deepDive.outcomeBreakdown": "Outcome breakdown by selection",
  "picks.deepDive.waterfall": "P&L by competition",
  "picks.deepDive.bets": "Bets list",
  "picks.deepDive.brierLabel": "Brier",
  "picks.deepDive.kpi.bets": "Bets",
  "picks.deepDive.kpi.hitRate": "Hit %",
  "picks.deepDive.kpi.roi": "ROI",
  "picks.deepDive.kpi.meanClv": "Mean CLV",
  "picks.empty.smallSample": "n too small — need more bets",
```

- [ ] **Step 2: Add the same keys to the cs catalog**

Find `csMessages` and add Czech translations of the same keys (use the existing cs entries as a style guide — ASCII-only, no accents, since the existing `csMessages` uses that convention):

```ts
  "picks.tabs.health": "Zdravi",
  "picks.tabs.models": "Modely",
  "picks.tabs.explore": "Pruzkum",
  "picks.kpi.picksToday": "Tipy dnes",
  "picks.kpi.hitRate7d": "Uspesnost 7 dni",
  "picks.kpi.pnl7d": "P&L 7 dni",
  "picks.kpi.clv7d": "Prumerny CLV 7 dni",
  "picks.freshness.title": "Aktualnost pipeline",
  "picks.freshness.liveOdds": "Posledni live-odds cyklus",
  "picks.freshness.recordPicks": "Posledni record_picks",
  "picks.freshness.settle": "Posledni vyhodnoceni",
  "picks.freshness.pending": "Cekajici tipy",
  "picks.freshness.upcoming": "Nadchazejici zapasy",
  "picks.trend.title": "Kumulativni P&L a CLV (90 dni)",
  "picks.snapshot.title": "Modely za poslednich 7 dni",
  "picks.filter.date": "Datum",
  "picks.filter.status": "Stav",
  "picks.filter.model": "Model",
  "picks.filter.market": "Trh",
  "picks.filter.sport": "Sport",
  "picks.filter.country": "Zeme",
  "picks.filter.competition": "Soutez",
  "picks.filter.selection": "Vyber",
  "picks.filter.edge": "Edge",
  "picks.filter.price": "Kurz",
  "picks.filter.bookmaker": "Bookmaker (pripravujeme)",
  "picks.filter.all": "Vse",
  "picks.filter.reset": "Reset",
  "picks.leaderboard.title": "Zebricek",
  "picks.leaderboard.brier": "Brier",
  "picks.leaderboard.maxDrawdown": "Max DD",
  "picks.heatmap.modelMarket": "ROI: model x trh",
  "picks.heatmap.modelCompetition": "ROI: model x soutez",
  "picks.violin.title": "Rozdeleni CLV podle modelu",
  "picks.scatter.title": "Edge vs realny vynos",
  "picks.buckets.hitByEdge": "Uspesnost podle edge bucketu",
  "picks.buckets.roiByPrice": "ROI podle kurzoveho bucketu",
  "picks.heatmap.competitionSelection": "Prumerny CLV: soutez x vyber",
  "picks.drilldown.title": "Filtrovane tipy",
  "picks.deepDive.calibration": "Kalibracni graf",
  "picks.deepDive.outcomeBreakdown": "Rozpis vysledku podle vyberu",
  "picks.deepDive.waterfall": "P&L podle souteze",
  "picks.deepDive.bets": "Seznam tipu",
  "picks.deepDive.brierLabel": "Brier",
  "picks.deepDive.kpi.bets": "Tipy",
  "picks.deepDive.kpi.hitRate": "Uspesnost %",
  "picks.deepDive.kpi.roi": "ROI",
  "picks.deepDive.kpi.meanClv": "Prumerny CLV",
  "picks.empty.smallSample": "Maly vzorek - potrebujeme vice tipu",
```

- [ ] **Step 3: Verify lint**

```bash
cd frontend && npm run lint
```

Expected: passes. (TypeScript will complain if any key is in one catalog but not the other — fix immediately.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/i18n.ts
git commit -m "Phase B5: i18n keys for stats and deep-dive"
```

---

## Task B6: FilterBar component (basic)

**Files:**
- Create: `frontend/src/components/picks/filters/FilterBar.tsx`

- [ ] **Step 1: Write the FilterBar**

Create `frontend/src/components/picks/filters/FilterBar.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import {
  DEFAULT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type FiltersState,
  type DateRangePreset,
} from "./filter-types";

const DATE_PRESETS: DateRangePreset[] = ["24h", "7d", "30d", "90d", "all"];

interface FilterBarProps {
  // Filters to render. Pass an empty array to render none (used by Health
  // tab which has no filter bar).
  fields: Array<
    | "date" | "status" | "model" | "market" | "sport" | "country"
    | "competition" | "selection" | "edge" | "price" | "bookmaker"
  >;
  // Known option lists for multi-select dropdowns. Caller pulls these
  // from a stats query (e.g. distinct models across the dataset).
  options?: {
    models?: string[];
    markets?: string[];
    sports?: string[];
    countries?: string[];
    competitions?: string[];
    selections?: string[];
  };
}

export function FilterBar({ fields, options }: FilterBarProps) {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = filtersFromSearchParams(new URLSearchParams(searchParams.toString()));

  function update(patch: Partial<FiltersState>) {
    const next = { ...filters, ...patch } as FiltersState;
    const qs = filtersToSearchParams(next);
    // Preserve any non-filter params (currently just ?tab).
    const tab = searchParams.get("tab");
    if (tab) qs.set("tab", tab);
    router.replace(`${pathname}?${qs.toString()}`);
  }

  function reset() {
    const tab = searchParams.get("tab");
    const qs = new URLSearchParams();
    if (tab) qs.set("tab", tab);
    router.replace(`${pathname}?${qs.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-3 text-sm">
      {fields.includes("date") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.date")}</span>
          <select
            value={filters.datePreset}
            onChange={(e) => update({ datePreset: e.target.value as DateRangePreset })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
      {fields.includes("status") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.status")}</span>
          <select
            value={filters.status}
            onChange={(e) => update({ status: e.target.value as FiltersState["status"] })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            <option value="settled">settled</option>
            <option value="pending">pending</option>
            <option value="all">all</option>
          </select>
        </label>
      )}
      {(["model","market","sport","country","competition","selection"] as const).map((field) =>
        fields.includes(field) ? (
          <label key={field} className="flex items-center gap-1">
            <span className="text-xs text-[color:var(--color-text-muted)]">{t(`picks.filter.${field}` as any)}</span>
            <select
              value={(filters[field] ?? [])[0] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                update({ [field]: v ? [v] : undefined } as Partial<FiltersState>);
              }}
              className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
            >
              <option value="">{t("picks.filter.all")}</option>
              {((options?.[`${field}s` as keyof typeof options] ?? []) as string[]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
        ) : null
      )}
      {fields.includes("edge") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.edge")}</span>
          <select
            value={filters.edge ?? ""}
            onChange={(e) => update({ edge: e.target.value || undefined })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            <option value="">{t("picks.filter.all")}</option>
            <option value="0-2">0–2%</option>
            <option value="2-5">2–5%</option>
            <option value="5-10">5–10%</option>
            <option value="10-15">10–15%</option>
            <option value="15+">15%+</option>
          </select>
        </label>
      )}
      {fields.includes("price") && (
        <label className="flex items-center gap-1">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.price")}</span>
          <select
            value={filters.price ?? ""}
            onChange={(e) => update({ price: e.target.value || undefined })}
            className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1"
          >
            <option value="">{t("picks.filter.all")}</option>
            <option value="<=1.5">≤1.5</option>
            <option value="1.5-2">1.5–2</option>
            <option value="2-3">2–3</option>
            <option value="3-5">3–5</option>
            <option value="5+">5+</option>
          </select>
        </label>
      )}
      {fields.includes("bookmaker") && (
        <label className="flex items-center gap-1 opacity-50" title="Per-bookmaker pick recording lands later">
          <span className="text-xs text-[color:var(--color-text-muted)]">{t("picks.filter.bookmaker")}</span>
          <select disabled className="rounded-xl bg-[color:var(--color-brand-surface)] px-2 py-1">
            <option>{t("picks.filter.all")}</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={reset}
        className="ml-auto rounded-xl bg-[color:var(--color-brand-primary)] px-3 py-1.5 text-xs font-semibold text-[color:var(--color-text-inverse)]"
      >
        {t("picks.filter.reset")}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Build and lint**

```bash
cd frontend && npm run lint && npm run build
```

Expected: build passes. (The component is exported but not yet imported anywhere — Next.js will tree-shake.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/filters/FilterBar.tsx
git commit -m "Phase B6: FilterBar component"
```

---

## Task B7: PicksLayout (tab bar + page chrome)

**Files:**
- Create: `frontend/src/components/picks/PicksLayout.tsx`

- [ ] **Step 1: Write PicksLayout**

```tsx
"use client";

import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { useLocale } from "@/contexts/LocaleContext";
import type { ReactNode } from "react";

export type PicksTab = "health" | "models" | "explore";

const TABS: PicksTab[] = ["health", "models", "explore"];

export function PicksLayout({ activeTab, children }: { activeTab: PicksTab; children: ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function tabHref(tab: PicksTab): string {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("tab", tab);
    return `${pathname}?${qs.toString()}`;
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--color-text-high)]">{t("picks.title")}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">{t("picks.description")}</p>
        </div>
        <LocaleSwitcher />
      </header>

      <nav className="flex gap-1 rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-1">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tabHref(tab)}
            className={
              tab === activeTab
                ? "rounded-xl bg-[color:var(--color-brand-primary)] px-4 py-2 text-sm font-semibold text-[color:var(--color-text-inverse)]"
                : "rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-brand-surface)]"
            }
          >
            {t(`picks.tabs.${tab}` as any)}
          </Link>
        ))}
      </nav>

      {children}
    </main>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/PicksLayout.tsx
git commit -m "Phase B7: PicksLayout with tab bar"
```

---

## Task B8: HealthTab (replaces PicksDashboard)

**Files:**
- Create: `frontend/src/components/picks/tabs/HealthTab.tsx`

- [ ] **Step 1: Write HealthTab**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { fetchStats, fetchHistory, type StatsRow, type HistoryResponse } from "@/lib/api-picks";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; sevenDay: StatsRow[]; thirty: StatsRow[]; today: StatsRow[]; history: HistoryResponse }
  | { kind: "error"; message: string };

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400e3).toISOString();
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function HealthTab() {
  const { t } = useLocale();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [global7, perModel7, today, history] = await Promise.all([
          fetchStats([], { status: "settled", dateFrom: isoDaysAgo(7) }),
          fetchStats(["model"], { status: "settled", dateFrom: isoDaysAgo(7) }),
          fetchStats([], { status: "all", dateFrom: isoDaysAgo(1) }),
          fetchHistory({ limit: 5 }),
        ]);
        if (cancelled) return;
        setState({
          kind: "ok",
          sevenDay: global7.rows,
          thirty: perModel7.rows,
          today: today.rows,
          history,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "load failed",
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <div className="text-sm text-[color:var(--color-text-muted)]">{t("picks.loading")}</div>;
  }
  if (state.kind === "error") {
    return <div className="text-sm text-[color:var(--color-text-high)]">{t("picks.error")}: {state.message}</div>;
  }

  const sevenDay = state.sevenDay[0];
  const today = state.today[0];

  // KPIs
  const kpis = [
    {
      label: t("picks.kpi.picksToday"),
      value: today?.n != null ? String(today.n) : "0",
    },
    {
      label: t("picks.kpi.hitRate7d"),
      value: fmtPct(sevenDay?.hit_rate ?? null),
    },
    {
      label: t("picks.kpi.pnl7d"),
      value: fmtNum(sevenDay?.pnl_total, 2),
    },
    {
      label: t("picks.kpi.clv7d"),
      value: fmtNum(sevenDay?.mean_clv, 4),
    },
  ];

  const latestRecommended = state.history.rows[0]?.recommended_at;
  const latestSettled = state.history.rows.find((r) => r.status === "settled")?.recommended_at;

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
            <div className="text-xs text-[color:var(--color-text-muted)]">{k.label}</div>
            <div className="mt-1 text-2xl font-bold text-[color:var(--color-text-high)]">{k.value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.freshness.title")}</h2>
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div>{t("picks.freshness.recordPicks")}: <b>{fmtRelativeTime(latestRecommended)}</b></div>
          <div>{t("picks.freshness.settle")}: <b>{fmtRelativeTime(latestSettled)}</b></div>
          <div>{t("picks.freshness.pending")}: <b>{state.thirty.reduce((acc, _) => acc, 0)}</b></div>
        </div>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.snapshot.title")}</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.filter.model")}</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.roi")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.meanClv")}</th>
            </tr>
          </thead>
          <tbody>
            {state.thirty.length === 0 ? (
              <tr><td className="px-2 py-3 text-[color:var(--color-text-muted)]" colSpan={5}>—</td></tr>
            ) : (
              state.thirty.map((row) => (
                <tr key={String(row.model)} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-2 font-semibold text-[color:var(--color-text-high)]">
                    <a href={`./picks/model/${row.model}`} className="underline">{String(row.model)}</a>
                  </td>
                  <td className="px-2 py-2">{row.n}</td>
                  <td className="px-2 py-2">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2">{fmtPct(row.roi)}</td>
                  <td className="px-2 py-2">{fmtNum(row.mean_clv, 4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/tabs/HealthTab.tsx
git commit -m "Phase B8: HealthTab"
```

---

## Task B9: Replace /picks page + remove PicksDashboard

**Files:**
- Modify: `frontend/src/app/[locale]/picks/page.tsx`
- Delete: `frontend/src/components/PicksDashboard.tsx`

- [ ] **Step 1: Replace page.tsx**

Overwrite `frontend/src/app/[locale]/picks/page.tsx` (preserving the existing `generateStaticParams` shape):

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { PicksLayout, type PicksTab } from "@/components/picks/PicksLayout";
import { HealthTab } from "@/components/picks/tabs/HealthTab";

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

const VALID_TABS: PicksTab[] = ["health", "models", "explore"];

export default function PicksPage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { tab?: string };
}) {
  if (!isLocale(params.locale)) {
    notFound();
  }
  const tab: PicksTab =
    VALID_TABS.includes(searchParams.tab as PicksTab)
      ? (searchParams.tab as PicksTab)
      : "health";

  return (
    <PicksLayout activeTab={tab}>
      {tab === "health" && <HealthTab />}
      {tab === "models" && (
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
          Models tab — implemented in Phase C
        </div>
      )}
      {tab === "explore" && (
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
          Explore tab — implemented in Phase D
        </div>
      )}
    </PicksLayout>
  );
}
```

- [ ] **Step 2: Remove the old PicksDashboard.tsx**

```bash
rm frontend/src/components/PicksDashboard.tsx
```

- [ ] **Step 3: Smoke test by starting Next.js + FastAPI**

Start FastAPI:

```bash
APP_STORAGE_DB_PATH=/Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  python3 -m uvicorn src:app --host 127.0.0.1 --port 8000 &
```

Start Next.js (in another terminal or background):

```bash
cd frontend && npm run dev &
```

Visit `http://localhost:3000/en/picks?tab=health` and confirm:
- Page renders.
- KPI cards show numbers.
- Per-model snapshot table shows the dixon_coles row (or "—" if no settled bets yet).
- Tab bar links to `?tab=models` and `?tab=explore` (placeholders).

Then stop both processes.

- [ ] **Step 4: Run frontend lint+build**

```bash
cd frontend && npm run lint && npm run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/\[locale\]/picks/page.tsx
git rm frontend/src/components/PicksDashboard.tsx
git commit -m "Phase B9: replace /picks page with tabbed layout"
```

---

# Phase C — Models tab

## Task C1: Chart primitives — CumulativeLineChart

**Files:**
- Create: `frontend/src/components/picks/charts/CumulativeLineChart.tsx`

- [ ] **Step 1: Write CumulativeLineChart with visx**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { LinePath } from "@visx/shape";
import { useMemo } from "react";

export type Series = {
  label: string;
  color: string;
  points: { x: number; y: number }[];
};

interface CumulativeLineChartProps {
  series: Series[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

export function CumulativeLineChart({
  series,
  width = 720,
  height = 240,
  xLabel = "",
  yLabel = "",
}: CumulativeLineChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allPoints = useMemo(
    () => series.flatMap((s) => s.points),
    [series],
  );

  const xExtent = useMemo<[number, number]>(() => {
    if (allPoints.length === 0) return [0, 1];
    const xs = allPoints.map((p) => p.x);
    return [Math.min(...xs), Math.max(...xs)];
  }, [allPoints]);
  const yExtent = useMemo<[number, number]>(() => {
    if (allPoints.length === 0) return [0, 1];
    const ys = allPoints.map((p) => p.y);
    return [Math.min(0, ...ys), Math.max(0, ...ys)];
  }, [allPoints]);

  const xScale = scaleLinear<number>({ domain: xExtent, range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });

  if (allPoints.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="cumulative line chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        {/* y=0 reference */}
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="4 4" />
        {series.map((s) => (
          <LinePath
            key={s.label}
            data={s.points}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke={s.color}
            strokeWidth={2}
          />
        ))}
        {/* legend */}
        <Group left={innerW - 80} top={4}>
          {series.map((s, i) => (
            <Group key={s.label} top={i * 14}>
              <line x1={0} x2={14} y1={5} y2={5} stroke={s.color} strokeWidth={2} />
              <text x={18} y={9} fontSize={10} fill="currentColor">{s.label}</text>
            </Group>
          ))}
        </Group>
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/CumulativeLineChart.tsx
git commit -m "Phase C1: CumulativeLineChart visx primitive"
```

---

## Task C2: Chart primitive — HeatmapChart

**Files:**
- Create: `frontend/src/components/picks/charts/HeatmapChart.tsx`

- [ ] **Step 1: Write HeatmapChart**

```tsx
"use client";

import { useMemo } from "react";

export type HeatmapCell = {
  row: string;
  col: string;
  value: number | null;
  n: number;
};

interface HeatmapChartProps {
  cells: HeatmapCell[];
  rows: string[];
  cols: string[];
  // Map a value in [-vmax, vmax] to a CSS color (typically red→neutral→green).
  colorScale?: (v: number, vmax: number) => string;
  minNToShow?: number;
  width?: number;
  cellHeight?: number;
}

function defaultColorScale(v: number, vmax: number): string {
  // Linear blend between three stops: red (-1), neutral (0), green (+1).
  const t = Math.max(-1, Math.min(1, v / (vmax || 1)));
  if (t >= 0) {
    // neutral → green
    const r = Math.round(232 - t * (232 - 200));
    const g = Math.round(232 + t * (230 - 232));
    const b = Math.round(232 - t * (232 - 200));
    return `rgb(${r},${g},${b})`;
  } else {
    const r = Math.round(232 + (-t) * (252 - 232));
    const g = Math.round(232 - (-t) * (232 - 224));
    const b = Math.round(232 - (-t) * (232 - 224));
    return `rgb(${r},${g},${b})`;
  }
}

export function HeatmapChart({
  cells,
  rows,
  cols,
  colorScale = defaultColorScale,
  minNToShow = 1,
  width = 720,
  cellHeight = 32,
}: HeatmapChartProps) {
  const cellWidth = (width - 100) / cols.length;
  const map = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    cells.forEach((c) => m.set(`${c.row}::${c.col}`, c));
    return m;
  }, [cells]);
  const vmax = useMemo(() => {
    const vals = cells
      .filter((c) => c.value !== null && c.n >= minNToShow)
      .map((c) => Math.abs(c.value as number));
    return vals.length === 0 ? 0.05 : Math.max(...vals);
  }, [cells, minNToShow]);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ minWidth: 100 }} />
            {cols.map((c) => (
              <th key={c} style={{ minWidth: cellWidth, padding: "4px 6px", textAlign: "center" }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td style={{ padding: "4px 6px", fontWeight: 600 }}>{r}</td>
              {cols.map((c) => {
                const cell = map.get(`${r}::${c}`);
                if (!cell || cell.value === null || cell.n < minNToShow) {
                  return (
                    <td
                      key={c}
                      style={{ height: cellHeight, background: "#e0e0e0", textAlign: "center", color: "#888" }}
                      title={cell ? `n=${cell.n} (too small)` : "no data"}
                    >
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={c}
                    style={{
                      height: cellHeight,
                      background: colorScale(cell.value, vmax),
                      textAlign: "center",
                      color: "#222",
                    }}
                    title={`${r} × ${c}: ${cell.value.toFixed(3)} (n=${cell.n})`}
                  >
                    {(cell.value * 100).toFixed(1)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/HeatmapChart.tsx
git commit -m "Phase C2: HeatmapChart primitive"
```

---

## Task C3: Chart primitive — ViolinChart

**Files:**
- Create: `frontend/src/components/picks/charts/ViolinChart.tsx`

- [ ] **Step 1: Write ViolinChart**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleLinear, scaleBand } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { ViolinPlot, BoxPlot } from "@visx/stat";
import { useMemo } from "react";

export type ViolinSeries = {
  label: string;
  color: string;
  values: number[];
};

interface ViolinChartProps {
  series: ViolinSeries[];
  width?: number;
  height?: number;
  yLabel?: string;
  referenceY?: number;
}

function computeKde(values: number[], bandwidth = 0.02): { value: number; density: number }[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / 30 || 0.001;
  const out: { value: number; density: number }[] = [];
  for (let x = min; x <= max; x += step) {
    let d = 0;
    for (const v of values) {
      const u = (x - v) / bandwidth;
      d += Math.exp(-0.5 * u * u);
    }
    out.push({ value: x, density: d / (values.length * bandwidth * Math.sqrt(2 * Math.PI)) });
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    firstQuartile: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    thirdQuartile: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function ViolinChart({ series, width = 480, height = 240, referenceY }: ViolinChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = useMemo(() => series.flatMap((s) => s.values), [series]);
  const yExtent = useMemo<[number, number]>(() => {
    if (allValues.length === 0) return [0, 1];
    const lo = Math.min(0, ...allValues);
    const hi = Math.max(0, ...allValues);
    return [lo, hi];
  }, [allValues]);

  const xScale = scaleBand<string>({
    domain: series.map((s) => s.label),
    range: [0, innerW],
    padding: 0.3,
  });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });
  const bandWidth = xScale.bandwidth();

  if (allValues.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="violin distribution">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        {referenceY !== undefined && (
          <line x1={0} x2={innerW} y1={yScale(referenceY)} y2={yScale(referenceY)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        )}
        {series.map((s) => {
          const cx = (xScale(s.label) ?? 0) + bandWidth / 2;
          const stats = summary(s.values);
          return (
            <Group key={s.label} left={cx}>
              <ViolinPlot
                data={computeKde(s.values)}
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.35}
                valueScale={yScale}
                width={bandWidth * 0.85}
                horizontal={false}
                count={(d) => d.density}
                value={(d) => d.value}
              />
              <BoxPlot
                min={stats.min}
                max={stats.max}
                left={-bandWidth * 0.18}
                firstQuartile={stats.firstQuartile}
                thirdQuartile={stats.thirdQuartile}
                median={stats.median}
                boxWidth={bandWidth * 0.36}
                fill="white"
                fillOpacity={0.4}
                stroke="#222"
                strokeWidth={1}
                valueScale={yScale}
              />
            </Group>
          );
        })}
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/ViolinChart.tsx
git commit -m "Phase C3: ViolinChart primitive"
```

---

## Task C4: ModelsTab

**Files:**
- Create: `frontend/src/components/picks/tabs/ModelsTab.tsx`

- [ ] **Step 1: Write ModelsTab**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import { fetchStats, fetchHistory, type StatsRow } from "@/lib/api-picks";
import {
  filtersFromSearchParams,
  edgeBucketToRange,
  presetToDateRange,
} from "@/components/picks/filters/filter-types";
import { FilterBar } from "@/components/picks/filters/FilterBar";
import { CumulativeLineChart, type Series } from "@/components/picks/charts/CumulativeLineChart";
import { ViolinChart, type ViolinSeries } from "@/components/picks/charts/ViolinChart";
import { HeatmapChart, type HeatmapCell } from "@/components/picks/charts/HeatmapChart";

const MODEL_COLORS: Record<string, string> = {
  dixon_coles: "#1f77b4",
  hgb: "#ff7f0e",
  logistic: "#d62728",
};

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function ModelsTab() {
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const [leaderboard, setLeaderboard] = useState<StatsRow[]>([]);
  const [pnlSeries, setPnlSeries] = useState<Series[]>([]);
  const [violinSeries, setViolinSeries] = useState<ViolinSeries[]>([]);
  const [modelMarket, setModelMarket] = useState<StatsRow[]>([]);
  const [modelComp, setModelComp] = useState<StatsRow[]>([]);
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [knownMarkets, setKnownMarkets] = useState<string[]>([]);
  const [knownComps, setKnownComps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const dateRange = presetToDateRange(filters.datePreset);
    const edgeRange = filters.edge ? edgeBucketToRange(filters.edge) : {};
    const queryFilters = {
      status: filters.status,
      dateFrom: filters.dateFrom ?? dateRange.dateFrom,
      dateTo: filters.dateTo ?? dateRange.dateTo,
      model: filters.model,
      market: filters.market,
      competition: filters.competition,
      edgeMin: edgeRange.edgeMin,
      edgeMax: edgeRange.edgeMax,
    };

    async function load() {
      try {
        const [lbResp, dayPerModel, mxm, mxc, historyResp] = await Promise.all([
          fetchStats(["model"], queryFilters),
          fetchStats(["model", "day"], queryFilters),
          fetchStats(["model", "market"], queryFilters),
          fetchStats(["model", "competition"], queryFilters),
          // For violin we need raw CLV values; fetch raw history rows.
          fetchHistory({ status: "settled", limit: 5000 }),
        ]);
        if (cancelled) return;
        setLeaderboard(lbResp.rows);

        // Build cumulative P&L per model from day-grouped rows.
        const perModel: Record<string, { x: number; y: number }[]> = {};
        const dayRows = [...dayPerModel.rows].sort(
          (a, b) => String(a.day).localeCompare(String(b.day)),
        );
        let runningByModel: Record<string, number> = {};
        const baseT = dayRows.length > 0 ? Date.parse(String(dayRows[0].day)) : 0;
        for (const row of dayRows) {
          const model = String(row.model);
          runningByModel[model] = (runningByModel[model] ?? 0) + (row.pnl_total ?? 0);
          (perModel[model] ??= []).push({
            x: (Date.parse(String(row.day)) - baseT) / 86400e3,
            y: runningByModel[model],
          });
        }
        setPnlSeries(
          Object.entries(perModel).map(([model, points]) => ({
            label: model,
            color: MODEL_COLORS[model] ?? "#888",
            points,
          })),
        );

        // Build violin series from raw history CLV values.
        const clvByModel: Record<string, number[]> = {};
        for (const r of historyResp.rows) {
          if (r.status === "settled" && r.clv !== null && r.clv !== undefined) {
            (clvByModel[r.model] ??= []).push(r.clv);
          }
        }
        setViolinSeries(
          Object.entries(clvByModel).map(([model, values]) => ({
            label: model,
            color: MODEL_COLORS[model] ?? "#888",
            values,
          })),
        );

        setModelMarket(mxm.rows);
        setModelComp(mxc.rows);

        setKnownModels(Array.from(new Set(lbResp.rows.map((r) => String(r.model)))));
        setKnownMarkets(Array.from(new Set(mxm.rows.map((r) => String(r.market)))));
        setKnownComps(Array.from(new Set(mxc.rows.map((r) => String(r.competition)))));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [filters.datePreset, filters.status, filters.dateFrom, filters.dateTo,
      filters.model?.join(","), filters.market?.join(","),
      filters.competition?.join(","), filters.edge]);

  if (error) {
    return <div className="text-sm">{t("picks.error")}: {error}</div>;
  }

  const mxmCells: HeatmapCell[] = modelMarket.map((r) => ({
    row: String(r.model),
    col: String(r.market),
    value: r.roi,
    n: r.n,
  }));
  const mxcCells: HeatmapCell[] = modelComp.map((r) => ({
    row: String(r.model),
    col: String(r.competition),
    value: r.roi,
    n: r.n,
  }));

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        fields={["date", "status", "market", "competition", "edge"]}
        options={{ markets: knownMarkets, competitions: knownComps }}
      />

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.leaderboard.title")}</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">{t("picks.filter.model")}</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.hitRate")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.roi")}</th>
              <th className="px-2 py-2">{t("picks.deepDive.kpi.meanClv")}</th>
              <th className="px-2 py-2">{t("picks.leaderboard.brier")}</th>
              <th className="px-2 py-2">{t("picks.leaderboard.maxDrawdown")}</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 ? (
              <tr><td className="px-2 py-3 text-[color:var(--color-text-muted)]" colSpan={7}>—</td></tr>
            ) : (
              leaderboard.map((row) => (
                <tr key={String(row.model)} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-2 font-semibold">
                    <a href={`./picks/model/${row.model}`} className="underline">{String(row.model)}</a>
                  </td>
                  <td className="px-2 py-2">{row.n}</td>
                  <td className="px-2 py-2">{fmtPct(row.hit_rate)}</td>
                  <td className="px-2 py-2">{fmtPct(row.roi)}</td>
                  <td className="px-2 py-2">{fmtNum(row.mean_clv, 4)}</td>
                  <td className="px-2 py-2">{fmtNum(row.brier, 4)}</td>
                  <td className="px-2 py-2">{fmtNum(row.max_drawdown, 2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.trend.title")}</h2>
        <CumulativeLineChart series={pnlSeries} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.violin.title")}</h2>
        <ViolinChart series={violinSeries} referenceY={0} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.heatmap.modelMarket")}</h2>
        <HeatmapChart
          cells={mxmCells}
          rows={Array.from(new Set(mxmCells.map((c) => c.row)))}
          cols={Array.from(new Set(mxmCells.map((c) => c.col)))}
          minNToShow={10}
        />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.heatmap.modelCompetition")}</h2>
        <HeatmapChart
          cells={mxcCells}
          rows={Array.from(new Set(mxcCells.map((c) => c.row)))}
          cols={Array.from(new Set(mxcCells.map((c) => c.col)))}
          minNToShow={10}
        />
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Wire ModelsTab into the page**

Open `frontend/src/app/[locale]/picks/page.tsx` and replace the `tab === "models"` placeholder block with:

```tsx
      {tab === "models" && <ModelsTab />}
```

Add at the top:

```tsx
import { ModelsTab } from "@/components/picks/tabs/ModelsTab";
```

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/picks/tabs/ModelsTab.tsx frontend/src/app/\[locale\]/picks/page.tsx
git commit -m "Phase C4: Models tab"
```

---

# Phase D — Explore tab

## Task D1: BucketedBarChart primitive

**Files:**
- Create: `frontend/src/components/picks/charts/BucketedBarChart.tsx`

- [ ] **Step 1: Write BucketedBarChart**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Bar } from "@visx/shape";
import { useMemo } from "react";

export type Bucket = {
  label: string;
  value: number | null;
  n: number;
};

interface BucketedBarChartProps {
  buckets: Bucket[];
  width?: number;
  height?: number;
  referenceY?: number;
  colorFor?: (v: number) => string;
}

export function BucketedBarChart({
  buckets,
  width = 480,
  height = 220,
  referenceY,
  colorFor = (v) => (v >= 0 ? "#3a8e3a" : "#a33"),
}: BucketedBarChartProps) {
  const padding = { top: 16, right: 16, bottom: 36, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const values = useMemo(() => buckets.map((b) => b.value ?? 0), [buckets]);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);

  const xScale = scaleBand<string>({
    domain: buckets.map((b) => b.label),
    range: [0, innerW],
    padding: 0.2,
  });
  const yScale = scaleLinear<number>({ domain: [yMin, yMax || 1], range: [innerH, 0] });

  return (
    <svg width={width} height={height} role="img" aria-label="bucketed bar chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        {referenceY !== undefined && (
          <line x1={0} x2={innerW} y1={yScale(referenceY)} y2={yScale(referenceY)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        )}
        {buckets.map((b) => {
          const x = xScale(b.label) ?? 0;
          const v = b.value ?? 0;
          const y0 = yScale(0);
          const y1 = yScale(v);
          const top = Math.min(y0, y1);
          const h = Math.abs(y0 - y1);
          return (
            <Group key={b.label}>
              <Bar
                x={x}
                y={top}
                width={xScale.bandwidth()}
                height={h}
                fill={colorFor(v)}
                fillOpacity={0.7}
              />
              <text
                x={x + xScale.bandwidth() / 2}
                y={top - 4}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
              >
                n={b.n}
              </text>
            </Group>
          );
        })}
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/BucketedBarChart.tsx
git commit -m "Phase D1: BucketedBarChart primitive"
```

---

## Task D2: ScatterChart primitive

**Files:**
- Create: `frontend/src/components/picks/charts/ScatterChart.tsx`

- [ ] **Step 1: Write ScatterChart**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle } from "@visx/shape";
import { useMemo } from "react";

export type ScatterPoint = {
  x: number;
  y: number;
  category: string;
};

interface ScatterChartProps {
  points: ScatterPoint[];
  colorByCategory: Record<string, string>;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}

export function ScatterChart({
  points,
  colorByCategory,
  width = 720,
  height = 240,
  xLabel,
  yLabel,
}: ScatterChartProps) {
  const padding = { top: 16, right: 16, bottom: 32, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const xExtent = useMemo<[number, number]>(() => {
    if (points.length === 0) return [-0.05, 0.2];
    const xs = points.map((p) => p.x);
    return [Math.min(...xs, 0), Math.max(...xs, 0.05)];
  }, [points]);
  const yExtent = useMemo<[number, number]>(() => {
    if (points.length === 0) return [-1, 1];
    const ys = points.map((p) => p.y);
    return [Math.min(...ys, -1), Math.max(...ys, 1)];
  }, [points]);

  const xScale = scaleLinear<number>({ domain: xExtent, range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: yExtent, range: [innerH, 0] });

  if (points.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="scatter chart">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} label={xLabel} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} label={yLabel} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        <line x1={xScale(0)} x2={xScale(0)} y1={0} y2={innerH} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        {points.map((p, i) => (
          <Circle
            key={i}
            cx={xScale(p.x)}
            cy={yScale(p.y)}
            r={3}
            fill={colorByCategory[p.category] ?? "#888"}
            fillOpacity={0.7}
          />
        ))}
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/ScatterChart.tsx
git commit -m "Phase D2: ScatterChart primitive"
```

---

## Task D3: ExploreTab

**Files:**
- Create: `frontend/src/components/picks/tabs/ExploreTab.tsx`

- [ ] **Step 1: Write ExploreTab**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import { fetchStats, fetchHistory, type StatsRow, type HistoryRow } from "@/lib/api-picks";
import {
  filtersFromSearchParams,
  edgeBucketToRange,
  priceBucketToRange,
  presetToDateRange,
} from "@/components/picks/filters/filter-types";
import { FilterBar } from "@/components/picks/filters/FilterBar";
import { ScatterChart, type ScatterPoint } from "@/components/picks/charts/ScatterChart";
import { BucketedBarChart, type Bucket } from "@/components/picks/charts/BucketedBarChart";
import { HeatmapChart, type HeatmapCell } from "@/components/picks/charts/HeatmapChart";

const MODEL_COLORS: Record<string, string> = {
  dixon_coles: "#1f77b4",
  hgb: "#ff7f0e",
  logistic: "#d62728",
};

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function ExploreTab() {
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [hitByEdge, setHitByEdge] = useState<StatsRow[]>([]);
  const [roiByPrice, setRoiByPrice] = useState<StatsRow[]>([]);
  const [compSel, setCompSel] = useState<StatsRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const dateRange = presetToDateRange(filters.datePreset);
    const edgeRange = filters.edge ? edgeBucketToRange(filters.edge) : {};
    const priceRange = filters.price ? priceBucketToRange(filters.price) : {};
    const q = {
      status: filters.status,
      dateFrom: filters.dateFrom ?? dateRange.dateFrom,
      dateTo: filters.dateTo ?? dateRange.dateTo,
      model: filters.model,
      market: filters.market,
      sport: filters.sport,
      country: filters.country,
      competition: filters.competition,
      selection: filters.selection,
      edgeMin: edgeRange.edgeMin,
      edgeMax: edgeRange.edgeMax,
      priceMin: priceRange.priceMin,
      priceMax: priceRange.priceMax,
    };
    async function load() {
      try {
        const [hist, eb, pb, cs] = await Promise.all([
          fetchHistory({ status: "settled", limit: 1000 }),
          fetchStats(["edge_bucket"], q),
          fetchStats(["price_bucket"], q),
          fetchStats(["competition", "selection"], q),
        ]);
        if (cancelled) return;
        setHistory(hist.rows);
        setHitByEdge(eb.rows);
        setRoiByPrice(pb.rows);
        setCompSel(cs.rows);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [filters.datePreset, filters.status, filters.dateFrom, filters.dateTo,
      filters.model?.join(","), filters.market?.join(","),
      filters.sport?.join(","), filters.country?.join(","),
      filters.competition?.join(","), filters.selection?.join(","),
      filters.edge, filters.price]);

  const scatterPoints: ScatterPoint[] = history
    .filter((r) => r.edge !== null && r.result !== null)
    .map((r) => ({
      x: r.edge as number,
      y: r.result === 1 ? (r.price_at_recommendation - 1) : -1,
      category: r.model,
    }));

  const edgeOrder = ["0-2", "2-5", "5-10", "10-15", "15+"];
  const hitByEdgeBuckets: Bucket[] = edgeOrder
    .map((label) => {
      const row = hitByEdge.find((r) => r.edge_bucket === label);
      return row ? { label, value: row.hit_rate ?? null, n: row.n } : null;
    })
    .filter((b): b is Bucket => b !== null);

  const priceOrder = ["<=1.5", "1.5-2", "2-3", "3-5", "5+"];
  const roiByPriceBuckets: Bucket[] = priceOrder
    .map((label) => {
      const row = roiByPrice.find((r) => r.price_bucket === label);
      return row ? { label, value: row.roi ?? null, n: row.n } : null;
    })
    .filter((b): b is Bucket => b !== null);

  const heatmapCells: HeatmapCell[] = compSel.map((r) => ({
    row: String(r.competition ?? "—"),
    col: String(r.selection ?? "—"),
    value: r.mean_clv ?? null,
    n: r.n,
  }));

  if (error) {
    return <div className="text-sm">{t("picks.error")}: {error}</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        fields={["date", "status", "model", "market", "sport", "country", "competition", "selection", "edge", "price", "bookmaker"]}
      />

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.scatter.title")}</h2>
        <ScatterChart
          points={scatterPoints}
          colorByCategory={MODEL_COLORS}
          xLabel="edge"
          yLabel="realized return"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.buckets.hitByEdge")}</h2>
          <BucketedBarChart buckets={hitByEdgeBuckets} />
        </div>
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.buckets.roiByPrice")}</h2>
          <BucketedBarChart buckets={roiByPriceBuckets} referenceY={0} />
        </div>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.heatmap.competitionSelection")}</h2>
        <HeatmapChart
          cells={heatmapCells}
          rows={Array.from(new Set(heatmapCells.map((c) => c.row)))}
          cols={Array.from(new Set(heatmapCells.map((c) => c.col)))}
          minNToShow={5}
        />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.drilldown.title")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[color:var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2">event</th>
                <th className="px-2 py-2">model</th>
                <th className="px-2 py-2">market</th>
                <th className="px-2 py-2">sel</th>
                <th className="px-2 py-2">price</th>
                <th className="px-2 py-2">edge</th>
                <th className="px-2 py-2">result</th>
                <th className="px-2 py-2">pnl</th>
                <th className="px-2 py-2">clv</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 100).map((r) => (
                <tr key={r.id} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-1 font-mono">{r.event_id}</td>
                  <td className="px-2 py-1">{r.model}</td>
                  <td className="px-2 py-1">{r.market}</td>
                  <td className="px-2 py-1">{r.selection}</td>
                  <td className="px-2 py-1">{fmtNum(r.price_at_recommendation, 2)}</td>
                  <td className="px-2 py-1">{fmtPct(r.edge)}</td>
                  <td className="px-2 py-1">{r.result === 1 ? "W" : r.result === 0 ? "L" : "—"}</td>
                  <td className="px-2 py-1">{fmtNum(r.pnl, 3)}</td>
                  <td className="px-2 py-1">{fmtNum(r.clv, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Wire ExploreTab into the page**

In `frontend/src/app/[locale]/picks/page.tsx`, replace the `tab === "explore"` placeholder block with:

```tsx
      {tab === "explore" && <ExploreTab />}
```

Add import:

```tsx
import { ExploreTab } from "@/components/picks/tabs/ExploreTab";
```

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/picks/tabs/ExploreTab.tsx frontend/src/app/\[locale\]/picks/page.tsx
git commit -m "Phase D3: Explore tab"
```

---

# Phase E — Per-model deep-dive

## Task E1: CalibrationPlot primitive

**Files:**
- Create: `frontend/src/components/picks/charts/CalibrationPlot.tsx`

- [ ] **Step 1: Write CalibrationPlot**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle } from "@visx/shape";
import type { CalibrationBucket } from "@/lib/api-picks";

interface CalibrationPlotProps {
  buckets: CalibrationBucket[];
  width?: number;
  height?: number;
}

export function CalibrationPlot({ buckets, width = 480, height = 480 }: CalibrationPlotProps) {
  const padding = { top: 16, right: 16, bottom: 48, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const xScale = scaleLinear<number>({ domain: [0, 1], range: [0, innerW] });
  const yScale = scaleLinear<number>({ domain: [0, 1], range: [innerH, 0] });

  if (buckets.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  const maxN = Math.max(...buckets.map((b) => b.n));

  return (
    <svg width={width} height={height} role="img" aria-label="calibration plot">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor" }} label="predicted prob" />
        <AxisLeft scale={yScale} numTicks={6} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} label="actual hit rate" />
        <line x1={xScale(0)} y1={yScale(0)} x2={xScale(1)} y2={yScale(1)} stroke="currentColor" strokeOpacity={0.4} strokeDasharray="4 4" />
        {buckets.map((b, i) => {
          const r = 3 + 9 * Math.sqrt(b.n / maxN);
          return (
            <Circle
              key={i}
              cx={xScale(b.mean_pred)}
              cy={yScale(b.hit_rate)}
              r={r}
              fill="#1f77b4"
              fillOpacity={0.7}
            />
          );
        })}
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/CalibrationPlot.tsx
git commit -m "Phase E1: CalibrationPlot primitive"
```

---

## Task E2: WaterfallChart primitive

**Files:**
- Create: `frontend/src/components/picks/charts/WaterfallChart.tsx`

- [ ] **Step 1: Write WaterfallChart**

```tsx
"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Bar } from "@visx/shape";
import { useMemo } from "react";

export type WaterfallBar = {
  label: string;
  value: number;
};

interface WaterfallChartProps {
  bars: WaterfallBar[];
  width?: number;
  height?: number;
}

export function WaterfallChart({ bars, width = 480, height = 220 }: WaterfallChartProps) {
  const padding = { top: 16, right: 16, bottom: 36, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const sorted = useMemo(() => [...bars].sort((a, b) => b.value - a.value), [bars]);
  const values = sorted.map((b) => b.value);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);

  const xScale = scaleBand<string>({
    domain: sorted.map((b) => b.label),
    range: [0, innerW],
    padding: 0.2,
  });
  const yScale = scaleLinear<number>({ domain: [yMin, yMax || 1], range: [innerH, 0] });

  if (sorted.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.6}>
          no data
        </text>
      </svg>
    );
  }

  return (
    <svg width={width} height={height} role="img" aria-label="waterfall by competition">
      <Group left={padding.left} top={padding.top}>
        <AxisBottom top={innerH} scale={xScale} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", angle: -20, textAnchor: "end", dx: -4 }} />
        <AxisLeft scale={yScale} numTicks={5} stroke="currentColor" tickStroke="currentColor" tickLabelProps={{ fontSize: 10, fill: "currentColor", dx: -4, textAnchor: "end" }} />
        <line x1={0} x2={innerW} y1={yScale(0)} y2={yScale(0)} stroke="currentColor" strokeOpacity={0.3} />
        {sorted.map((b) => {
          const x = xScale(b.label) ?? 0;
          const y0 = yScale(0);
          const y1 = yScale(b.value);
          return (
            <Bar
              key={b.label}
              x={x}
              y={Math.min(y0, y1)}
              width={xScale.bandwidth()}
              height={Math.abs(y0 - y1)}
              fill={b.value >= 0 ? "#3a8e3a" : "#a33"}
              fillOpacity={0.7}
            />
          );
        })}
      </Group>
    </svg>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/charts/WaterfallChart.tsx
git commit -m "Phase E2: WaterfallChart primitive"
```

---

## Task E3: ModelDeepDive body

**Files:**
- Create: `frontend/src/components/picks/ModelDeepDive.tsx`

- [ ] **Step 1: Write ModelDeepDive**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  fetchStats,
  fetchCalibration,
  fetchHistory,
  type StatsRow,
  type CalibrationBucket,
  type HistoryRow,
} from "@/lib/api-picks";
import { CalibrationPlot } from "@/components/picks/charts/CalibrationPlot";
import { WaterfallChart } from "@/components/picks/charts/WaterfallChart";

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function ModelDeepDive({ model }: { model: string }) {
  const { t } = useLocale();
  const [summary, setSummary] = useState<StatsRow | null>(null);
  const [bySelection, setBySelection] = useState<StatsRow[]>([]);
  const [byCompetition, setByCompetition] = useState<StatsRow[]>([]);
  const [calibration, setCalibration] = useState<CalibrationBucket[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = { model: [model], status: "settled" as const };
    async function load() {
      try {
        const [single, sel, comp, cal, hist] = await Promise.all([
          fetchStats([], q),
          fetchStats(["selection"], q),
          fetchStats(["competition"], q),
          fetchCalibration(model),
          fetchHistory({ status: "settled", limit: 500 }),
        ]);
        if (cancelled) return;
        setSummary(single.rows[0] ?? null);
        setBySelection(sel.rows);
        setByCompetition(comp.rows);
        setCalibration(cal.buckets);
        setHistory(hist.rows.filter((r) => r.model === model));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [model]);

  if (error) {
    return <div className="text-sm">{t("picks.error")}: {error}</div>;
  }

  const waterfallBars = byCompetition.map((r) => ({
    label: String(r.competition ?? "—"),
    value: r.pnl_total ?? 0,
  }));

  const kpis = [
    { label: t("picks.deepDive.kpi.bets"), value: summary?.n != null ? String(summary.n) : "—" },
    { label: t("picks.deepDive.kpi.hitRate"), value: fmtPct(summary?.hit_rate ?? null) },
    { label: t("picks.deepDive.kpi.roi"), value: fmtPct(summary?.roi ?? null) },
    { label: t("picks.deepDive.kpi.meanClv"), value: fmtNum(summary?.mean_clv, 4) },
    { label: t("picks.deepDive.brierLabel"), value: fmtNum(summary?.brier, 4) },
  ];

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">{model}</h1>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
            <div className="text-xs text-[color:var(--color-text-muted)]">{k.label}</div>
            <div className="mt-1 text-2xl font-bold">{k.value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.deepDive.calibration")}</h2>
        <CalibrationPlot buckets={calibration} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.deepDive.outcomeBreakdown")}</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[color:var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-2">selection</th>
              <th className="px-2 py-2">n</th>
              <th className="px-2 py-2">hit rate</th>
              <th className="px-2 py-2">mean CLV</th>
              <th className="px-2 py-2">roi</th>
            </tr>
          </thead>
          <tbody>
            {bySelection.map((r) => (
              <tr key={String(r.selection)} className="border-t border-[color:var(--color-brand-outline)]">
                <td className="px-2 py-2">{String(r.selection ?? "—")}</td>
                <td className="px-2 py-2">{r.n}</td>
                <td className="px-2 py-2">{fmtPct(r.hit_rate)}</td>
                <td className="px-2 py-2">{fmtNum(r.mean_clv, 4)}</td>
                <td className="px-2 py-2">{fmtPct(r.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.deepDive.waterfall")}</h2>
        <WaterfallChart bars={waterfallBars} />
      </section>

      <section className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--color-text-muted)]">{t("picks.deepDive.bets")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[color:var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-2">event</th>
                <th className="px-2 py-2">market</th>
                <th className="px-2 py-2">sel</th>
                <th className="px-2 py-2">price</th>
                <th className="px-2 py-2">edge</th>
                <th className="px-2 py-2">result</th>
                <th className="px-2 py-2">pnl</th>
                <th className="px-2 py-2">clv</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 100).map((r) => (
                <tr key={r.id} className="border-t border-[color:var(--color-brand-outline)]">
                  <td className="px-2 py-1 font-mono">{r.event_id}</td>
                  <td className="px-2 py-1">{r.market}</td>
                  <td className="px-2 py-1">{r.selection}</td>
                  <td className="px-2 py-1">{fmtNum(r.price_at_recommendation, 2)}</td>
                  <td className="px-2 py-1">{fmtPct(r.edge)}</td>
                  <td className="px-2 py-1">{r.result === 1 ? "W" : r.result === 0 ? "L" : "—"}</td>
                  <td className="px-2 py-1">{fmtNum(r.pnl, 3)}</td>
                  <td className="px-2 py-1">{fmtNum(r.clv, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/picks/ModelDeepDive.tsx
git commit -m "Phase E3: ModelDeepDive body"
```

---

## Task E4: Per-model route

**Files:**
- Create: `frontend/src/app/[locale]/picks/model/[name]/page.tsx`

- [ ] **Step 1: Write the route**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { ModelDeepDive } from "@/components/picks/ModelDeepDive";

// We don't enumerate model names at build time — they're dynamic.
// This avoids the dynamicParams=false constraint used on the main /picks route.
export const dynamicParams = true;

export function generateStaticParams() {
  // Provide one placeholder route per locale to satisfy Next.js. Other
  // names are generated on demand via dynamicParams.
  return locales.flatMap((locale) =>
    ["dixon_coles", "hgb", "logistic"].map((name) => ({ locale, name })),
  );
}

export default function ModelDeepDivePage({
  params,
}: {
  params: { locale: string; name: string };
}) {
  if (!isLocale(params.locale)) {
    notFound();
  }
  return <ModelDeepDive model={params.name} />;
}
```

- [ ] **Step 2: Smoke test**

Start FastAPI + Next.js (as in Task B9) and navigate to `http://localhost:3000/en/picks/model/dixon_coles`. Expect the deep-dive to render with KPI cards (likely "—" until settled bets accumulate), a placeholder calibration plot ("no data"), and an empty bets table.

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/\[locale\]/picks/model
git commit -m "Phase E4: per-model deep-dive route"
```

---

## Task E5: Playwright e2e tests

**Files:**
- Create: `frontend/tests/e2e/picks-dashboard.spec.ts`

- [ ] **Step 1: Write the test file**

```ts
import { expect, test } from "@playwright/test";

const STATS_RESPONSE = {
  group_by: ["model"],
  filters: {},
  rows: [
    {
      model: "dixon_coles",
      n: 42,
      wins: 22,
      hit_rate: 0.524,
      stake_total: 8.4,
      pnl_total: 0.15,
      roi: 0.018,
      mean_clv: 0.011,
      brier: 0.195,
      max_drawdown: 0.8,
    },
  ],
};

const HISTORY_RESPONSE = {
  count: 1,
  rows: [
    {
      id: 1,
      event_id: "evt001",
      model: "dixon_coles",
      market: "OVER_UNDER_2.5_FT",
      selection: "under",
      recommended_at: "2026-05-12T15:00:00Z",
      bet_ts: "2026-05-12T15:00:00Z",
      price_at_recommendation: 2.04,
      closing_price: null,
      model_prob: 0.62,
      devigged_prob: 0.47,
      edge: 0.16,
      kelly_full: 0.27,
      result: null,
      pnl: null,
      clv: null,
      status: "pending",
    },
  ],
};

const CALIBRATION_RESPONSE = {
  model: "dixon_coles",
  n_buckets: 10,
  buckets: [
    { lower: 0.5, upper: 0.6, n: 10, mean_pred: 0.55, hit_rate: 0.52 },
  ],
};

test.describe("picks dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/picks/stats?**", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(STATS_RESPONSE),
        headers: { "content-type": "application/json" },
      });
    });
    await page.route("**/api/picks/stats/calibration?**", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(CALIBRATION_RESPONSE),
        headers: { "content-type": "application/json" },
      });
    });
    await page.route("**/api/picks/history?**", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify(HISTORY_RESPONSE),
        headers: { "content-type": "application/json" },
      });
    });
    await page.route("**/api/picks/summary", async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ totals: {}, per_model: [], per_market: [], settled_series: [] }),
        headers: { "content-type": "application/json" },
      });
    });
  });

  test("Health tab renders KPIs and per-model snapshot", async ({ page }) => {
    await page.goto("/en/picks?tab=health");
    await expect(page.getByText("Paper Trade Picks")).toBeVisible();
    await expect(page.getByText("7-day hit rate")).toBeVisible();
    await expect(page.getByText("dixon_coles")).toBeVisible();
  });

  test("Tab links update the URL", async ({ page }) => {
    await page.goto("/en/picks?tab=health");
    await page.getByRole("link", { name: "Models" }).click();
    await expect(page).toHaveURL(/tab=models/);
  });

  test("Filter selection updates URL on Models tab", async ({ page }) => {
    await page.goto("/en/picks?tab=models");
    const dateSelect = page.locator("select").first();
    await dateSelect.selectOption("30d");
    await expect(page).toHaveURL(/date=30d/);
  });

  test("Model deep-dive page renders calibration section", async ({ page }) => {
    await page.goto("/en/picks/model/dixon_coles");
    await expect(page.getByText("Calibration plot")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the tests**

You need Next.js running. Start it:

```bash
cd frontend && npm run dev &
```

In another shell:

```bash
cd frontend && npm run test:e2e -- tests/e2e/picks-dashboard.spec.ts
```

Expected: 4 passed across all browser projects (chromium/firefox/webkit).

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/e2e/picks-dashboard.spec.ts
git commit -m "Phase E5: Playwright e2e tests for the dashboard"
```

---

# Final verification

## Task F1: Full test suite + manual sanity

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/.claude/worktrees/goofy-mendel-5142e3
python3 -m pytest tests/ml/ -v
```

Expected: all 53 tests pass (43 prior + 10 new in test_paper_trade_stats.py).

- [ ] **Step 2: Run frontend lint + build**

```bash
cd frontend && npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Manual end-to-end check**

Start FastAPI:

```bash
APP_STORAGE_DB_PATH=/Users/jakubhruska/Desktop/_claude/FastAPI_FlashScore/data/flashscore_snapshots.sqlite3 \
  python3 -m uvicorn src:app --host 127.0.0.1 --port 8000 &
```

Start Next.js:

```bash
cd frontend && npm run dev &
```

Open in browser and verify:
- `/en/picks?tab=health` — KPIs + per-model snapshot render.
- `/en/picks?tab=models` — leaderboard + cumulative chart + violin + heatmaps render.
- `/en/picks?tab=explore` — filter bar, scatter, bucket bars, heatmap, drill-down render.
- `/en/picks/model/dixon_coles` — KPIs + calibration plot + outcome breakdown + waterfall render.
- `/cs/picks?tab=health` — Czech translations applied.

No console errors. Stop both servers.

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git status
# If anything's dirty, commit it; otherwise the plan is done.
```
