from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from app.schemas.odds import (
    BookmakerOdds,
    EventOdds,
    OddsMarket,
    OddsOutcome,
    OddsResponse,
)


def _ensure_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def _parse_datetime(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        # Allow both seconds and milliseconds timestamps.
        timestamp = float(value)
        if timestamp > 10**12:  # milliseconds
            timestamp /= 1000
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except (OverflowError, ValueError):
            return None
    if isinstance(value, str):
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z"):
            try:
                dt = datetime.strptime(value, fmt)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _extract_first(data: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if isinstance(data, dict) and key in data:
            return data[key]
    return None


def _safe_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _extract_event_node(payload: Dict[str, Any]) -> Dict[str, Any]:
    candidates: Iterable[str] = (
        "event",
        "eventOdds",
        "eventOddsV2",
        "event_data",
        "eventOddsResponse",
    )
    working = _safe_dict(payload.get("data")) or _safe_dict(payload)
    for candidate in candidates:
        node = working.get(candidate)
        if isinstance(node, dict):
            return node
    return working


def _normalise_outcomes(raw_outcomes: Iterable[Dict[str, Any]]) -> List[OddsOutcome]:
    outcomes: List[OddsOutcome] = []
    for outcome in raw_outcomes:
        if not isinstance(outcome, dict):
            continue
        outcomes.append(
            OddsOutcome(
                id=outcome.get("id") or outcome.get("outcomeId"),
                label=_extract_first(outcome, "name", "label", "displayName"),
                selection_key=_extract_first(outcome, "key", "selectionKey", "outcomeKey"),
                odds_decimal=_try_parse_float(_extract_first(outcome, "oddsDecimal", "decimalOdds", "value")),
                odds_fractional=_extract_first(outcome, "oddsFractional", "fractionalOdds"),
                probability=_try_parse_float(_extract_first(outcome, "probability", "impliedProbability")),
            )
        )
    return outcomes


def _try_parse_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _normalise_markets(raw_markets: Iterable[Dict[str, Any]]) -> List[OddsMarket]:
    markets: List[OddsMarket] = []
    for market in raw_markets:
        if not isinstance(market, dict):
            continue
        outcomes = _normalise_outcomes(_ensure_list(market.get("outcomes") or market.get("selections") or []))
        markets.append(
            OddsMarket(
                id=market.get("id") or market.get("marketId"),
                name=_extract_first(market, "name", "marketName", "label"),
                key=_extract_first(market, "key", "marketKey"),
                outcomes=outcomes,
            )
        )
    return markets


def _normalise_bookmakers(raw_bookmakers: Iterable[Dict[str, Any]]) -> List[BookmakerOdds]:
    bookmakers: List[BookmakerOdds] = []
    for bookmaker in raw_bookmakers:
        if not isinstance(bookmaker, dict):
            continue
        markets = _normalise_markets(_ensure_list(bookmaker.get("markets") or bookmaker.get("marketGroups") or []))
        bookmakers.append(
            BookmakerOdds(
                id=bookmaker.get("id") or bookmaker.get("bookmakerId"),
                name=_extract_first(bookmaker, "name", "bookmakerName", "label"),
                region=_extract_first(bookmaker, "region", "country", "jurisdiction"),
                markets=markets,
            )
        )
    return bookmakers


def map_odds_payload(event_id: str, payload: Dict[str, Any]) -> OddsResponse:
    payload = payload or {}
    event_node = _extract_event_node(payload)
    event_info = _safe_dict(_extract_first(event_node, "event", "fixture", "details") or event_node)

    bookmakers = _normalise_bookmakers(
        _ensure_list(
            event_node.get("bookmakers")
            or event_node.get("bookmakerOdds")
            or event_node.get("odds")
            or []
        )
    )

    start_time = _parse_datetime(
        _extract_first(event_info, "startTime", "startTimestamp", "kickoff", "startDate")
    )

    event = EventOdds(
        event_id=event_id,
        event_name=_extract_first(event_info, "name", "eventName", "shortName"),
        competition_name=_extract_first(event_info, "competition", "tournament", "league", "competitionName"),
        start_time=start_time,
        bookmakers=bookmakers,
    )

    return OddsResponse(
        event=event,
        retrieved_at=datetime.now(tz=timezone.utc),
        source=_extract_first(payload, "source", "provider", "origin") or "livesport",
    )

