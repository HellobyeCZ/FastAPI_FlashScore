"""Record currently edge-positive picks as pending paper_bets.

Iterates upcoming fixtures in the next ``--hours-ahead`` window, runs
every loaded model on each, and writes any selection with
``edge >= --min-edge`` into ``paper_bets``. Duplicates on
(event_id, model, market, selection) are silently skipped — the
earliest recording wins.

Usage:
    python -m scripts.record_picks
    python -m scripts.record_picks --min-edge 0.03 --hours-ahead 48
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from app.ml.paper_trade import PickInput, record_picks
from app.ml.serving import list_upcoming_events, load_models, predict_event


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours-ahead", type=int, default=72)
    parser.add_argument("--min-edge", type=float, default=0.02)
    parser.add_argument("--model", default=None)
    parser.add_argument("--market", default=None)
    args = parser.parse_args()

    print(f"Recording picks  hours_ahead={args.hours_ahead}  min_edge={args.min_edge}")
    artifacts = load_models()
    upcoming = list_upcoming_events(hours_ahead=args.hours_ahead)
    print(f"  upcoming events: {len(upcoming)}")

    picks: list[PickInput] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for fx in upcoming:
        records = predict_event(fx["event_id"], artifacts)
        for r in records:
            if r.edge is None or r.edge < args.min_edge:
                continue
            if r.market_price is None:
                continue
            if args.model and r.model != args.model:
                continue
            if args.market and r.market != args.market:
                continue
            picks.append(PickInput(
                event_id=fx["event_id"],
                model=r.model,
                market=r.market,
                selection=r.selection,
                bet_ts=now_iso,
                price_at_recommendation=float(r.market_price),
                model_prob=r.model_prob,
                devigged_prob=r.market_devigged,
                edge=r.edge,
                kelly_full=r.kelly_full,
            ))

    inserted = record_picks(picks)
    print(f"  candidate picks: {len(picks)}")
    print(f"  newly inserted:  {inserted}")
    print(f"  duplicates skipped: {len(picks) - inserted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
