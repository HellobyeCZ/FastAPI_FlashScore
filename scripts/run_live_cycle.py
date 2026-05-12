"""Run a single live-odds discovery + snapshot cycle manually.

Equivalent to one tick of :class:`LiveOddsScheduler`. Useful for cron, ad-hoc
testing, and the period before the in-process scheduler is enabled in prod.

Usage:
    python -m scripts.run_live_cycle [--window-days 14] [--max-concurrency 4]
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from app.services.bulk_scrape import (
    LiveOddsScheduler,
    LiveOddsSchedulerConfig,
)
from app.services.odds_client import build_odds_client
from app.services.storage import build_snapshot_store


async def _run(window_days: int, max_concurrency: int) -> int:
    snapshot_store = build_snapshot_store()
    await snapshot_store.initialize()
    odds_client = build_odds_client()

    scheduler = LiveOddsScheduler(
        snapshot_store=snapshot_store,
        odds_client=odds_client,
        config=LiveOddsSchedulerConfig(
            enabled=True,
            interval_seconds=28800,
            window_days=window_days,
            max_concurrency=max_concurrency,
            initial_delay_seconds=0,
        ),
    )
    try:
        summary = await scheduler.run_once()
    finally:
        await scheduler.shutdown()
        await odds_client.aclose()

    print("Live odds cycle summary:")
    for key, value in summary.items():
        print(f"  {key}: {value}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window-days", type=int, default=14)
    parser.add_argument("--max-concurrency", type=int, default=4)
    args = parser.parse_args()
    return asyncio.run(_run(args.window_days, args.max_concurrency))


if __name__ == "__main__":
    sys.exit(main())
