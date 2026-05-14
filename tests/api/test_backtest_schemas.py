import pytest

from app.schemas.backtest import (
    CreateBacktestRunRequest,
    BacktestRunSummary,
)


def test_create_request_applies_defaults():
    req = CreateBacktestRunRequest(
        model="market_implied",
        train_until="2024-08-01T00:00:00Z",
    )
    assert req.min_edge == 0.02
    assert req.kelly_fraction == 0.25
    assert req.force_bets is False
    assert req.test_until is None
    assert req.scope is None
    assert req.label is None


def test_create_request_rejects_bad_train_until():
    with pytest.raises(ValueError):
        CreateBacktestRunRequest(model="market_implied", train_until="not-a-date")


def test_run_summary_round_trips():
    s = BacktestRunSummary(
        id="abc",
        label="t",
        model="market_implied",
        status="completed",
        created_at="2026-05-13T10:00:00Z",
        train_until="2024-08-01T00:00:00Z",
        total_bets=42,
        roi=0.031,
    )
    # Support both pydantic v1 and v2:
    d = s.model_dump() if hasattr(s, "model_dump") else s.dict()
    assert d["id"] == "abc"
    assert d["roi"] == pytest.approx(0.031)
