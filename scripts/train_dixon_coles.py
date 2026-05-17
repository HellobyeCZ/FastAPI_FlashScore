"""Train Phase 3c Dixon-Coles structural model.

Workflow:
  1. Pull every settled football event in scope with (home_score,
     away_score) and optionally (home_xg, away_xg).
  2. Iterate chronologically and produce per-(event, team) pre-match
     attack/defense rates via xG-augmented EWMA.
  3. Generate uncalibrated probabilities on the test block via the
     bivariate-Poisson + DC tau correction.
  4. Fit temperature scaling on the calibration block.
  5. Backtest both uncalibrated and calibrated forms.

No new sklearn model — pure-Python implementation using app.ml.dixon_coles.

Outputs:
  reports/dixon_coles_<label>/
    metrics.json
    rates_snapshot.json  (compressed map event_id → 4 rates)
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
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.ml import models as ml_models
from app.ml.backtest import render_reliability_svg, run_backtest
from app.ml.dixon_coles import (
    DCConfig,
    apply_temperature,
    estimate_rates_chronological,
    fit_temperature,
    match_probabilities,
)
from app.ml.labels import FOOTBALL_PHASE1_SCOPE
from app.ml.training import (
    collect_events_for_dixon_coles,
    feature_set_hash,
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


def _build_rates_by_event(snapshots, events_by_id):
    """Convert flat snapshot list into per-event home/away rate dicts."""
    rates_by_event: dict = {}
    sides_by_event = defaultdict(dict)
    for snap in snapshots:
        sides_by_event[snap.event_id][snap.side] = snap
    for event_id, sides in sides_by_event.items():
        if "home" not in sides or "away" not in sides:
            continue
        rates_by_event[event_id] = {
            "home_attack": sides["home"].pre_attack,
            "home_defense": sides["home"].pre_defense,
            "away_attack": sides["away"].pre_attack,
            "away_defense": sides["away"].pre_defense,
            "home_matches_seen": sides["home"].matches_seen,
            "away_matches_seen": sides["away"].matches_seen,
        }
    return rates_by_event


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-until", default="2024-02-01T00:00:00Z")
    parser.add_argument("--calib-until", default="2025-02-01T00:00:00Z")
    parser.add_argument("--xg-weight", type=float, default=0.4)
    parser.add_argument("--ewma-half-life", type=int, default=10)
    parser.add_argument("--home-advantage", type=float, default=1.30)
    parser.add_argument("--rho", type=float, default=-0.12)
    parser.add_argument("--min-edge", type=float, default=0.02)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--label", default=None)
    parser.add_argument("--no-mlflow", action="store_true")
    args = parser.parse_args()

    label = args.label or f"dixon_coles_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out_dir = Path("reports") / label
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg = DCConfig(
        xg_weight=args.xg_weight,
        ewma_half_life=args.ewma_half_life,
        home_advantage=args.home_advantage,
        rho=args.rho,
    )

    print(f"=== Phase 3c: Dixon-Coles ({label}) ===")
    print(f"train_until={args.train_until}   calib_until={args.calib_until}")
    print(f"cfg: {cfg}")

    print("\nStep 1/5: pull events")
    events = collect_events_for_dixon_coles(
        sport="football", scope=FOOTBALL_PHASE1_SCOPE,
    )
    print(f"  events: {len(events)}")
    with_xg = sum(1 for e in events if e.get("home_xg") is not None)
    print(f"  with xG: {with_xg} ({100*with_xg/max(1,len(events)):.0f}%)")

    print("\nStep 2/5: chronological rate estimation (EWMA + xG)")
    snapshots = estimate_rates_chronological(events, cfg)
    events_by_id = {e["event_id"]: e for e in events}
    rates_by_event = _build_rates_by_event(snapshots, events_by_id)
    print(f"  rate-snapshots per event: {len(rates_by_event)}")

    print("\nStep 3/5: split test/calib events")
    calib_events = [
        e for e in events
        if args.train_until <= e["start_time_utc"] < args.calib_until
    ]
    test_events = [e for e in events if e["start_time_utc"] >= args.calib_until]
    print(f"  calib events: {len(calib_events)}")
    print(f"  test events:  {len(test_events)}")

    print("\nStep 4/5: fit temperature on calib block")
    # Build (probs, y) on calib events.
    outcome_to_label = {"home": 0, "draw": 1, "away": 2}
    raw_probs_calib = []
    y_calib = []
    for ev in calib_events:
        r = rates_by_event.get(ev["event_id"])
        if r is None:
            continue
        lam_h = r["home_attack"] * r["away_defense"] * cfg.home_advantage * cfg.league_mean_goals
        lam_a = r["away_attack"] * r["home_defense"] * cfg.league_mean_goals
        p_h, p_d, p_a = match_probabilities(lam_h, lam_a, cfg=cfg)
        raw_probs_calib.append([p_h, p_d, p_a])
        # Resolve outcome from scores.
        if ev["home_score"] > ev["away_score"]:
            y_calib.append(0)
        elif ev["home_score"] < ev["away_score"]:
            y_calib.append(2)
        else:
            y_calib.append(1)
    raw_probs_calib = np.asarray(raw_probs_calib)
    y_calib = np.asarray(y_calib)
    T = fit_temperature(raw_probs_calib, y_calib)
    print(f"  optimal temperature T = {T:.3f}  (1.0 = no change)")
    print(f"  (T > 1 means raw probs were too confident; T < 1 means too diffuse)")

    print("\nStep 5/5: backtest on test block")
    ml_models.register("dc_uncal", ml_models.make_dixon_coles_model_fn(rates_by_event, cfg, temperature=1.0))
    ml_models.register("dc_cal", ml_models.make_dixon_coles_model_fn(rates_by_event, cfg, temperature=T))

    print("  - forced uncalibrated:")
    forced_uncal = run_backtest(
        model="dc_uncal",
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
        model="dc_cal",
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
        model="dc_cal",
        scope=FOOTBALL_PHASE1_SCOPE,
        train_until=args.calib_until,
        min_edge=args.min_edge,
        kelly_fraction=args.kelly_fraction,
        force_bets=False,
    )
    _dump_bets(gated_cal.bets, out_dir / "gated_calibrated_bets.csv")
    print(f"      bets={gated_cal.total_bets} brier={gated_cal.brier:.4f} "
          f"logloss={gated_cal.log_loss:.4f} roi={gated_cal.roi:+.4f}")

    # Persist rates snapshot for reproducibility (just the test+calib subset
    # to keep the file small — full file would be 19k entries).
    persisted_rates = {
        eid: rates for eid, rates in rates_by_event.items()
        if eid in {e["event_id"] for e in calib_events + test_events}
    }
    (out_dir / "rates_snapshot.json").write_text(json.dumps(persisted_rates))

    # Per-team latest rates after each team's last settled match. Used
    # at serve time to predict upcoming fixtures whose event_id wasn't
    # in the training set.
    from app.ml.dixon_coles import final_team_rates
    team_latest = {
        team: {"attack": rates.attack, "defense": rates.defense,
               "matches_seen": rates.matches_seen}
        for team, rates in final_team_rates(events, cfg).items()
    }
    (out_dir / "team_latest_rates.json").write_text(json.dumps(team_latest))

    metrics = {
        "model": "dixon_coles",
        "config": {
            "xg_weight": cfg.xg_weight,
            "ewma_half_life": cfg.ewma_half_life,
            "home_advantage": cfg.home_advantage,
            "rho": cfg.rho,
            "max_goals": cfg.max_goals,
            "league_mean_goals": cfg.league_mean_goals,
        },
        "feature_set_hash": feature_set_hash(("dixon_coles_v1",)),
        "train_until": args.train_until,
        "calib_until": args.calib_until,
        "events_total": len(events),
        "events_with_xg": with_xg,
        "calib_events": len(calib_events),
        "test_events": len(test_events),
        "temperature": T,
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
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    if not args.no_mlflow:
        from app.ml.tracking import log_training_run
        from app.ml.market_spec import FOOTBALL_1X2_FT
        run_id = log_training_run(
            model_name="dixon_coles",
            train_until=args.train_until,
            market_spec=FOOTBALL_1X2_FT,
            feature_columns=("home_attack", "home_defense", "away_attack", "away_defense"),
            n_train_events=len(events),
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
            trained_model=rates_by_event,  # the dict of per-event rates
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
    print(f"Forced calibrated   Brier: {forced_cal.brier:.4f}  (temperature={T:.3f})")
    print(f"Reference (market closing)   Brier from Phase 2:  0.1957")
    print(f"Reference (logistic uncal)   Brier from Phase 3a: 0.2024")
    print(f"Reference (HGB uncal)        Brier from Phase 3b: 0.1981")
    return 0


if __name__ == "__main__":
    sys.exit(main())
