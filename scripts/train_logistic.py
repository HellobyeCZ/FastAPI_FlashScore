"""Train Phase 3a logistic model end-to-end.

  1. Build feature matrix for the full Phase 1 football scope.
  2. Chronological split: train < train_until <= calib < calib_until <= test.
  3. Fit StandardScaler + multinomial LogisticRegression on train.
  4. Fit per-class IsotonicRegression on calib.
  5. Run the Phase 2 backtester twice on test (uncalibrated, calibrated)
     with both forced bets (full distribution) and the default edge gate.
  6. Log everything to MLflow under experiment ``phase3_models``.

Outputs:
  reports/logistic_<timestamp>/
    metrics.json
    model.pkl
    reliability_uncalibrated.svg
    reliability_calibrated.svg
    forced_uncalibrated_bets.csv
    forced_calibrated_bets.csv
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from app.ml import models as ml_models
from app.ml.backtest import render_reliability_svg, run_backtest
from app.ml.labels import FOOTBALL_PHASE1_SCOPE
from app.ml.training import (
    LOGISTIC_FEATURE_COLUMNS,
    build_feature_matrix,
    chronological_split,
    feature_set_hash,
    isotonic_calibrate,
    log_run_to_mlflow,
    train_logistic,
)


def _dump_bets(bets, path: Path) -> None:
    import csv
    if not bets:
        path.write_text("")
        return
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(bets[0]).keys()))
        writer.writeheader()
        for b in bets:
            writer.writerow(asdict(b))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-until", default="2024-08-01T00:00:00Z")
    parser.add_argument("--calib-until", default="2025-02-01T00:00:00Z")
    parser.add_argument("--C", type=float, default=1.0)
    parser.add_argument("--min-edge", type=float, default=0.02)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--label", default=None)
    parser.add_argument("--no-mlflow", action="store_true",
                        help="Skip MLflow logging (still writes local artifacts)")
    args = parser.parse_args()

    label = args.label or f"logistic_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out_dir = Path("reports") / label
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Phase 3a: logistic regression ({label}) ===")
    print(f"train_until={args.train_until}   calib_until={args.calib_until}")
    print(f"features ({len(LOGISTIC_FEATURE_COLUMNS)}): {', '.join(LOGISTIC_FEATURE_COLUMNS)}")

    print("\nStep 1/4: build feature matrix")
    matrix = build_feature_matrix(sport="football", scope=FOOTBALL_PHASE1_SCOPE)
    print(f"  total rows: {len(matrix.event_ids)}")
    split = chronological_split(matrix, train_until=args.train_until, calib_until=args.calib_until)
    print(f"  train: {len(split.train.event_ids):>6}   "
          f"calib: {len(split.calib.event_ids):>6}   "
          f"test:  {len(split.test.event_ids):>6}")

    print("\nStep 2/4: fit logistic")
    raw_model = train_logistic(split.train, C=args.C)

    print("\nStep 3/4: fit isotonic calibration on calib block")
    cal_model = isotonic_calibrate(raw_model, split.calib)

    print("\nStep 4/4: backtest on test block")

    # Register both flavours into the model registry so the existing
    # backtester reuses its full machinery.
    ml_models.register("logistic_uncal", ml_models.make_logistic_model_fn(cal_model, calibrated=False))
    ml_models.register("logistic_cal", ml_models.make_logistic_model_fn(cal_model, calibrated=True))

    test_kickoff_min = split.test.kickoffs[0] if split.test.kickoffs else args.calib_until

    print("  - forced uncalibrated:")
    forced_uncal = run_backtest(
        model="logistic_uncal",
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.calib_until,
        min_edge=0.0,
        kelly_fraction=args.kelly_fraction,
        force_bets=True,
    )
    _dump_bets(forced_uncal.bets, out_dir / "forced_uncalibrated_bets.csv")
    (out_dir / "reliability_uncalibrated.svg").write_text(
        render_reliability_svg(forced_uncal.reliability_buckets)
    )
    print(f"      bets={forced_uncal.total_bets} brier={forced_uncal.brier:.4f} "
          f"logloss={forced_uncal.log_loss:.4f} roi={forced_uncal.roi:+.4f}")

    print("  - forced calibrated:")
    forced_cal = run_backtest(
        model="logistic_cal",
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.calib_until,
        min_edge=0.0,
        kelly_fraction=args.kelly_fraction,
        force_bets=True,
    )
    _dump_bets(forced_cal.bets, out_dir / "forced_calibrated_bets.csv")
    (out_dir / "reliability_calibrated.svg").write_text(
        render_reliability_svg(forced_cal.reliability_buckets)
    )
    print(f"      bets={forced_cal.total_bets} brier={forced_cal.brier:.4f} "
          f"logloss={forced_cal.log_loss:.4f} roi={forced_cal.roi:+.4f}")

    print(f"  - gated calibrated (min_edge={args.min_edge}):")
    gated_cal = run_backtest(
        model="logistic_cal",
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.calib_until,
        min_edge=args.min_edge,
        kelly_fraction=args.kelly_fraction,
        force_bets=False,
    )
    _dump_bets(gated_cal.bets, out_dir / "gated_calibrated_bets.csv")
    print(f"      bets={gated_cal.total_bets} brier={gated_cal.brier:.4f} "
          f"logloss={gated_cal.log_loss:.4f} roi={gated_cal.roi:+.4f}")

    # Persist model and summary metrics.
    model_path = out_dir / "model.pkl"
    cal_model.save(str(model_path))
    metrics = {
        "feature_set_hash": feature_set_hash(),
        "feature_columns": list(LOGISTIC_FEATURE_COLUMNS),
        "train_events": len(split.train.event_ids),
        "calib_events": len(split.calib.event_ids),
        "test_events": len(split.test.event_ids),
        "forced_uncalibrated": {
            "brier": forced_uncal.brier,
            "log_loss": forced_uncal.log_loss,
            "roi": forced_uncal.roi,
            "hit_rate": forced_uncal.hit_rate,
            "reliability_buckets": [asdict(b) for b in forced_uncal.reliability_buckets],
        },
        "forced_calibrated": {
            "brier": forced_cal.brier,
            "log_loss": forced_cal.log_loss,
            "roi": forced_cal.roi,
            "hit_rate": forced_cal.hit_rate,
            "reliability_buckets": [asdict(b) for b in forced_cal.reliability_buckets],
        },
        "gated_calibrated": {
            "min_edge": args.min_edge,
            "total_bets": gated_cal.total_bets,
            "brier": gated_cal.brier,
            "log_loss": gated_cal.log_loss,
            "roi": gated_cal.roi,
            "hit_rate": gated_cal.hit_rate,
            "max_drawdown": gated_cal.max_drawdown,
            "mean_clv": gated_cal.mean_clv,
        },
        "config": {
            "C": args.C,
            "train_until": args.train_until,
            "calib_until": args.calib_until,
            "kelly_fraction": args.kelly_fraction,
        },
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    if not args.no_mlflow:
        run_id = log_run_to_mlflow(
            run_name=label,
            params={
                "model": "logistic",
                "C": args.C,
                "feature_set_hash": feature_set_hash(),
                "feature_columns": ",".join(LOGISTIC_FEATURE_COLUMNS),
                "train_until": args.train_until,
                "calib_until": args.calib_until,
            },
            metrics_uncalibrated={
                "brier": forced_uncal.brier,
                "log_loss": forced_uncal.log_loss,
                "roi": forced_uncal.roi,
                "hit_rate": forced_uncal.hit_rate,
            },
            metrics_calibrated={
                "brier": forced_cal.brier,
                "log_loss": forced_cal.log_loss,
                "roi": forced_cal.roi,
                "hit_rate": forced_cal.hit_rate,
                "gated_total_bets": gated_cal.total_bets,
                "gated_roi": gated_cal.roi,
            },
            reliability_svg_uncalibrated=render_reliability_svg(forced_uncal.reliability_buckets),
            reliability_svg_calibrated=render_reliability_svg(forced_cal.reliability_buckets),
            model_artifact_path=str(model_path),
        )
        if run_id:
            print(f"\nMLflow run_id: {run_id}")
        else:
            print("\nMLflow unavailable; local artifacts written only.")

    print(f"\nArtifacts: {out_dir}/")
    print()
    print("=== summary ===")
    print(f"Forced uncalibrated Brier: {forced_uncal.brier:.4f}")
    print(f"Forced calibrated   Brier: {forced_cal.brier:.4f}")
    print(f"Reference (market closing) Brier from Phase 2: 0.1957")
    return 0


if __name__ == "__main__":
    sys.exit(main())
