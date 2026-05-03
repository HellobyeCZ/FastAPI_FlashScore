"""Pull 20 random captured payloads from the production SQLite into pytest fixtures.

One-shot script. Run once, commit the fixtures, never run again. Re-running
would silently change the golden set and break Tasks 3/4 — the existence
guard below refuses to overwrite.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

DB_PATH = Path("data/flashscore_snapshots.sqlite3")
ODDS_OUT = Path("tests/fixtures/odds")
STATS_OUT = Path("tests/fixtures/match_stats")
SAMPLE_SIZE = 20


def main() -> None:
    if not DB_PATH.exists():
        sys.exit(f"DB not found at {DB_PATH}. Symlink the production SQLite into ./data/.")

    ODDS_OUT.mkdir(parents=True, exist_ok=True)
    STATS_OUT.mkdir(parents=True, exist_ok=True)

    if any(ODDS_OUT.glob("*_upstream.json")) or any(STATS_OUT.glob("*_feeds.json")):
        sys.exit(
            "Fixtures already exist. Refusing to overwrite — golden tests depend on them. "
            "Delete the fixture files first if you really want to recapture."
        )

    with sqlite3.connect(str(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row

        odds_rows = conn.execute(
            """
            SELECT event_id, upstream_payload_json, odds_payload_json
            FROM odds_snapshots
            ORDER BY RANDOM()
            LIMIT ?
            """,
            (SAMPLE_SIZE,),
        ).fetchall()

        for row in odds_rows:
            (ODDS_OUT / f"{row['event_id']}_upstream.json").write_text(
                row["upstream_payload_json"], encoding="utf-8"
            )
            (ODDS_OUT / f"{row['event_id']}_expected.json").write_text(
                row["odds_payload_json"], encoding="utf-8"
            )

        stats_rows = conn.execute(
            """
            SELECT event_id, feed_payloads_json, match_stats_payload_json
            FROM match_stats_snapshots
            ORDER BY RANDOM()
            LIMIT ?
            """,
            (SAMPLE_SIZE,),
        ).fetchall()

        for row in stats_rows:
            (STATS_OUT / f"{row['event_id']}_feeds.json").write_text(
                row["feed_payloads_json"], encoding="utf-8"
            )
            (STATS_OUT / f"{row['event_id']}_expected.json").write_text(
                row["match_stats_payload_json"], encoding="utf-8"
            )

    print(f"Captured {len(odds_rows)} odds + {len(stats_rows)} match-stats fixtures.")


if __name__ == "__main__":
    main()
