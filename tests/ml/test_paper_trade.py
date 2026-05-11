"""Tests for app.ml.paper_trade — the paper-trade log + settler.

Hermetic: uses the existing fixture DB to seed labels/closing-odds,
records synthetic picks, then settles and asserts the pnl/clv math.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from app.ml import db as ml_db
from app.ml.closing_odds import backfill_closing_odds
from app.ml.labels import backfill_labels
from app.ml.paper_trade import (
    PickInput,
    fetch_paper_bets,
    fetch_summary,
    record_picks,
    settle_pending_bets,
)


TEST_SCOPE = (("TESTLAND", "Test League"),)


@pytest.fixture
def backfilled(fixture_db):
    backfill_labels(sport="football", scope=TEST_SCOPE, rebuild=True)
    backfill_closing_odds(sport="football", scope=TEST_SCOPE, rebuild=True)
    return fixture_db


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def test_record_then_fetch_pending(backfilled):
    picks = [
        PickInput(
            event_id="evt001", model="dixon_coles", market="OVER_UNDER_2.5_FT",
            selection="over", bet_ts=_now_iso(),
            price_at_recommendation=2.0, model_prob=0.6,
            devigged_prob=0.5, edge=0.10, kelly_full=0.20,
        ),
    ]
    inserted = record_picks(picks)
    assert inserted == 1
    rows = fetch_paper_bets(status="pending")
    assert len(rows) == 1
    assert rows[0]["selection"] == "over"


def test_duplicate_record_is_silently_skipped(backfilled):
    p = PickInput(
        event_id="evt001", model="logistic", market="1X2_FT",
        selection="home", bet_ts=_now_iso(),
        price_at_recommendation=1.8, model_prob=0.55,
        devigged_prob=0.5, edge=0.05, kelly_full=0.10,
    )
    assert record_picks([p]) == 1
    # Same pick again — should be skipped.
    assert record_picks([p]) == 0


def test_settle_marks_settled_with_correct_pnl(backfilled):
    # evt001 was a 2-1 home win. Recording a "home" 1X2 bet at price 1.8
    # should result in a winning settled row with pnl = stake*(1.8-1) =
    # stake * 0.8.
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    summary = settle_pending_bets(kelly_stake_unit=1.0)
    # Note: evt001's closing_odds were built from the fixture's 2.0/3.4/4.0
    # 1X2 prices. closing_odds for the home selection should exist; the
    # settler should find it and mark this bet settled.
    assert summary.settled >= 1
    settled_rows = fetch_paper_bets(status="settled")
    home_row = next(r for r in settled_rows if r["selection"] == "home")
    assert home_row["result"] == 1.0
    # Stake = kelly_full * unit = 0.10, pnl = 0.10 * (1.8-1) = 0.08
    assert abs(home_row["pnl"] - 0.08) < 1e-9


def test_settle_records_clv(backfilled):
    # Same setup as above. CLV = ln(price_at_rec / closing_price). The
    # fixture's closing-line average home price is 2.0 across 4 books;
    # we recorded at 1.8 so CLV = ln(1.8/2.0) ≈ -0.105 (we took a
    # shorter price than the close).
    import math

    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    settle_pending_bets()
    rows = fetch_paper_bets(status="settled")
    home_row = next(r for r in rows if r["selection"] == "home")
    assert home_row["clv"] is not None
    expected_clv = math.log(1.8 / home_row["closing_price"])
    assert abs(home_row["clv"] - expected_clv) < 1e-9


def test_settle_handles_over_under(backfilled):
    # evt002 was a 0-0 draw → total goals 0 → "under" wins.
    picks = [
        PickInput(
            event_id="evt002", model="dixon_coles", market="OVER_UNDER_2.5_FT",
            selection="under", bet_ts=_now_iso(),
            price_at_recommendation=2.0, model_prob=0.7,
            devigged_prob=0.5, edge=0.20, kelly_full=0.30,
        ),
        PickInput(
            event_id="evt002", model="dixon_coles", market="OVER_UNDER_2.5_FT",
            selection="over", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.3,
            devigged_prob=0.5, edge=-0.20, kelly_full=0.0,
        ),
    ]
    record_picks(picks)
    # closing_odds for OVER_UNDER:FULL_TIME may not exist in the fixture
    # — the fixture only seeds 1X2 FT prices. The settler should mark
    # these as "no closing price" and leave them pending.
    summary = settle_pending_bets()
    assert summary.skipped_no_closing_price >= 1


def test_settle_handles_btts(backfilled):
    # evt001 (2-1) → btts yes wins. fixture has no BTTS prices so the
    # settler should skip for no closing.
    picks = [
        PickInput(
            event_id="evt001", model="dixon_coles", market="BTTS_FT",
            selection="yes", bet_ts=_now_iso(),
            price_at_recommendation=1.7, model_prob=0.6,
            devigged_prob=0.5, edge=0.10, kelly_full=0.15,
        ),
    ]
    record_picks(picks)
    summary = settle_pending_bets()
    assert summary.skipped_no_closing_price >= 1


def test_settle_is_idempotent(backfilled):
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    first = settle_pending_bets()
    second = settle_pending_bets()
    # First run settles 1; second has nothing pending.
    assert first.settled >= 1
    assert second.settled == 0


def test_summary_aggregates_correctly(backfilled):
    picks = [
        PickInput(
            event_id="evt001", model="logistic", market="1X2_FT",
            selection="home", bet_ts=_now_iso(),
            price_at_recommendation=1.8, model_prob=0.55,
            devigged_prob=0.5, edge=0.05, kelly_full=0.10,
        ),
    ]
    record_picks(picks)
    settle_pending_bets()
    summary = fetch_summary()
    assert summary["totals"]["n"] == 1
    assert summary["totals"]["settled"] == 1
    assert len(summary["per_model"]) == 1
    assert summary["per_model"][0]["model"] == "logistic"
