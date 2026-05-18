"""Train Phase 3b histogram-gradient-boosting classifier.

Same workflow as scripts.train_logistic but:
  - Feature set = BASE + MARKET (12 columns including market_prob_*).
  - Model = sklearn.ensemble.HistGradientBoostingClassifier.
  - Default calib window is wider (2024-02-01 → 2025-02-01) to give the
    isotonic calibrator enough events to fit cleanly.

Outputs:
  reports/hgb_<label>/
    metrics.json
    model.pkl
    reliability_uncalibrated.svg
    reliability_calibrated.svg
    forced_uncalibrated_bets.csv
    forced_calibrated_bets.csv
    gated_calibrated_bets.csv
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
    HGB_FEATURE_COLUMNS,
    build_feature_matrix,
    chronological_split,
    feature_set_hash,
    isotonic_calibrate,
    train_hgb,
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
    parser.add_argument("--train-until", default="2024-02-01T00:00:00Z")
    parser.add_argument("--calib-until", default="2025-02-01T00:00:00Z")
    parser.add_argument("--max-iter", type=int, default=300)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--l2-regularization", type=float, default=0.0)
    parser.add_argument("--min-edge", type=float, default=0.02)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--label", default=None)
    parser.add_argument("--no-mlflow", action="store_true")
    args = parser.parse_args()

    label = args.label or f"hgb_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out_dir = Path("reports") / label
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Phase 3b: histogram gradient boosting ({label}) ===")
    print(f"train_until={args.train_until}   calib_until={args.calib_until}")
    print(f"features ({len(HGB_FEATURE_COLUMNS)}): {', '.join(HGB_FEATURE_COLUMNS)}")

    print("\nStep 1/4: build feature matrix (BASE + market_prob_*)")
    matrix = build_feature_matrix(
        sport="football",
        scope=FOOTBALL_PHASE1_SCOPE,
        columns=HGB_FEATURE_COLUMNS,
    )
    print(f"  total rows: {len(matrix.event_ids)}")
    split = chronological_split(matrix, train_until=args.train_until, calib_until=args.calib_until)
    print(f"  train: {len(split.train.event_ids):>6}   "
          f"calib: {len(split.calib.event_ids):>6}   "
          f"test:  {len(split.test.event_ids):>6}")

    print("\nStep 2/4: fit HGB")
    raw_model = train_hgb(
        split.train,
        max_iter=args.max_iter,
        learning_rate=args.learning_rate,
        max_depth=args.max_depth,
        l2_regularization=args.l2_regularization,
    )

    print("\nStep 3/4: isotonic calibration on calib block")
    cal_model = isotonic_calibrate(raw_model, split.calib)

    print("\nStep 4/4: backtest on test block")
    ml_models.register("hgb_uncal", ml_models.make_trained_model_fn(cal_model, calibrated=False, name_prefix="hgb"))
    ml_models.register("hgb_cal", ml_models.make_trained_model_fn(cal_model, calibrated=True, name_prefix="hgb"))

    print("  - forced uncalibrated:")
    forced_uncal = run_backtest(
        model="hgb_uncal",
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
        model="hgb_cal",
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
        model="hgb_cal",
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.calib_until,
        min_edge=args.min_edge,
        kelly_fraction=args.kelly_fraction,
        force_bets=False,
    )
    _dump_bets(gated_cal.bets, out_dir / "gated_calibrated_bets.csv")
    print(f"      bets={gated_cal.total_bets} brier={gated_cal.brier:.4f} "
          f"logloss={gated_cal.log_loss:.4f} roi={gated_cal.roi:+.4f}")

    model_path = out_dir / "model.pkl"
    cal_model.save(str(model_path))

    metrics = {
        "feature_set_hash": feature_set_hash(HGB_FEATURE_COLUMNS),
        "feature_columns": list(HGB_FEATURE_COLUMNS),
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
            "max_iter": args.max_iter,
            "learning_rate": args.learning_rate,
            "max_depth": args.max_depth,
            "l2_regularization": args.l2_regularization,
            "train_until": args.train_until,
            "calib_until": args.calib_until,
            "kelly_fraction": args.kelly_fraction,
        },
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    if not args.no_mlflow:
        from app.ml.tracking import log_training_run
        from app.ml.market_spec import FOOTBALL_1X2_FT
        run_id = log_training_run(
            model_name="hgb",
            train_until=args.train_until,
            market_spec=FOOTBALL_1X2_FT,
            feature_columns=HGB_FEATURE_COLUMNS,
            n_train_events=len(split.train.event_ids),
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
            trained_model=cal_model,
            artifact_extras={
                "reliability_uncalibrated.svg": render_reliability_svg(forced_uncal.reliability_buckets),
                "reliability_calibrated.svg": render_reliability_svg(forced_cal.reliability_buckets),
            },
        )
        if run_id:
            print(f"[mlflow] logged training run: {run_id}")

    print(f"\nArtifacts: {out_dir}/")
    print()
    print("=== summary ===")
    print(f"Forced uncalibrated Brier: {forced_uncal.brier:.4f}")
    print(f"Forced calibrated   Brier: {forced_cal.brier:.4f}")
    print(f"Reference (market closing) Brier from Phase 2: 0.1957")
    print(f"Reference (logistic uncal) Brier from Phase 3a: 0.2024")
    return 0


if __name__ == "__main__":
    sys.exit(main())
