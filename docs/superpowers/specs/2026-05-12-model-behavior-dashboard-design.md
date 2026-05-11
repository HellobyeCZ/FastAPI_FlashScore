# Model Behavior Dashboard — Design

**Status:** Draft for review
**Date:** 2026-05-12
**Branch:** `claude/goofy-mendel-5142e3`
**Supersedes:** none — extends the minimal Phase 4c dashboard at `frontend/src/app/[locale]/picks/`
**Related:** Phase 4a serving endpoints, Phase 4b paper-trade log

## Goal

Replace the minimal Phase 4c dashboard with a three-tab analytics surface that supports three rhythms of use, in priority order:

1. **Health** — daily check that the pipeline is running and recent performance isn't drifting.
2. **Model comparison** — weekly review of which model wins on which sport / market / league.
3. **Exploration** — pattern discovery via heavy filtering, heatmaps, and scatter views.

A per-model deep-dive page is linked from the comparison tab for calibration, outcome breakdown, and full bet history per model.

This is read-only. Picks remain recorded by `scripts/record_picks.py` and settled by `scripts/settle_paper_bets.py`. Future redesigns may rework UI/UX entirely; this spec is one milestone, not a permanent end state.

## Non-goals

- No write surface (the UI never records, settles, or modifies bets).
- No real-money serving — paper-trade only.
- No alerts / notifications — pipeline freshness is shown but does not page.
- No multi-user features — this is a single-user analytics surface.
- No Phase-3 calibration *plot* on every tab — only on the per-model deep-dive (per Q4 of brainstorming).

## Scope summary

**Slicing dimensions** (9 supported as filters — `bookmaker` deferred per Open Questions §1):
model, market, sport, country, competition, selection, edge bucket, price bucket, time. The Exploration filter bar UI reserves a slot for `bookmaker` but renders it disabled with a tooltip until per-bookmaker pick recording lands.

**Data volume:** designed for low-thousands of `paper_bets` rows. Aggregations dominate; individual-row views remain feasible.

**Charting:** [visx](https://airbnb.io/visx) tree-shakable React + d3 wrappers. Pure SVG primitives where the existing renderer style fits (e.g. the existing reliability SVG).

**State management:** URL query params for filters (shareable, browser-history friendly). No localStorage layer.

## URL structure

| URL | Description |
|---|---|
| `/{locale}/picks` (default tab) | Health |
| `/{locale}/picks?tab=health` | Health tab explicit |
| `/{locale}/picks?tab=models&date=90d&market=OU` | Model comparison with filters |
| `/{locale}/picks?tab=explore&date=90d&competition=EPL&edge=5-10` | Exploration with filters |
| `/{locale}/picks/model/[name]?date=90d` | Per-model deep-dive |

Tabs share the same filter-state shape. Filters applicable only to certain tabs are silently ignored on other tabs.

## Tab 1 — Health

**Goal:** answer "is everything OK?" in 5 seconds.

**Sections** (top to bottom):

1. **Four KPI cards** — Picks today, 7-day hit rate, 7-day P&L (units), 7-day mean CLV. Delta annotation vs prior period.
2. **Cumulative P&L + CLV trend (90 days)** — dual-axis line chart over settled bets sorted by `settled_at`.
3. **Pipeline freshness panel** — last live-odds cycle, last record_picks run, last settle run, pending bet count, upcoming fixture count. Each shows a relative timestamp + a status indicator (✓ if within expected cadence, ⚠ if late, ✗ if missing).
4. **Per-model 7-day snapshot table** — Picks, Hit %, ROI, Mean CLV, simple trend arrow (↗ / → / ↘ based on whether ROI in last-7-days is ≥1pp better, within ±1pp of, or ≥1pp worse than ROI in the 7 days prior). Model name links to the deep-dive.

**No filters** on the Health tab. It's intentionally a fixed view of "now and recent."

## Tab 2 — Model Comparison

**Goal:** which model wins on which slice?

**Sections:**

1. **Filter bar** — Date range (24h/7d/30d/90d/all/custom), Status (settled/pending/all), Market, Competition, Edge bucket.
2. **Leaderboard** — sortable table: Model, Bets, Hit %, ROI, Mean CLV, Brier, Max Drawdown. Model name links to deep-dive.
3. **Cumulative P&L per model** — overlaid line chart over settled bets.
4. **CLV distribution per model** — violin/box plots side by side, with a dashed reference line at CLV=0.
5. **ROI heatmap: model × market** — green/red cells with ROI %.
6. **ROI heatmap: model × competition** (top N competitions) — same color scheme.

A model with insufficient bets (configurable threshold, default 10) on a heatmap cell shows "—" instead of a noisy ROI.

## Tab 3 — Exploration

**Goal:** find where edges live, where they don't, and where the model is systematically wrong.

**Sections:**

1. **Full filter bar** — 9 active dimensions (model, market, sport, country, competition, selection, edge bucket, price bucket, date) plus a disabled `bookmaker` slot pending per-bookmaker pick recording.
2. **Edge vs Realized Return scatter** — one dot per settled bet. X axis = `edge`, Y axis = realized return (1 - 1 if win at price P, -1 if loss, scaled). Color = model. A LOESS trend line overlay shows the average return at each edge level.
3. **Hit rate by edge bucket** — bar chart, 5 buckets (0–2 / 2–5 / 5–10 / 10–15 / 15+ %). Sample-size annotation on each bar.
4. **ROI by price bucket** — bar chart with zero line, 5 buckets (≤1.5 / 1.5–2 / 2–3 / 3–5 / 5+). Green/red coloring.
5. **Mean CLV heatmap: competition × selection** — color-coded CLV across (competition, market_selection) cells. Selections are concatenated as "1X2 home", "1X2 draw", ..., "BTTS no".
6. **Filtered-bets drill-down table** — same shape as `/picks/history` rows, sortable, paginated, bound to the current filter set.

## Per-model deep-dive

**URL:** `/{locale}/picks/model/[name]`

**Sections:**

1. **Header** — model name, brief description (e.g. "Dixon-Coles structural model with xG-augmented rates · Phase 3c"), filter strip (Date / Market / Competition).
2. **Five KPI cards** — Bets, Hit %, ROI, Mean CLV, Brier.
3. **Calibration plot** — predicted-probability bins on X, actual hit rate on Y. Each bucket is a circle whose radius scales with bucket sample count. Dashed diagonal = perfect calibration.
4. **Outcome breakdown by selection** — table: selection, n, predicted mean prob, actual hit rate, diff. Diffs colored red/green; persistent diffs across a selection reveal systematic miscalibration.
5. **P&L decomposition by competition (waterfall)** — bar chart of per-competition contribution to total P&L. Reveals single-league dependence.
6. **Full filtered bets list** — sortable, paginated, model-scoped, history-deep.

## Backend changes

### New endpoint: `GET /picks/stats`

Replaces nothing; sits alongside `/picks/summary` and `/picks/history`. One flexible aggregation endpoint, parameterized by `group_by` and a filter dict.

**Query params:**

| Param | Type | Notes |
|---|---|---|
| `group_by` | comma-separated string | e.g. `model,market` — any subset of: `model`, `market`, `sport`, `country`, `competition`, `selection`, `edge_bucket`, `price_bucket`, `day`, `week`, `month` |
| `status` | string | `settled` (default), `pending`, `all` |
| `date_from` / `date_to` | ISO8601 | filter on `recommended_at` (pending) or `settled_at` (settled) |
| `model`, `market`, `sport`, `country`, `competition`, `selection` | comma-separated string | multi-value IN filters |
| `edge_min` / `edge_max` | float | edge range |
| `price_min` / `price_max` | float | `price_at_recommendation` range |
| `min_n_per_group` | int | drop groups with fewer than N bets (default 1) |

**Response shape:**

```json
{
  "group_by": ["model", "market"],
  "filters": {...echoed back...},
  "rows": [
    {
      "model": "dixon_coles",
      "market": "OVER_UNDER_2.5_FT",
      "n": 248,
      "wins": 130,
      "hit_rate": 0.5242,
      "stake_total": 23.5,
      "pnl_total": 0.42,
      "roi": 0.0179,
      "mean_clv": 0.0114,
      "brier": 0.1947,
      "max_drawdown": 4.2
    },
    ...
  ]
}
```

Edge buckets and price buckets are computed on the fly:
- `edge_bucket`: `"0-2"`, `"2-5"`, `"5-10"`, `"10-15"`, `"15+"`
- `price_bucket`: `"<=1.5"`, `"1.5-2"`, `"2-3"`, `"3-5"`, `"5+"`

`day` / `week` / `month` group on `settled_at` (or `recommended_at` for pending). Format: `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`.

### Reuse: `/picks/summary` and `/picks/history`

The Health tab's per-model 7-day snapshot table is **really** a `GROUP BY model` over a 7-day window with `status=settled`. The new `/picks/stats` covers it, but the existing `/picks/summary` already returns nearly the same shape. **Decision: keep `/picks/summary` as-is** (it's already serving the existing minimal dashboard). The new dashboard's Health tab uses `/picks/stats?group_by=model&date_from=7d_ago` for the 7-day window and `/picks/history?limit=...` for the freshness count.

### Backend module: `app/ml/paper_trade_stats.py`

A new module that implements the `/picks/stats` query templating. Keeps `paper_trade.py` focused on record/settle and avoids growing it into a query toolbox. Internally:

- Validate `group_by` against an allowlist.
- Build SQL `SELECT` with safe column references — no string interpolation of user input.
- Bin `edge` and `price` via SQL `CASE WHEN` ranges.
- Compute Brier per group via `AVG((model_prob - result)^2)` (settled rows only).
- Compute max drawdown per group in Python (sort by `settled_at`, scan cumulative P&L).

### Calibration data shape

For the per-model deep-dive's calibration plot, expose:

```
GET /picks/stats/calibration?model=dixon_coles&...
→ { "buckets": [{"lower": 0.0, "upper": 0.1, "n": 14, "mean_pred": 0.063, "hit_rate": 0.071}, ...] }
```

10 equal-width buckets over `[0, 1]` on `model_prob`, computed only over settled rows. Reuse the existing `app.ml.backtest._reliability_buckets` helper.

## Frontend changes

### Component layout

```
frontend/src/app/[locale]/picks/
├── page.tsx                       — tab dispatcher (reads ?tab=); existing file replaced
├── model/[name]/page.tsx          — per-model deep-dive route (new)
└── (no other route files)

frontend/src/components/picks/
├── PicksLayout.tsx                — tab bar + filter bar shell (new)
├── tabs/
│   ├── HealthTab.tsx              — KPI cards + trend + freshness + per-model snapshot
│   ├── ModelsTab.tsx              — leaderboard + cumulative + violin + 2 heatmaps
│   └── ExploreTab.tsx             — scatter + edge buckets + price buckets + heatmap + drill-down
├── charts/                        — visx-based chart primitives (all new)
│   ├── CumulativeLineChart.tsx
│   ├── ViolinChart.tsx
│   ├── ScatterChart.tsx
│   ├── HeatmapChart.tsx
│   ├── CalibrationPlot.tsx
│   ├── WaterfallChart.tsx
│   └── BucketedBarChart.tsx
├── filters/
│   ├── FilterBar.tsx              — composes the individual filter chips
│   └── filter-types.ts            — TS types + URL serialization helpers
└── ModelDeepDive.tsx              — per-model page body

frontend/src/lib/api-picks.ts      — typed wrappers around /picks/stats, /picks/history, /picks/summary
```

The existing `frontend/src/components/PicksDashboard.tsx` is **removed** — its functionality moves into `HealthTab.tsx` (with the small additions for trend + freshness).

### Filter state

Filters live in URL query params. On every change, the component pushes a new history entry via `next/navigation`'s `router.replace`. Reading them happens via `useSearchParams()`.

A small adapter in `filter-types.ts` normalizes URL params ↔ a typed `FiltersState` object. Single source of truth.

### Dependencies

Add to `frontend/package.json`:

```json
"@visx/axis": "^3.x",
"@visx/group": "^3.x",
"@visx/scale": "^3.x",
"@visx/shape": "^3.x",
"@visx/text": "^3.x",
"@visx/tooltip": "^3.x",
"@visx/stat": "^3.x"     // for violin / box
```

Total tree-shaken bundle hit estimated at ~150-200 KB. Acceptable for an analytics-heavy page.

No backend Python dep changes.

### i18n

New `picks.stats.*` and `picks.deepDive.*` keys added to `frontend/src/lib/i18n.ts` for both `en` and `cs`. The existing `picks.*` keys remain in use by HealthTab.

## Edge cases

- **Few or zero settled bets.** Every chart needs an empty state. The cumulative chart shows the existing "No settled bets yet" placeholder; heatmaps show all "—". The per-model deep-dive shows "—" for hit rate / ROI / Brier and a "need more data" message on the calibration plot if `n < 20`.

- **Pending bets in non-default views.** Per-model deep-dive and explore tab respect `status=settled` by default but can be flipped to include pending (which then forces metrics like ROI/Hit-rate to "—" for pending rows).

- **Heatmap cell with low sample size.** Cells where `n < min_n_per_group` (default 10) render as "—" with a tooltip "n too small".

- **Filter conflicts.** Filtering to a competition not present in the data yields an empty result set; the UI renders empty tables and chart placeholders, not errors.

- **Model artifact missing.** If a registered model has no settled bets in the date range, it still appears in the leaderboard but with all "—" values. We don't omit it silently.

- **Bookmaker filter on aggregated stats.** `paper_bets.price_at_recommendation` is an average across books at recommendation time; we don't currently record which bookmaker each pick was sourced from. **Decision:** drop `bookmaker` as a filter on `/picks/stats` initially. Add it later if/when we record per-bookmaker rows. (Updated below in Open Questions.)

- **Time zones.** All timestamps stored in UTC. The UI formats with the user's locale via `Intl.DateTimeFormat({timeZone: "UTC"})` for consistency. Date-range presets ("7d", "30d") are anchored on UTC midnight.

## Testing strategy

- **Backend:** new tests in `tests/ml/test_paper_trade_stats.py` covering: empty result, single group, multi-group, edge/price bucketing correctness, Brier math, max_drawdown math, date filtering. Reuse the existing fixture DB pattern.

- **Frontend:** Playwright tests under `frontend/tests/e2e/picks-dashboard.spec.ts` covering: each tab renders, filter URL serialization round-trips, model deep-dive link from leaderboard navigates correctly, empty state shows placeholder. Reuse the existing Playwright stub pattern for FastAPI.

- **Visual regression:** out of scope. We'll eyeball the redesign anyway.

## Phasing

This spec describes the **complete** new dashboard. Implementation will be sequenced into logical chunks (which the writing-plans skill will lay out). Likely cuts:

- (a) Backend: `/picks/stats` + tests.
- (b) Frontend skeleton: tab bar, filter bar, URL state, replace `PicksDashboard` with new `HealthTab` body.
- (c) Frontend Comparison tab + chart components for it.
- (d) Frontend Exploration tab + remaining chart components.
- (e) Per-model deep-dive page.

Each phase ships its own visible UI and is independently demoable.

## Open questions / deferred decisions

1. **Per-bookmaker recording of picks.** Currently `paper_bets.price_at_recommendation` is an average. To support the bookmaker dimension in the future we'd need either (a) record one `paper_bets` row per bookmaker per pick (4× row count), or (b) add a side table mapping pick → bookmaker → price. Defer to a Phase 5+ if needed.

2. **Sport dimension is football-only today.** The filter is in scope but inactive until hockey/basketball/AF models exist. Leaving the filter scaffolded is cheap and lets us light it up later without changing the UI.

3. **Time-of-day / weekday patterns.** Could surface a "by hour-of-week" heatmap on the Exploration tab. Skipping for now — wait until we have ≥500 settled bets to know if there's signal.

4. **Calibration plot on Health vs Models tab.** Decided in Q4 of brainstorming: deep-dive only. Re-revisit if the lack-of-it on the Comparison tab makes "is model X miscalibrated?" hard to answer quickly.

5. **Export.** No CSV / PNG export at this milestone. Add if it becomes a real need.

## Acceptance criteria

- `/picks?tab=health` renders KPIs, trend chart, freshness, per-model snapshot, all from a real (small) `paper_bets` dataset without errors.
- `/picks?tab=models` filters update the URL and all charts react.
- `/picks?tab=explore` filter bar exposes all 10 dimensions (one inactive, see #1).
- `/picks/model/dixon_coles` shows the deep-dive with calibration plot.
- All Playwright tests pass.
- `npm run lint && npm run build` succeed on the frontend.
- `pytest tests/ml/` continues to pass.

## Out of scope

- Authentication / multi-user.
- Public marketing surface (Phase 5 territory).
- Mobile-first layout polish.
- Animations / transitions beyond visx defaults.
- Real-money advice or live bet placement.
