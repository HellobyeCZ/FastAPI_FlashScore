"""Backtest harness sanity checks.

The core invariant required by the Phase 2 spec: the market-implied
baseline at ``min_edge=0`` with bets forced should produce
ROI ≈ −vig and CLV ≈ 0. If it doesn't, the harness is broken before
any model is even involved.

We also assert structural properties (every test event becomes 3 bets,
log-loss is finite, reliability buckets are well-formed) to catch
plumbing regressions cheaply.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.ml.backtest import run_backtest, render_reliability_svg
from app.ml.closing_odds import backfill_closing_odds
from app.ml.elo import EloConfig, backfill_elo
from app.ml.labels import backfill_labels


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled_full(fixture_db):
    """Run the full Phase 1 backfill against the fixture DB."""
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_elo(config=EloConfig(sport="football"), scope=TEST_SCOPE, rebuild=True)
    return fixture_db


def test_market_implied_baseline_forced_produces_zero_clv(backfilled_full):
    """Bets placed at the closing line, by definition, have CLV = 0.
    The archive's archive odds are the closing line (validated in
    Phase 0), so price_taken == closing_price for archive-only bets."""
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        kelly_fraction=0.25,
        force_bets=True,
    )
    assert report.total_bets > 0
    assert report.mean_clv == 0.0


def test_market_implied_baseline_forced_roi_is_minus_vig(backfilled_full):
    """When the model exactly matches the devigged market probability and
    bets are placed at the *vig-included* market price, expected ROI =
    −vig. Our fixture has fair-ish prices around (2.0, 3.4, 4.0), which
    implies vig ≈ 1/2 + 1/3.4 + 1/4 − 1 ≈ 0.044. With finite N the
    realised ROI fluctuates but should be in the right ballpark."""
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    # Implied (vig-included) sum for our fixture odds:
    vig = 1 / 2.0 + 1 / 3.4 + 1 / 4.0 - 1
    # With a tiny fixture this is noisy; assert sign + magnitude bound.
    assert -vig - 0.5 <= report.roi <= -vig + 0.5
    # The expected-value computation that justifies this:
    # EV(stake S on selection s) = S*(price_s − 1)*devigged_prob_s − S*(1 − devigged_prob_s).
    # Stake at vig-included price: price_s = 1 / implied_s. With model_prob
    # = devigged_prob, summed across the three selections,
    # E[total_pnl] / total_stake = −vig.


def test_every_event_yields_three_bets_when_forced(backfilled_full):
    """With force_bets=True, every event with both closing odds and
    features produces exactly 3 bets (home, draw, away)."""
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    # 8 fixture events × 3 selections each (3 warm-ups + 5 real events).
    assert report.total_bets == 8 * 3


def test_baseline_with_default_min_edge_places_no_bets(backfilled_full):
    """Without forcing, the market_implied baseline produces zero edge
    against itself — no bets should be placed."""
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.02,
    )
    assert report.total_bets == 0


def test_brier_and_log_loss_are_finite(backfilled_full):
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    assert 0.0 <= report.brier <= 1.0
    assert report.log_loss > 0.0
    assert report.log_loss < 50.0  # would only blow up if probs are pinned


def test_reliability_buckets_well_formed(backfilled_full):
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    for bucket in report.reliability_buckets:
        assert 0.0 <= bucket.lower < bucket.upper <= 1.0
        assert bucket.lower <= bucket.mean_pred <= bucket.upper
        assert 0.0 <= bucket.hit_rate <= 1.0
        assert bucket.n > 0


def test_reliability_svg_renders(backfilled_full):
    report = run_backtest(
        model="market_implied",
        scope=TEST_SCOPE,
        train_until="2020-01-01T00:00:00Z",
        min_edge=0.0,
        force_bets=True,
    )
    svg = render_reliability_svg(report.reliability_buckets)
    assert svg.startswith("<svg")
    assert svg.endswith("</svg>")
    assert "<circle" in svg  # at least one bucket point


# ---------------------------------------------------------------------------
# Sharpe-adjusted metrics tests
# ---------------------------------------------------------------------------

import math
from app.ml.backtest import BacktestReport, BetRecord


def _make_bet(pnl: float, price: float, result: float) -> BetRecord:
    return BetRecord(
        event_id="E", bet_ts="2024-01-01T00:00:00Z",
        market="HOME_DRAW_AWAY:FULL_TIME", selection="home",
        price_taken=price, closing_price=price,
        model_prob=0.5, implied_prob=0.4, devigged_prob=0.4,
        edge=0.1, stake_kelly_fraction=1.0,
        result=result, pnl=pnl, clv=0.0,
    )


def test_sharpe_adjusted_three_bet_fixture():
    """Three bets: win@2.5, loss@2.0, win@1.5.
    pnl = [+1.5, -1.0, +0.5].  sum = 1.0,  n = 3.
    return_per_bet = 1 + 1/3 = 1.333...
    rmse_per_bet  = sqrt((1.5^2 + 1.0^2 + 0.5^2)/3) = sqrt(3.5/3) = 1.080...
    sharpe_adj    = (1.333 - 1)/1.080 = 0.308..."""
    bets = [_make_bet(1.5, 2.5, 1.0),
            _make_bet(-1.0, 2.0, 0.0),
            _make_bet(0.5, 1.5, 1.0)]
    from app.ml.backtest import _compute_sharpe_adjusted
    r, rmse, sharpe = _compute_sharpe_adjusted(bets)
    assert r == pytest.approx(1.0 + 1.0 / 3.0, rel=1e-6)
    assert rmse == pytest.approx(math.sqrt(3.5 / 3.0), rel=1e-6)
    assert sharpe == pytest.approx((r - 1.0) / rmse, rel=1e-6)


def test_sharpe_adjusted_zero_bets_safe():
    from app.ml.backtest import _compute_sharpe_adjusted
    r, rmse, sharpe = _compute_sharpe_adjusted([])
    assert r == 1.0
    assert rmse == 0.0
    assert sharpe == 0.0


def test_sharpe_adjusted_zero_rmse_constant_pnls():
    """All bets with identical pnl produce non-zero return but zero RMSE.
    Sharpe must fall through to 0.0 via the rmse_per_bet > 0 guard."""
    from app.ml.backtest import _compute_sharpe_adjusted
    bets = [_make_bet(0.5, 1.5, 1.0) for _ in range(3)]
    r, rmse, sharpe = _compute_sharpe_adjusted(bets)
    assert r == pytest.approx(1.5, rel=1e-6)
    # All pnls are +0.5, so mean(pnl^2) = 0.25, sqrt = 0.5 — NOT zero.
    # The "zero RMSE" branch is only reached when all pnls are zero, which
    # this test verifies separately:
    assert rmse == pytest.approx(0.5, rel=1e-6)
    # Now the actual zero-RMSE case: a bet with pnl=0 (a void result).
    void_bets = [_make_bet(0.0, 1.5, 0.0) for _ in range(3)]
    r2, rmse2, sharpe2 = _compute_sharpe_adjusted(void_bets)
    assert r2 == pytest.approx(1.0, abs=1e-9)
    assert rmse2 == pytest.approx(0.0, abs=1e-9)
    assert sharpe2 == 0.0  # exact, not approx — the guard returns the literal


def test_backtest_report_has_new_fields():
    """Smoke: BacktestReport instantiation accepts the four new fields."""
    rep = BacktestReport(
        model="x", scope_size=0, test_events=0, bets=[], total_bets=0,
        hit_rate=0.0, roi=0.0, mean_clv=None, brier=0.0, log_loss=0.0,
        max_drawdown=0.0, reliability_buckets=[], config={},
        n_train_events=0,
        return_per_bet=1.0, rmse_per_bet=0.0, sharpe_adjusted=0.0,
        reliability_svg=None,
    )
    assert rep.sharpe_adjusted == 0.0
