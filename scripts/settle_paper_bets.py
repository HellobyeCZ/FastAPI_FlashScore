"""Settle pending paper_bets whose events have terminated.

Walks ``paper_bets`` rows with ``status='pending'``, looks up the
result via ``bet_labels`` and the closing price via ``closing_odds``,
and writes result/pnl/clv. Idempotent: re-running does nothing for
already-settled rows.

Usage:
    python -m scripts.settle_paper_bets
"""
from __future__ import annotations

import argparse
import sys

from app.ml.paper_trade import settle_pending_bets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kelly-stake-unit", type=float, default=1.0,
                        help="Multiplier on kelly_full to get absolute stake")
    args = parser.parse_args()

    summary = settle_pending_bets(kelly_stake_unit=args.kelly_stake_unit)
    print(f"Pending at start:     {summary.pending_at_start}")
    print(f"Settled:              {summary.settled}")
    print(f"Voided:               {summary.voided}")
    print(f"Skipped (no label):   {summary.skipped_no_label}")
    print(f"Skipped (no closing): {summary.skipped_no_closing_price}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
