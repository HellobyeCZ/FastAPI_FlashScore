# FastAPI FlashScore

A FlashScore odds and match-stats scraper, deployed as a Docker Compose stack:

- **FastAPI** backend with rate-limited / circuit-breaker-protected upstream clients.
- **Arq + Redis** worker for bulk competition+season scrape jobs.
- **Postgres** for snapshot rows + scrape job state.
- **Filesystem blob store** for raw upstream JSON payloads (gzipped, content-addressed).
- **Next.js 14** dashboard for browsing scraped data.
- **Caddy** reverse proxy in front of both apps.

## Quick start

```bash
cp .env.example .env
# Fill in APP_STATS_FEED_SIGN with a current x-fsign value from FlashScore.
docker compose up -d
```

Then:

- API: <http://localhost/api/health>, <http://localhost/api/bulk-scrape/jobs>
- Dashboard: <http://localhost/>

For dev with code hot-reload:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose up
```

## Local Python development (against compose-only Postgres + Redis)

```bash
docker compose up -d postgres redis
uv sync
# Edit .env: swap `postgres` → `localhost` and `redis` → `localhost` in the URLs
uv run uvicorn app.main:app --reload --port 8000
uv run arq app.workers.arq_settings.WorkerSettings   # second terminal
```

## Frontend

```bash
cd frontend
npm install
npm run dev                # :3000
npm run test:e2e           # Playwright, no backend needed
npm run prisma:migrate     # create a new migration after schema edits
```

Prisma schema lives at `frontend/prisma/schema.prisma`; SQLAlchemy mirrors it in `app/db/models.py`. Both must agree.

## Scraper credentials

The two required env vars (no defaults; app refuses to start without them):

| Variable | What it is | Where to get it |
|---|---|---|
| `APP_STATS_FEED_SIGN` | `x-fsign` header value FlashScore expects on the stats feed. Rotates upstream. | Inspect a live browser session against livesport.cz / flashscore.com. |
| `APP_DEFAULT_HEADERS` | JSON object of HTTP headers forwarded to upstream. UA, Accept-Language, Origin, Referer. | Mirror a real browser's request headers. |

## Tests

```bash
uv run pytest          # 48 passing + 1 skipped integration
uv run mypy app
uv run ruff check app tests scripts
```

The mapper tests (`tests/unit/test_*_mapper.py`) are golden-file regressions over 40 captured production payloads — they lock down the parsing logic against accidental changes during refactors.

## Architecture overview

```
Browser
   │
   ▼ http://localhost/
┌───────┐     /api/*      ┌─────────┐
│ Caddy │────────────────▶│ FastAPI │  app.main:app
│       │                 └────┬────┘
│       │     /                │
│       │     ┌──────────┐     │   ┌──────────┐
│       │────▶│ Next.js  │     │   │ Postgres │
└───────┘     └─────┬────┘     │   │ snapshots│
                    │          │   │ + jobs   │
                    │ Prisma   │   └──────────┘
                    └──────────┴──┐    ▲
                                  │    │
                                  │    │ enqueue
                                  ▼    │
                              ┌──────────┐
                              │   Arq    │
                              │  worker  │
                              └────┬─────┘
                                   │
                                   ▼
                       data/blobs/{ns}/{event}/{ts}.json.gz
```

## Plan

The full implementation plan that produced this stack lives at [`docs/superpowers/plans/2026-05-03-vps-migration-and-hardening.md`](docs/superpowers/plans/2026-05-03-vps-migration-and-hardening.md).
