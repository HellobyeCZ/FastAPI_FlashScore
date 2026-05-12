"""One-shot backfill for match_event_summaries.

Walks every event_id present in match_stats_snapshots (and odds_snapshots)
and recomputes a summary row. Uses the latest terminal match-stats payload
when one exists, else the latest non-terminal payload, for the metadata
fields (home_team, sport, country, competition, ...). Counts are derived
by COUNT(*) over each source table.

Idempotent: rebuilds rows from authoritative source data. Existing summary
rows are replaced.

Usage:
    PYTHONPATH=. APP_STORAGE_DB_PATH=/path/to/db python scripts/backfill_event_summaries.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone


def _resolve_db_path() -> str:
    path = os.environ.get("APP_STORAGE_DB_PATH")
    if not path:
        raise SystemExit(
            "APP_STORAGE_DB_PATH must be set (path to flashscore_snapshots.sqlite3)"
        )
    return path


def _safe_str(value):
    if value is None:
        return None
    s = str(value)
    return s if s else None


def _coerce_start_time(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def backfill(db_path: str) -> dict:
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        # 1. Pull the latest match-stats payload per event (prefer terminal).
        stats_rows = conn.execute(
            """
            WITH ranked AS (
                SELECT
                    event_id,
                    fetched_at,
                    is_terminal,
                    match_stats_payload_json,
                    ROW_NUMBER() OVER (
                        PARTITION BY event_id
                        ORDER BY is_terminal DESC, fetched_at DESC
                    ) AS rn
                FROM match_stats_snapshots
            )
            SELECT event_id, fetched_at, match_stats_payload_json
            FROM ranked
            WHERE rn = 1
            """
        ).fetchall()

        # 2. Pull counts and latest fetched_at from both source tables.
        odds_meta = {
            row["event_id"]: (row["n"], row["latest"])
            for row in conn.execute(
                """
                SELECT event_id, COUNT(*) AS n, MAX(fetched_at) AS latest
                FROM odds_snapshots
                GROUP BY event_id
                """
            ).fetchall()
        }
        stats_meta = {
            row["event_id"]: (row["n"], row["latest"])
            for row in conn.execute(
                """
                SELECT event_id, COUNT(*) AS n, MAX(fetched_at) AS latest
                FROM match_stats_snapshots
                GROUP BY event_id
                """
            ).fetchall()
        }

        all_event_ids = set(stats_meta) | set(odds_meta)

        written = 0
        skipped_no_metadata = 0
        for ev_id in all_event_ids:
            payload = None
            for row in stats_rows:
                if row["event_id"] == ev_id:
                    try:
                        payload = json.loads(row["match_stats_payload_json"])
                    except (TypeError, ValueError):
                        payload = None
                    break

            # If we have no stats payload, we can still write a stub row from
            # odds (no team/competition metadata, just counters). That's still
            # useful for downstream readers that only need counts.
            event_obj = (payload or {}).get("event") or {}

            home_team = _safe_str(event_obj.get("home_team"))
            away_team = _safe_str(event_obj.get("away_team"))
            event_name = (
                f"{home_team} vs {away_team}"
                if home_team and away_team
                else None
            )

            odds_count, latest_odds = odds_meta.get(ev_id, (0, None))
            stats_count, latest_stats = stats_meta.get(ev_id, (0, None))

            if not event_obj and not odds_count and not stats_count:
                skipped_no_metadata += 1
                continue

            conn.execute(
                """
                INSERT INTO match_event_summaries (
                    event_id,
                    event_name,
                    home_team,
                    away_team,
                    sport,
                    country,
                    competition,
                    competition_stage,
                    competition_path,
                    start_time_utc,
                    status,
                    status_detail,
                    outcome,
                    odds_snapshot_count,
                    stats_snapshot_count,
                    latest_odds_fetched_at,
                    latest_stats_fetched_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    event_name = COALESCE(excluded.event_name, match_event_summaries.event_name),
                    home_team = COALESCE(excluded.home_team, match_event_summaries.home_team),
                    away_team = COALESCE(excluded.away_team, match_event_summaries.away_team),
                    sport = COALESCE(excluded.sport, match_event_summaries.sport),
                    country = COALESCE(excluded.country, match_event_summaries.country),
                    competition = COALESCE(excluded.competition, match_event_summaries.competition),
                    competition_stage = COALESCE(excluded.competition_stage, match_event_summaries.competition_stage),
                    competition_path = COALESCE(excluded.competition_path, match_event_summaries.competition_path),
                    start_time_utc = COALESCE(excluded.start_time_utc, match_event_summaries.start_time_utc),
                    status = COALESCE(excluded.status, match_event_summaries.status),
                    status_detail = COALESCE(excluded.status_detail, match_event_summaries.status_detail),
                    outcome = COALESCE(excluded.outcome, match_event_summaries.outcome),
                    odds_snapshot_count = excluded.odds_snapshot_count,
                    stats_snapshot_count = excluded.stats_snapshot_count,
                    latest_odds_fetched_at = excluded.latest_odds_fetched_at,
                    latest_stats_fetched_at = excluded.latest_stats_fetched_at,
                    updated_at = excluded.updated_at
                """,
                (
                    ev_id,
                    event_name,
                    home_team,
                    away_team,
                    _safe_str(event_obj.get("sport")),
                    _safe_str(event_obj.get("country")),
                    _safe_str(event_obj.get("competition")),
                    _safe_str(event_obj.get("competition_stage")),
                    _safe_str(event_obj.get("competition_path")),
                    _coerce_start_time(event_obj.get("start_time_utc")),
                    _safe_str(event_obj.get("status")),
                    _safe_str(event_obj.get("status_detail")),
                    _safe_str(event_obj.get("outcome")),
                    odds_count,
                    stats_count,
                    latest_odds,
                    latest_stats,
                    now_iso,
                ),
            )
            written += 1
        conn.commit()
        return {
            "written": written,
            "skipped_no_metadata": skipped_no_metadata,
            "total_events": len(all_event_ids),
        }
    finally:
        conn.close()


def main() -> int:
    db_path = _resolve_db_path()
    report = backfill(db_path)
    print(f"Total events seen:       {report['total_events']}")
    print(f"Summaries upserted:      {report['written']}")
    print(f"Skipped (no metadata):   {report['skipped_no_metadata']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
