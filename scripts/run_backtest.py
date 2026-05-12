"""Run a walk-forward backtest and write outputs (JSON, CSV, SVG).

Usage:
    python -m scripts.run_backtest --model market_implied --train-until 2024-08-01

By default this targets the Phase 1 football scope.

Outputs land in ``reports/<run_label>/``:
    metrics.json        — top-level + reliability buckets
    bets.csv            — one row per bet with the full BetRecord shape
    reliability.svg     — calibration plot
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from app.ml.backtest import render_reliability_svg, run_backtest
from app.ml.labels import FOOTBALL_PHASE1_SCOPE


def _write_outputs(report, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "model": report.model,
        "scope_size": report.scope_size,
        "test_events": report.test_events,
        "total_bets": report.total_bets,
        "hit_rate": report.hit_rate,
        "roi": report.roi,
        "mean_clv": report.mean_clv,
        "brier": report.brier,
        "log_loss": report.log_loss,
        "max_drawdown": report.max_drawdown,
        "config": report.config,
        "reliability_buckets": [asdict(b) for b in report.reliability_buckets],
    }
    (out_dir / "metrics.json").write_text(json.dumps(summary, indent=2))

    with (out_dir / "bets.csv").open("w", newline="") as f:
        if report.bets:
            writer = csv.DictWriter(f, fieldnames=list(asdict(report.bets[0]).keys()))
            writer.writeheader()
            for bet in report.bets:
                writer.writerow(asdict(bet))

    (out_dir / "reliability.svg").write_text(render_reliability_svg(report.reliability_buckets))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="market_implied",
                        help="Registered model name (default: market_implied)")
    parser.add_argument("--train-until", required=True,
                        help="ISO timestamp; test set is events with kickoff > this")
    parser.add_argument("--test-until", default=None,
                        help="Optional upper bound for the test window")
    parser.add_argument("--min-edge", type=float, default=0.02)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--force-bets", action="store_true",
                        help="Disable the edge gate (sanity-check mode)")
    parser.add_argument("--label", default=None,
                        help="Subdirectory name under reports/; defaults to <model>_<timestamp>")
    args = parser.parse_args()

    print(f"Running backtest: model={args.model}  train_until={args.train_until}  "
          f"min_edge={args.min_edge}  force_bets={args.force_bets}")

    report = run_backtest(
        model=args.model,
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.train_until,
        test_until=args.test_until,
        min_edge=args.min_edge,
        kelly_fraction=args.kelly_fraction,
        force_bets=args.force_bets,
    )

    label = args.label or f"{args.model}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out_dir = Path("reports") / label
    _write_outputs(report, out_dir)

    print()
    print(f"Test events:     {report.test_events}")
    print(f"Total bets:      {report.total_bets}")
    if report.total_bets:
        print(f"Hit rate:        {report.hit_rate:.3f}")
        print(f"ROI:             {report.roi:+.4f}  ({report.roi*100:+.2f}%)")
        print(f"Brier:           {report.brier:.4f}")
        print(f"Log loss:        {report.log_loss:.4f}")
        print(f"Max drawdown:    {report.max_drawdown:.2f} units")
        if report.mean_clv is not None:
            print(f"Mean CLV:        {report.mean_clv:+.4f}")
        print()
        print("Reliability buckets (mean_pred → hit_rate, n):")
        for b in report.reliability_buckets:
            print(f"  [{b.lower:.2f}, {b.upper:.2f}):   {b.mean_pred:.3f} → {b.hit_rate:.3f}   n={b.n}")
    print()
    print(f"Outputs written to {out_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
