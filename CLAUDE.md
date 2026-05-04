# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Two cooperating apps share one Postgres database:

- **FastAPI backend** (`app/`) — proxies/scrapes FlashScore odds and match-stats. Single deployment target: ASGI under uvicorn, runs in a Docker container alongside an Arq worker, Postgres, Redis, and a Caddy reverse proxy. (Azure Functions support was removed in the VPS migration.)
- **Next.js 14 frontend** (`frontend/`) — App Router dashboard using React Query, `next-intl` (en/cs), Tailwind, and Playwright e2e tests. API routes under `frontend/src/app/api/` query Postgres directly via Prisma; the FastAPI control plane is reached via Caddy at `/api/*`.

### Snapshot storage — the cross-app contract

Both apps read/write the **same Postgres database**. Schema is owned by Prisma in `frontend/prisma/schema.prisma`; FastAPI mirrors it in `app/db/models.py` (SQLAlchemy 2.0 async ORM) and reads/writes via `app/services/snapshot_repo.py` (`SnapshotRepo`).

- FastAPI: `APP_DATABASE_URL` (or `DATABASE_URL` — pydantic-settings reads `APP_*` first; `extra="ignore"` lets the shared `.env` carry both).
- Frontend/Prisma: `DATABASE_URL` from `frontend/.env`, configured via `frontend/prisma.config.ts` (Prisma 7 — datasource URL lives in `prisma.config.ts`, **not** in `schema.prisma`).

`match_stats_snapshots` rows carry an `is_terminal` flag. When a terminal snapshot exists for an event, the backend short-circuits scraping: `/match-stats/{event_id}` returns the latest terminal row, and `/odds/{event_id}` is served from the latest stored odds. This is load-bearing for cost/rate-limit reasons — preserve it when modifying those endpoints.

### Payload blob store

Raw upstream JSON payloads (~7 GB pre-compression, ~500 MB after gzip) live on the filesystem under `data/blobs/{namespace}/{event_id}/{fetched_at}.json.gz`, one file per snapshot. Postgres rows reference them by `file://` URL in `upstream_blob_url` (odds) and `feed_payloads_blob_url` (match-stats). The blob store is gitignored; in Docker it's mounted into both `api` and `worker` containers as `./data/blobs:/app/data/blobs`.

### FastAPI internals (`app/`)

- `app/main.py` — FastAPI app factory + lifespan + exception handlers + router registration. Calls `configure_logging()` at module load and `configure_telemetry(app)` after construction.
- `app/observability.py` — structlog config, OTel instrumentation (FastAPIInstrumentor, HTTPXClientInstrumentor), correlation-id middleware, OTLP exporter wired via `OTEL_EXPORTER_OTLP_ENDPOINT` env var. Noop fallbacks for tracer/meter when OTel isn't installed.
- `app/dependencies.py` — `@lru_cache`'d factories: `get_blob_store()`, `get_snapshot_repo()`, `get_odds_client()`, `get_match_stats_client()`.
- `app/api/v1/{health,odds,match_stats,bulk_scrape}.py` — APIRouters per resource. The bulk-scrape endpoints are the control plane only; actual job execution runs in the Arq worker.
- `app/config.py` — Pydantic settings with `APP_` env prefix and `extra="ignore"` so the shared root `.env` (POSTGRES_USER, REDIS_URL, OTEL_*, etc.) doesn't fail validation.
- `app/db/engine.py` — async SQLAlchemy engine + session factory behind `@lru_cache`. `get_session()` is a FastAPI dep with rollback-on-exception.
- `app/db/models.py` — SQLAlchemy ORM models mirroring Prisma. Snapshot tables use `BigInteger().with_variant(Integer, "sqlite")` so the in-memory SQLite test path auto-increments correctly.
- `app/db/blob_store.py` — `LocalBlobStore` (gzip-compressed `file://`-URL filesystem store).
- `app/services/snapshot_repo.py` — replaces the old 1073-line `storage.py`. Methods: `save_*_snapshot`, `list_*_snapshots`, `get_terminal_match_stats_snapshot`, `is_event_terminal`. Has no-op `initialize/aclose` for lifespan compatibility.
- `app/services/odds_client.py` / `stats_client.py` — async httpx clients with cache + rate limiter (`aiolimiter`) + circuit breaker (`purgatory`). Cache check sits OUTSIDE the limiter (free hits); cache writes happen INSIDE the breaker (no poisoning on transient failures).
- `app/services/{odds,match_stats}.py` — `map_*_payload` functions transforming upstream JSON into the response schemas under `app/schemas/`. **Locked down by golden-file tests in `tests/unit/test_*_mapper.py`** — 40 captured fixtures from production data.
- `app/services/discovery.py` — `FlashscoreDiscoveryClient` (HTML scraping for event-id discovery).
- `app/services/_terminality.py` — shared `TERMINAL_MATCH_STATUSES` constant.
- `app/workers/{arq_settings,tasks}.py` — Arq worker. `run_bulk_scrape_job` discovers events and enqueues `scrape_event` per match. Each `scrape_event` is idempotent via the terminal short-circuit.

## Commands

### Run the full stack (recommended)

```bash
cp .env.example .env  # then fill in APP_STATS_FEED_SIGN
docker compose up -d
docker compose ps    # all services should be healthy
curl http://localhost/api/health
curl http://localhost/        # frontend
```

For dev with hot reload: `cp docker-compose.override.yml.example docker-compose.override.yml`.

### Backend dev (host Python against compose Postgres+Redis)

```bash
docker compose up -d postgres redis
uv sync
uv run uvicorn app.main:app --reload --port 8000
uv run arq app.workers.arq_settings.WorkerSettings  # in a second terminal
```

When running on the host, swap `postgres` → `localhost` and `redis` → `localhost` in `.env`'s URLs (see header comment in `.env.example`).

### Tests

```bash
uv run pytest                      # 49 tests (40 mapper goldens + 3 blob + 2 SnapshotRepo + 3 resilience + 1 skipped integration)
uv run pytest tests/unit/test_odds_mapper.py -v
uv run mypy app
uv run ruff check app tests scripts
```

### Frontend

```bash
cd frontend
npm install
npm run dev               # :3000, proxied via Caddy at /
npm run lint
npm run build
npm run test:e2e          # Playwright; stubs FastAPI, no backend needed
npm run prisma:deploy     # apply migrations
npm run prisma:generate   # regenerate client after schema changes
```

When changing `frontend/prisma/schema.prisma`, run `prisma:migrate` in dev to create a migration. Because FastAPI also writes the same DB, schema changes need parallel updates in `app/db/models.py`.

## Conventions worth knowing

- The repo uses **uv** as the Python package manager (`pyproject.toml` + `uv.lock`). No `requirements.txt`.
- Prisma is the schema source of truth; SQLAlchemy mirrors it. All DateTime columns use `@db.Timestamptz(6)` on Prisma side and `DateTime(timezone=True)` on SQLAlchemy side — must match.
- Localization is en/cs only via `next-intl`; the `[locale]` segment is part of the App Router structure.
- The Caddy reverse proxy uses `handle_path /api/*` (path-stripping) so FastAPI sees `/health`, not `/api/health`.
- Scraper credentials (`APP_STATS_FEED_SIGN`, `APP_DEFAULT_HEADERS`) are required — the app refuses to start with empty values.

## Historical context

This codebase was originally an Azure Functions HTTP trigger backed by SQLite. A 2026 migration moved it to a Docker Compose stack on a VPS: Postgres replaces SQLite, Arq+Redis replace an in-process job manager, and the monolithic `src.py` was split into focused modules. The migration plan lives at `docs/superpowers/plans/2026-05-03-vps-migration-and-hardening.md` and is an excellent reference for understanding architectural decisions. ~52K production events from the SQLite source were migrated to Postgres + blob store; that data is what `/api/bulk-scrape/jobs` reads from.
