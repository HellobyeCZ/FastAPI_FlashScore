from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.schemas.match_stats import (
    MatchStat,
    MatchStatsCategory,
    MatchStatsEvent,
    MatchStatsPeriod,
    MatchStatsResponse,
)


def _parse_record(record: str) -> Dict[str, str]:
    parsed: Dict[str, str] = {}
    for token in record.split("¬"):
        if "÷" not in token:
            continue
        key, value = token.split("÷", 1)
        parsed[key] = value
    return parsed


def _find_or_add_period(periods: List[MatchStatsPeriod], period_name: str) -> MatchStatsPeriod:
    for period in periods:
        if period.name == period_name:
            return period

    period = MatchStatsPeriod(name=period_name, categories=[])
    periods.append(period)
    return period


def _find_or_add_category(period: MatchStatsPeriod, category_name: str) -> MatchStatsCategory:
    for category in period.categories:
        if category.name == category_name:
            return category

    category = MatchStatsCategory(name=category_name, stats=[])
    period.categories.append(category)
    return category


def parse_match_stats_payload(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    periods: List[MatchStatsPeriod] = []
    current_period: Optional[MatchStatsPeriod] = None
    current_category: Optional[MatchStatsCategory] = None

    for raw_record in payload.split("¬~"):
        if not raw_record:
            continue
        record = _parse_record(raw_record)
        if not record:
            continue

        period_name = record.get("SE")
        if period_name:
            current_period = _find_or_add_period(periods, period_name)
            current_category = None
            continue

        category_name = record.get("SF")
        if category_name:
            if current_period is None:
                current_period = _find_or_add_period(periods, "Match")
            current_category = _find_or_add_category(current_period, category_name)
            continue

        stat_code = record.get("SD")
        if stat_code:
            if current_period is None:
                current_period = _find_or_add_period(periods, "Match")
            if current_category is None:
                current_category = _find_or_add_category(current_period, "General")

            current_category.stats.append(
                MatchStat(
                    code=stat_code,
                    label=record.get("SG"),
                    home=record.get("SH"),
                    away=record.get("SI"),
                )
            )

    return periods


def map_match_stats_payload(event_id: str, payload: str, source: str = "flashscore.ninja") -> MatchStatsResponse:
    periods = parse_match_stats_payload(payload)
    return MatchStatsResponse(
        event=MatchStatsEvent(event_id=event_id, periods=periods),
        retrieved_at=datetime.now(timezone.utc),
        source=source,
    )
