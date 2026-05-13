# Frontend Redesign — "Terminal" Cockpit

**Date:** 2026-05-12
**Status:** Design — awaiting implementation plan
**Scope:** `frontend/` only. Backend, Prisma schema, and FastAPI routes are out of scope.

## Goal

Replace the current frontend (`/` odds workbench + `/picks` analytics tabs) with a single unified, keyboard-first "trading terminal" cockpit that the user opens daily. The redesign is purely presentational — same data, same backend, same hooks — but reorganized around a **TODAY** landing page and a left-rail navigation tree.

The audience is a single user (the developer) who wants a Bloomberg-toy feel. The aesthetic must be bold and consistent; the data density is intentionally high. The design system is built so a future Phase 2 (showpiece) or Phase 3 (product for other bettors) can dial back density without rewriting tokens.

## Non-Goals

- No backend changes. No Prisma schema changes.
- No new data products (no new charts, no new metrics).
- No live polling, no flashing cells, no auto-refresh. Refresh is manual.
- No authentication, no multi-user, no mobile-native.
- No animations beyond hover state transitions on links and buttons.

## Aesthetic System

### Typography

- **IBM Plex Mono** — all data, tables, numbers, default body. Sizes: 11 / 12 / 13 / 16 px (data); 20 / 28 / 40 px (hero numbers, tabular figures).
- **IBM Plex Sans Condensed** — section labels, nav, kickers, status-bar text. Used uppercase with `letter-spacing: 0.18em`, sizes 10–11px. Never used for body text.
- No display font. Largest text on the page is Plex Mono at 40px.
- Both loaded via `next/font/google` (self-hosted, no FOUT).

### Color tokens

Declared in `frontend/src/styles/tokens.css` as CSS custom properties under `:root`. Tailwind config maps `theme.extend.colors` to these.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0a0a` | Page background |
| `--surface` | `#111111` | Cards, hover rows |
| `--surface-2` | `#161616` | Active rows, skeleton bars |
| `--border` | `#1f1f1f` | Hairlines (default) |
| `--border-hot` | `#2a2a2a` | Focused/selected hairlines |
| `--text` | `#e8e8e8` | Default text |
| `--text-dim` | `#7a7a7a` | Labels, secondary |
| `--text-faint` | `#4a4a4a` | Axis ticks, metadata |
| `--accent` | `#c8f000` | Brand mark, active state, primary stat, positive delta |
| `--pos` | `#c8f000` | Positive values (alias of accent) |
| `--neg` | `#ff5577` | Negative values, errors, ticks down |
| `--warn` | `#f5a623` | Pending / in-flight |

Single dominant accent (`--accent`). The phosphor lime is used sparingly: brand mark, active rail state, primary hero number, ticker arrows up, positive edge values. Never as a fill.

### Spacing / shape

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 48px.
- **No rounded corners anywhere.** All borders are sharp 1px lines.
- **No shadows.** Depth comes from `--border` vs `--border-hot` and from `--surface` layering.
- All hairlines 1px solid `--border`.

### Glyphs

A small fixed vocabulary, rendered as text (no SVG icons):
`▌` section head · `▸` list item · `─` null / no change · `▲` up · `▼` down · `●` status LED · `└` tree branch · `█ ░` ASCII progress.

A `<Glyph kind>` component centralizes these for consistency.

### Texture

- Faint 14×14px grid underlay on `<body>` only (not on cards): two crossed `linear-gradient`s in `rgba(200,240,0,0.025)`.
- Optional CRT scanline overlay, toggleable in Settings, off by default.

## Shell / Chrome

A single persistent `<Shell>` component wraps every route. Three fixed regions.

### Top bar (32px tall, sticky)

```
▌ FLASHSCORE/TERMINAL · v0.1                                    [EN|CS]  ●
```

- Brand mark in Plex Sans Condensed, wide-tracked, on the left.
- Locale toggle (EN | CS) + a session LED on the right: green (`--accent`) when the last `useDbStats()` query succeeded, red (`--neg`) when it failed, dim (`--text-faint`) when never run. No continuous heartbeat.

### Left rail (180px wide, sticky, full-height)

Plex Sans Condensed, uppercase, 10px, wide-tracked.

```
▌ NAVIGATION

  TODAY
  ODDS
  MATCHES
  PICKS
    └ HEALTH
    └ MODELS
    └ EXPLORE
  JOBS
  ──────────────
  SETTINGS
```

- Active item: `--accent` text + 2px left bar in `--accent`.
- Hover: `--text` from `--text-dim`.
- No icons; typography only.
- `/picks` sub-routes inline in the tree (not behind a click). When inside `/picks/models/[name]`, an extra indented row appears for the active model name.

### Bottom status bar (24px tall, sticky)

```
[ ● ok ]  KEY: F to filter · / to search · G+T today        17:43:02  db: 12,847 rows  build: a4f8b
```

- Left: session LED (`● ok` / `● err`) + page-scoped key-hint cluster (each page registers its own). The LED reflects the last query result of `useDbStats()`: green if it succeeded, red if it failed. There is no continuous heartbeat — status updates only when something fetches.
- Right: locale-aware clock (updates client-side every 1s — the only persistent timer in the app; safe because it's just a `Date.now()` `setInterval`), DB row count from `useDbStats()`, git short SHA from `process.env.NEXT_PUBLIC_BUILD_SHA` (set at build time).
- Plex Mono 10px, `--text-dim`.

### Content area

- Between rail and bottom bar.
- No max-width; pages use full width.
- Padding 24px horizontal, 20px vertical.
- Vertically scrollable; rail + top + bottom stay fixed.

### Responsive

- **≥1024px**: full rail (180px).
- **768–1023px**: rail collapses to 44px icon column with letterform glyphs (`T O M P J S`).
- **<768px**: rail becomes a top drawer toggled by `≡` in the top bar. Bottom status bar stays at all widths but compacts (drops the KEY cluster).

## TODAY page (homepage / cockpit) — `/today`

Single scroll, three bands. Replaces current `/`.

### Band 1 — Hero strip (160px tall)

Three columns, hairline-separated, no card chrome.

| Column | Kicker | Big number | Delta | Micro-vis |
|---|---|---|---|---|
| Model P&L · 30d | `TRAILING 30D · UNITS` | `+6.4u` (Plex Mono 32px, tabular) | `▲ 1.8u vs prev 30d` | 60d sparkline (cumulative line) |
| Today open picks | `TODAY · OPEN` | `12` | `5W 3L 4P` row | Bucket bars (W/L/P/V counts) |
| Scrape queue | `SCRAPE QUEUE` | `3` running | `▸ czech-liga · 18 evts ...` | Top-3 jobs list |

### Band 2 — Today's slate

Wide ruled list of today's picks (`DataTable` primitive). Columns:
`TIME · LEAGUE · MATCH · MARKET · PICK · ODDS · EDGE · MODEL · STATUS`.

- Rows 28px tall.
- Hover: lift to `--surface`.
- Click: navigate to `/matches/[eventId]`.
- `EDGE` colored: `--accent` positive, `--neg` negative, `--text-dim` near-zero (|edge| < 0.5%).
- `STATUS` is a `<StatusToken>` (`OPEN PEND WON LOST VOID`).
- Filter dock above: search input (Plex Mono, `>` prefix) + chip filters for league, model, edge threshold (≥1%, ≥3%, ≥5%).

### Band 3 — Two split panels

- **Left half — Recent settled**: same `DataTable`, last 10 settled picks, `P/L` cell instead of `EDGE`.
- **Right half — Model health snapshot**: terminal-styled calibration plot for the leading model + 3 KPI tiles (Brier, log-loss, sample n). Click → `/picks/health`.

### Empty / loading states

- Empty band: single line `▸ no data — run scrape · press G+J`.
- Loading: `█████` skeleton bars in `--surface-2`. No spinners.

### Keyboard map (Today)

`G+T G+O G+M G+P G+J` jump to sections · `/` focus search · `?` shows the full keyboard overlay.

## Sub-pages

### `/odds` — Live lookup (replaces today's "live" tab)

- Page header: `▌ ODDS · LIVE LOOKUP` + restyled `EventSearchForm`.
- Body splits 60/40:
  - Left: `OddsTable` reskinned as a phosphor sheet — market rows grouped under bordered sub-headers, odds in tabular figures, change arrows in margin.
  - Right: `MatchStatsTable` reskinned as a stacked key-value column.
- A "snapshot strip" at the top of the left panel shows the last 5 stored snapshots for this event with timestamps; click swaps the view to that historical snapshot. Surfaces the terminal-storage feature (`is_terminal` short-circuit) that's load-bearing for cost.

### `/matches` — Match index (replaces "saved" tab + `ScrapedMatchesMenu`)

- Full-width filterable `DataTable` of every match in the local DB.
- Columns: `KICKOFF · COUNTRY · LEAGUE · HOME · AWAY · STATUS · SNAPSHOTS · LAST FETCH`.
- Left-side facets (`<Facets>`): country, league, status, date range. Plex Sans Condensed checklists, no dropdowns.
- Row click → `/matches/[eventId]` (which renders the `/odds` page pre-loaded).

### `/picks/*` — Analytics (existing routes, reskinned)

- The internal tab UI inside `PicksLayout` is **removed**; `health`/`models`/`explore` become first-class rail items.
- Each sub-page gets a `<PageHeader>` with the existing `FilterBar` reskinned (chip = bordered 1px rectangle, no rounding; active = `--accent` text + border).

**`/picks/health`:** Top row = 4 KPI tiles (calibration error, log-loss, Brier, sample n) in hero-strip language. Below: calibration plot + waterfall chart, phosphor-styled.

**`/picks/models`:** Sortable `DataTable` of all models. Row click → `/picks/models/[name]`.

**`/picks/models/[name]`:** Existing `ModelDeepDive` reskinned with new chart language.

**`/picks/explore`:** Scatter + violin + heatmap in a 3-up grid.

### `/jobs` — Bulk scrape (replaces inline `BulkScrapePanel`)

- Top: "new job" form, single row of Plex Mono inputs with `>` prefix glyphs.
- Below: live `DataTable` of running + recent jobs. `PROGRESS` column rendered as ASCII bar (`<AsciiProgress>`). `STATUS` as `<StatusToken>` (`RUN OK ERR`). Cancel button per row: bordered `[KILL]` chip in `--neg` border.

### `/settings` — New

- Locale toggle.
- Default model.
- Dashboard refresh behavior (default: off; can be opted in via interval picker).
- CRT scanline overlay toggle.
- Keyboard cheatsheet (full map).

## Charts — audit + restyle

Single chart language. All charts share:
- `<TerminalAxis>`: `--text-faint` axis lines, `--text-dim` tick labels (Plex Mono 10px).
- `<TerminalTooltip>`: 1px-bordered Plex Mono box, `▸` prefix lines, no shadow.
- Series colors: `--accent` primary, `--neg` negative deltas, `--warn` outside band.
- No fill gradients. Bars: 1-unit-wide solid `--accent` with 1px `--bg` separators ("barcode" look).

**Audit results:**
- **Calibration** — keep (Health, Today right panel).
- **Heatmap** — keep (Explore). Folded `BucketedBarChart` into a small "marginal" beneath the heatmap.
- **Scatter** — keep (Explore).
- **Violin** — keep on Explore only; remove from elsewhere.
- **Waterfall** — keep (Health).
- **Cumulative** — repurpose as the `<Sparkline>` primitive reused on hero strip.
- **BucketedBar** — **removed** as a top-level chart; replaced by `<BucketBars>` micro-primitive for hero strips and marginals.

## Component library

Location: `frontend/src/components/terminal/`. All other components compose from these.

### Primitives

- `<Shell>` — owns top bar, rail, status bar, outlet. Owns the keyboard router.
- `<Rail>`, `<RailItem>`, `<RailGroup>` — nav.
- `<PageHeader kicker actions>` — 40px band on every sub-page.
- `<Kicker>` — Plex Sans Condensed, uppercase, wide-tracked label.
- `<Stat label value delta />` — hero-strip cell.
- `<Sparkline data />`, `<BucketBars data />` — micro-vis primitives.
- `<DataTable columns rows onRowClick sortable>` — the ruled sheet table. Sticky header, optional row click, optional column sort with ASCII arrows (`↑↓`).
- `<Facets>` — left-column filter checklist.
- `<Chip selected>` — bordered rectangle chip, no rounding.
- `<Glyph kind>` — single source of truth for glyph vocabulary.
- `<KeyHint>` — `[ G+T ]` styled key cluster.
- `<StatusToken kind>` — `OPEN PEND WON LOST VOID LIVE FT SCHED RUN OK ERR`. Uppercase word with colored left border.
- `<AsciiProgress value />` — `██████░░░░ 62%`.
- `<Sheet open>` — full-width drawer for the `?` overlay and the "new job" composer.

### Charts (in `frontend/src/components/terminal/charts/`)

`<CalibrationPlot>`, `<HeatmapChart>`, `<ScatterChart>`, `<ViolinChart>`, `<WaterfallChart>` — rewritten to consume `<TerminalAxis>` + `<TerminalTooltip>` + token palette.

## State / data

- Existing React Query hooks (`useOddsData`, `useMatchStatsData`, `useScrapedMatchesData`, picks hooks) are kept as-is.
- New hooks:
  - `useToday()` — aggregates picks + jobs + leading-model summary for the homepage. Composed of existing hooks where possible; one new internal API route (`frontend/src/app/api/today/route.ts`) only if necessary to avoid 4× round trips.
  - `useDbStats()` — powers the status bar `db: N rows`. New API route: `frontend/src/app/api/db-stats/route.ts` (counts via Prisma).

## Routing

| Route | Behavior |
|---|---|
| `/` | Redirect → `/today` (locale-aware). |
| `/[locale]` | Redirect → `/[locale]/today`. |
| `/[locale]/today` | TODAY page. |
| `/[locale]/odds` | Live lookup. |
| `/[locale]/matches` | Match index. |
| `/[locale]/matches/[eventId]` | Match detail (renders odds page pre-loaded). |
| `/[locale]/picks/health` | (existing, reskinned, no tab UI) |
| `/[locale]/picks/models` | (existing, reskinned) |
| `/[locale]/picks/models/[name]` | (existing, reskinned) |
| `/[locale]/picks/explore` | (existing, reskinned) |
| `/[locale]/jobs` | Bulk scrape. |
| `/[locale]/settings` | New. |

Existing `/[locale]/picks?tab=...` URLs redirect to the new sub-routes for one release.

## Internationalization

- Existing `useLocale()` typed catalog (`frontend/src/lib/i18n.ts`) gets new keys for the new surfaces. No catalog framework swap.
- All glyph + keyboard chrome stays language-agnostic.
- Status tokens (`OPEN`, `WON`, etc.) get localized labels.

## Keyboard

Single `<Shell>`-level listener. Pages register additions via a `useKeybindings(map)` hook. The `?` sheet shows the merged map.

Global:
- `G+T` Today · `G+O` Odds · `G+M` Matches · `G+P` Picks · `G+J` Jobs · `G+S` Settings
- `/` focus search · `?` show keyboard sheet · `ESC` close sheet / clear search

Page-scoped maps are documented in each page section above.

## Files

### Added

- `frontend/src/styles/tokens.css`
- `frontend/src/components/terminal/*` (all primitives listed above)
- `frontend/src/components/terminal/charts/*` (chart rewrites)
- `frontend/src/hooks/useToday.ts`
- `frontend/src/hooks/useDbStats.ts`
- `frontend/src/hooks/useKeybindings.ts`
- `frontend/src/app/[locale]/today/page.tsx`
- `frontend/src/app/[locale]/odds/page.tsx`
- `frontend/src/app/[locale]/matches/page.tsx`
- `frontend/src/app/[locale]/matches/[eventId]/page.tsx`
- `frontend/src/app/[locale]/jobs/page.tsx`
- `frontend/src/app/[locale]/settings/page.tsx`
- `frontend/src/app/api/today/route.ts` (only if aggregation is needed)
- `frontend/src/app/api/db-stats/route.ts`

### Removed (rebuilt under terminal primitives; names may be reused)

- `frontend/src/app/page.tsx`, `frontend/src/app/[locale]/page.tsx` (replaced by `/today` redirect + page)
- `frontend/src/components/OddsTable.tsx`
- `frontend/src/components/MatchStatsTable.tsx`
- `frontend/src/components/BulkScrapePanel.tsx`
- `frontend/src/components/ScrapedMatchesMenu.tsx`
- `frontend/src/components/ScrapedMatchesTable.tsx`
- `frontend/src/components/EventSearchForm.tsx`
- `frontend/src/components/LocaleSwitcher.tsx`
- `frontend/src/components/LiveRefreshToggle.tsx`
- `frontend/src/components/LiveRegion.tsx`
- `frontend/src/components/picks/PicksLayout.tsx` (tab UI replaced by rail tree)
- `frontend/src/components/picks/charts/BucketedBarChart.tsx` (replaced by `<BucketBars>` micro-primitive)
- `frontend/src/components/picks/charts/*` — superseded by `frontend/src/components/terminal/charts/*`

## Testing

- Playwright e2e: existing odds + matches specs updated to the new selectors.
- New specs:
  - `today.spec.ts` — hero numbers render, slate filters, keyboard shortcuts work.
  - `jobs.spec.ts` — job creation + cancel.
  - `keyboard.spec.ts` — `?` sheet renders, section jumps work.
- Visual snapshots of `<Shell>` (top bar + rail + status) and `<DataTable>` rendered with sample data.

## Accessibility

- All keyboard shortcuts have visible hints in the status bar + `?` overlay.
- Focus rings: 1px `--accent` outline, no rounding.
- All status colors paired with a token word (e.g., `WON` not just green) so color is not the only signal.
- Locale switch keeps date/number formatting via `Intl.*`.
- `prefers-reduced-motion` disables the only animation (hover-state opacity transition, which is already 150ms).

## Out of scope (explicit)

- Backend changes, Prisma schema changes, FastAPI route changes.
- New data products: no new charts, no new metrics, no new endpoints beyond `today` and `db-stats` aggregation helpers.
- Authentication, multi-user, mobile-native.
- Live polling, flashing cells, auto-refresh (manual refresh only).
- Theming beyond the dark phosphor palette. The token layer is structured so a light theme is *possible* later but not delivered now.
