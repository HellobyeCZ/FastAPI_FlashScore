"""Aggregation queries over paper_bets for /picks/stats.

Separate from paper_trade.py to keep that module focused on
record/settle and avoid growing it into a query toolbox.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple


# Allowed group_by tokens. Used both for validation and for the SQL
# SELECT/GROUP BY clause builder.
ALLOWED_GROUP_BY = (
    "model",
    "market",
    "sport",
    "country",
    "competition",
    "selection",
    "edge_bucket",
    "price_bucket",
    "day",
    "week",
    "month",
)

ALLOWED_STATUS = ("settled", "pending", "all")


@dataclass(frozen=True)
class StatsFilter:
    status: str = "settled"
    date_from: Optional[str] = None   # ISO8601
    date_to: Optional[str] = None
    model: Tuple[str, ...] = ()
    market: Tuple[str, ...] = ()
    sport: Tuple[str, ...] = ()
    country: Tuple[str, ...] = ()
    competition: Tuple[str, ...] = ()
    selection: Tuple[str, ...] = ()
    edge_min: Optional[float] = None
    edge_max: Optional[float] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None


@dataclass(frozen=True)
class StatsRequest:
    group_by: Tuple[str, ...] = ()
    filters: StatsFilter = field(default_factory=StatsFilter)
    min_n_per_group: int = 1

    def __post_init__(self) -> None:
        for token in self.group_by:
            if token not in ALLOWED_GROUP_BY:
                raise ValueError(
                    f"unknown group_by {token!r}. allowed: {ALLOWED_GROUP_BY}"
                )
        if self.filters.status not in ALLOWED_STATUS:
            raise ValueError(
                f"unknown status {self.filters.status!r}. allowed: {ALLOWED_STATUS}"
            )


def aggregate(request: StatsRequest) -> List[Dict[str, Any]]:
    """Stub — implemented in later tasks."""
    raise NotImplementedError


def calibration_buckets(
    *,
    model: str,
    filters: StatsFilter = StatsFilter(),
    n_buckets: int = 10,
) -> List[Dict[str, Any]]:
    """Stub — implemented in Task A4."""
    raise NotImplementedError
