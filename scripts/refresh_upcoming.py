"""Discover upcoming fixtures for every competition path tracked in
``scrape_jobs`` and upsert them into ``upcoming_fixtures``.

Usage:
    python -m scripts.refresh_upcoming [--window-days 14] [--competition-path PATH]

Exits with a non-zero status only on configuration errors; per-competition
failures are recorded in ``upcoming_discovery_runs`` and logged but do not
abort the run.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from typing import List, Optional

from app.services.bulk_scrape import (
    BulkScrapeDiscoveryError,
    FlashscoreFixturesClient,
)
from app.services.storage import build_snapshot_store


async def _resolve_competition_paths(
    snapshot_store, explicit: Optional[str]
) -> List[str]:
    if explicit:
        return [explicit.strip()]
    return await snapshot_store.list_bulk_scrape_competition_paths()


async def _run(window_days: int, explicit_path: Optional[str]) -> int:
    snapshot_store = build_snapshot_store()
    await snapshot_store.initialize()
    fixtures_client = FlashscoreFixturesClient()
    competition_paths = await _resolve_competition_paths(snapshot_store, explicit_path)

    if not competition_paths:
        print("No competition paths to refresh (scrape_jobs is empty).")
        await fixtures_client.aclose()
        return 0

    total = 0
    for path in competition_paths:
        try:
            fixtures = await fixtures_client.discover_upcoming(
                competition_path=path,
                window_days=window_days,
            )
        except BulkScrapeDiscoveryError as exc:
            await snapshot_store.record_upcoming_discovery_run(
                competition_path=path,
                fixtures_found=0,
                status="failed",
                error=str(exc),
            )
            print(f"[fail] {path}: {exc}")
            continue

        status = "ok" if fixtures else "empty"
        if fixtures:
            payloads = [
                {
                    "event_id": fx.event_id,
                    "sport": fx.sport,
                    "country": fx.country,
                    "competition": fx.competition,
                    "home_team_raw": fx.home_team_raw,
                    "away_team_raw": fx.away_team_raw,
                    "start_time_utc": fx.start_time_utc.isoformat(),
                    "round_label": fx.round_label,
                }
                for fx in fixtures
            ]
            await snapshot_store.upsert_upcoming_fixtures(
                competition_path=path,
                fixtures=payloads,
            )
        await snapshot_store.record_upcoming_discovery_run(
            competition_path=path,
            fixtures_found=len(fixtures),
            status=status,
            error=None,
        )
        total += len(fixtures)
        print(f"[{status}] {path}: {len(fixtures)} fixtures within {window_days}d")

    print(f"\nTotal fixtures upserted: {total} across {len(competition_paths)} competitions.")
    await fixtures_client.aclose()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window-days", type=int, default=14)
    parser.add_argument("--competition-path", type=str, default=None)
    args = parser.parse_args()
    return asyncio.run(_run(args.window_days, args.competition_path))


if __name__ == "__main__":
    sys.exit(main())
