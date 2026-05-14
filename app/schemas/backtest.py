"""Pydantic schemas for the backtest API.

Mirrors the parameter surface of ``app.ml.backtest.run_backtest`` plus
status fields owned by ``BacktestManager``.
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional, Tuple

from pydantic import BaseModel, Field, field_validator


def _parse_iso(v: str) -> str:
    datetime.fromisoformat(v.replace("Z", "+00:00"))
    return v


class CreateBacktestRunRequest(BaseModel):
    model_config = {"protected_namespaces": ()}

    model: str
    train_until: str
    test_until: Optional[str] = None
    min_edge: float = 0.02
    kelly_fraction: float = 0.25
    force_bets: bool = False
    label: Optional[str] = None
    scope: Optional[List[Tuple[str, str]]] = None

    @field_validator("train_until")
    @classmethod
    def _v_train(cls, v: str) -> str:
        return _parse_iso(v)

    @field_validator("test_until")
    @classmethod
    def _v_test(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else _parse_iso(v)


class BacktestRunSummary(BaseModel):
    model_config = {"protected_namespaces": ()}

    id: str
    label: str
    model: str
    status: str  # queued|running|completed|failed|cancelled
    created_at: str
    train_until: str
    test_until: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None
    test_events: Optional[int] = None
    total_bets: Optional[int] = None
    hit_rate: Optional[float] = None
    roi: Optional[float] = None
    mean_clv: Optional[float] = None
    brier: Optional[float] = None
    log_loss: Optional[float] = None
    max_drawdown: Optional[float] = None


class ReliabilityBucketDTO(BaseModel):
    lower: float
    upper: float
    n: int
    mean_pred: float
    hit_rate: float


class BacktestRunDetail(BacktestRunSummary):
    min_edge: float
    kelly_fraction: float
    force_bets: bool
    scope: List[Tuple[str, str]]
    reliability_buckets: List[ReliabilityBucketDTO] = Field(default_factory=list)


class BacktestBetDTO(BaseModel):
    run_id: str
    event_id: str
    bet_ts: str
    kickoff_ts: str
    market: str
    selection: str
    price_taken: float
    closing_price: float
    model_prob: float
    implied_prob: float
    devigged_prob: float
    edge: float
    stake_kelly_fraction: float
    result: float
    pnl: float
    clv: Optional[float] = None


class BacktestBetListResponse(BaseModel):
    items: List[BacktestBetDTO]
    total: int
    offset: int
    limit: int


class BacktestRunListResponse(BaseModel):
    items: List[BacktestRunSummary]
