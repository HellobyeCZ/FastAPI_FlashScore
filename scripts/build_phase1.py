"""Run the Phase 1 backfills end-to-end: labels → closing_odds → elo.

Idempotent by default (incremental upserts). Pass ``--rebuild`` to wipe
the relevant tables first.

Usage:
    python -m scripts.build_phase1
    python -m scripts.build_phase1 --rebuild
"""
from __future__ import annotations

import argparse
import sys

from app.ml.closing_odds import backfill_closing_odds
from app.ml.elo import backfill_elo, EloConfig
from app.ml.features import get_features
from app.ml.labels import backfill_labels, FOOTBALL_PHASE1_SCOPE


def _print_distribution_report(rebuild: bool) -> None:
    from app.ml import db as ml_db

    print()
    print("=== bet_labels distribution per competition ===")
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """
            SELECT country, competition, COUNT(*) AS n,
                   ROUND(100.0*SUM(CASE outcome_1x2 WHEN 'home' THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_home,
                   ROUND(100.0*SUM(CASE outcome_1x2 WHEN 'draw' THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_draw,
                   ROUND(100.0*SUM(CASE outcome_1x2 WHEN 'away' THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_away,
                   ROUND(100.0*SUM(over_2_5)/COUNT(*),1) AS pct_o25,
                   ROUND(100.0*SUM(btts)/COUNT(*),1) AS pct_btts,
                   ROUND(AVG(total_goals),2) AS avg_goals
            FROM bet_labels GROUP BY country, competition ORDER BY n DESC
            """
        ).fetchall()
        for row in rows:
            print(
                f"  {row['country']:<16}{row['competition']:<22}"
                f"n={row['n']:<6}H/D/A={row['pct_home']}/{row['pct_draw']}/{row['pct_away']}"
                f"  o25={row['pct_o25']}  btts={row['pct_btts']}  avg_goals={row['avg_goals']}"
            )

    print()
    print("=== closing_odds market coverage (top 10) ===")
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """
            SELECT market, COUNT(*) AS n,
                   SUM(CASE WHEN devigged_prob IS NOT NULL THEN 1 ELSE 0 END) AS with_devig
            FROM closing_odds GROUP BY market ORDER BY n DESC LIMIT 10
            """
        ).fetchall()
        for row in rows:
            print(f"  {row['market']:<32}  n={row['n']:<10}  devig={row['with_devig']}")

    print()
    print("=== team_elo_history: latest top-10 teams ===")
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """
            WITH latest AS (
              SELECT team, MAX(start_time_utc) AS last_t
              FROM team_elo_history GROUP BY team
            )
            SELECT h.team, ROUND(h.post_elo,0) AS elo, h.competition
            FROM team_elo_history h
            JOIN latest l ON h.team = l.team AND h.start_time_utc = l.last_t
            ORDER BY h.post_elo DESC LIMIT 10
            """
        ).fetchall()
        for row in rows:
            print(f"  {row['team']:<24}elo={int(row['elo'])}  ({row['competition']})")

    print()
    print("=== worked example: get_features at the closing-line moment ===")
    print("    as_of_ts = kickoff − 5min. The archive's odds row IS the")
    print("    closing line, and the feature builder treats it as known")
    print("    at min(fetched_at, kickoff − 5min). So even if the scraper")
    print("    captured prices after kickoff, the closing-line features")
    print("    are correctly available at this moment.")
    with ml_db.connect(read_only=True) as conn:
        row = conn.execute(
            """
            SELECT b.event_id, b.start_time_utc, o.fetched_at
            FROM bet_labels b
            JOIN odds_snapshots o USING(event_id)
            WHERE b.sport='football'
              AND b.country='ENGLAND'
              AND b.competition='Premier League'
            ORDER BY b.start_time_utc DESC LIMIT 1
            """
        ).fetchone()
    if row:
        from datetime import datetime, timedelta, timezone

        ts = row["start_time_utc"]
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        kickoff = datetime.fromisoformat(ts)
        as_of_dt = kickoff - timedelta(minutes=5)
        as_of = as_of_dt.isoformat().replace("+00:00", "Z")
        print(f"    kickoff={kickoff.isoformat()}")
        print(f"    as_of={as_of}")
        features = get_features(row["event_id"], as_of)
        if features:
            for k, v in features.items():
                if isinstance(v, float):
                    print(f"  {k:<24}{v:.4f}")
                else:
                    print(f"  {k:<24}{v}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true",
                        help="Wipe and rewrite all Phase 1 tables")
    parser.add_argument("--sport", default="football")
    parser.add_argument("--skip-elo", action="store_true",
                        help="Skip the chronological Elo backfill (debug aid)")
    args = parser.parse_args()

    print(f"Phase 1 backfill (sport={args.sport}, rebuild={args.rebuild})")
    print(f"Scope: {len(FOOTBALL_PHASE1_SCOPE)} competitions")

    print()
    print(">>> Step 1/3: labels")
    label_report = backfill_labels(sport=args.sport, rebuild=args.rebuild)
    print(f"  {label_report}")

    print()
    print(">>> Step 2/3: closing_odds (this can take a few minutes)")
    odds_report = backfill_closing_odds(sport=args.sport, rebuild=args.rebuild)
    print(f"  {odds_report}")

    if not args.skip_elo:
        print()
        print(">>> Step 3/3: chronological Elo")
        elo_report = backfill_elo(config=EloConfig(sport=args.sport), rebuild=args.rebuild)
        print(f"  {elo_report}")

    _print_distribution_report(rebuild=args.rebuild)
    return 0


if __name__ == "__main__":
    sys.exit(main())
