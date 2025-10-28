from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

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


def _extract_text(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "label", "name", "value", "displayName"):
            if key in value:
                extracted = _extract_text(value[key])
                if extracted:
                    return extracted
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            extracted = _extract_text(item)
            if extracted:
                return extracted
        return None
    return str(value)


def _stringify(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    return str(value)


def _walk_nodes(root: Any) -> Iterable[Dict[str, Any]]:
    """Yield dictionaries found in the payload via breadth-first search."""

    queue: deque[Any] = deque([root])
    while queue:
        current = queue.popleft()
        if isinstance(current, dict):
            yield current
            queue.extend(current.values())
        elif isinstance(current, list):
            queue.extend(current)


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

    for node in _walk_nodes(working):
        if any(
            key in node
            for key in (
                "bookmakers",
                "bookmakerOdds",
                "odds",
                "event",
                "fixture",
                "details",
                "eventDetails",
            )
        ):
            return node

    return working


def _normalise_outcomes(raw_outcomes: Iterable[Dict[str, Any]]) -> List[OddsOutcome]:
    outcomes: List[OddsOutcome] = []
    for outcome in raw_outcomes:
        if not isinstance(outcome, dict):
            continue
        outcomes.append(
            OddsOutcome(
                id=_stringify(outcome.get("id") or outcome.get("outcomeId")),
                label=_extract_text(_extract_first(outcome, "name", "label", "displayName", "text")),
                selection_key=_stringify(_extract_first(outcome, "key", "selectionKey", "outcomeKey")),
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
                id=_stringify(market.get("id") or market.get("marketId")),
                name=_extract_text(_extract_first(market, "name", "marketName", "label", "text")),
                key=_stringify(_extract_first(market, "key", "marketKey")),
                outcomes=outcomes,
            )
        )
    return markets


def _normalise_bookmakers(raw_bookmakers: Iterable[Dict[str, Any]]) -> List[BookmakerOdds]:
    bookmaker_map: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for bookmaker in raw_bookmakers:
        if not isinstance(bookmaker, dict):
            continue
        bookmaker_id = _stringify(bookmaker.get("id") or bookmaker.get("bookmakerId") or bookmaker.get("bookmakerID"))
        name = _extract_text(_extract_first(bookmaker, "name", "bookmakerName", "label"))
        region = _extract_text(_extract_first(bookmaker, "region", "country", "jurisdiction"))

        raw_markets = bookmaker.get("markets") or bookmaker.get("marketGroups") or bookmaker.get("groups")
        raw_markets = _ensure_list(raw_markets)
        expanded_markets: List[Dict[str, Any]] = []
        for candidate in raw_markets:
            if isinstance(candidate, dict) and "markets" in candidate:
                expanded_markets.extend(_ensure_list(candidate.get("markets")))
            else:
                expanded_markets.append(candidate)
        markets = _normalise_markets(expanded_markets)

        key = bookmaker_id or name or str(id(bookmaker))
        if key not in bookmaker_map:
            bookmaker_map[key] = {"id": bookmaker_id, "name": name, "region": region, "markets": []}
            order.append(key)

        entry = bookmaker_map[key]
        entry["name"] = entry["name"] or name
        entry["region"] = entry["region"] or region
        if markets:
            entry["markets"].extend(markets)

    result: List[BookmakerOdds] = []
    for key in order:
        entry = bookmaker_map[key]
        result.append(
            BookmakerOdds(
                id=entry["id"],
                name=entry["name"],
                region=entry["region"],
                markets=entry["markets"],
            )
        )
    return result


def _format_market_name(betting_type: Optional[str], betting_scope: Optional[str]) -> Tuple[str, str]:
    """Return a stable key and human friendly name for a market."""

    betting_type = (betting_type or "UNKNOWN").upper()
    betting_scope = (betting_scope or "UNKNOWN").upper()
    market_key = f"{betting_type}:{betting_scope}"

    type_mapping = {
        "HOME_DRAW_AWAY": "1X2",
        "DOUBLE_CHANCE": "Double Chance",
        "DRAW_NO_BET": "Draw No Bet",
        "OVER_UNDER": "Over/Under",
        "ASIAN_HANDICAP": "Asian Handicap",
        "EUROPEAN_HANDICAP": "European Handicap",
        "HALF_FULL_TIME": "Half-Time/Full-Time",
        "CORRECT_SCORE": "Correct Score",
        "BOTH_TEAMS_TO_SCORE": "Both Teams To Score",
        "ODD_OR_EVEN": "Odd or Even",
    }
    scope_mapping = {
        "FULL_TIME": "Full Time",
        "FIRST_HALF": "First Half",
        "SECOND_HALF": "Second Half",
        "UNKNOWN": "Market",
    }

    type_label = type_mapping.get(betting_type, betting_type.replace("_", " ").title())
    scope_label = scope_mapping.get(betting_scope, betting_scope.replace("_", " ").title())

    if scope_label == "Market":
        market_name = type_label
    else:
        market_name = f"{type_label} - {scope_label}"

    return market_key, market_name


def _format_outcome_label(item: Dict[str, Any]) -> str:
    selection = _extract_text(item.get("selection"))
    winner = _extract_text(item.get("winner"))
    score = _extract_text(item.get("score"))
    position = _extract_text(item.get("position"))

    parts: List[str] = []
    for candidate in (selection, winner, score, position):
        if candidate:
            parts.append(candidate)
            break

    handicap = item.get("handicap")
    if isinstance(handicap, dict):
        handicap_value = _extract_text(handicap.get("value"))
        if handicap_value:
            parts.append(f"({handicap_value})")

    if not parts:
        event_participant = _extract_text(item.get("eventParticipantId"))
        if event_participant:
            parts.append(event_participant)

    return " ".join(parts).strip() or "Selection"


def _map_graphql_bookmakers(node: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    details: Dict[str, Dict[str, Any]] = {}
    settings = _safe_dict(node.get("settings"))
    for bookmaker_entry in _ensure_list(settings.get("bookmakers") or []):
        if not isinstance(bookmaker_entry, dict):
            continue
        bookmaker_info = _safe_dict(bookmaker_entry.get("bookmaker"))
        bookmaker_id = _stringify(bookmaker_info.get("id") or bookmaker_entry.get("bookmakerId"))
        if not bookmaker_id:
            continue
        details[bookmaker_id] = {
            "id": bookmaker_id,
            "name": _extract_text(bookmaker_info.get("name") or bookmaker_entry.get("name")),
            "region": None,
        }
    return details


def _map_graphql_markets(node: Dict[str, Any]) -> Dict[str, List[OddsMarket]]:
    aggregated: Dict[str, Dict[str, OddsMarket]] = {}
    for market_entry in _ensure_list(node.get("odds") or []):
        if not isinstance(market_entry, dict):
            continue

        bookmaker_id = _stringify(market_entry.get("bookmakerId"))
        if not bookmaker_id:
            continue

        market_key, market_name = _format_market_name(
            market_entry.get("bettingType"), market_entry.get("bettingScope")
        )

        bookmaker_markets = aggregated.setdefault(bookmaker_id, {})
        if market_key not in bookmaker_markets:
            bookmaker_markets[market_key] = OddsMarket(
                id=market_key,
                name=market_name,
                key=market_key,
                outcomes=[],
            )

        outcomes = bookmaker_markets[market_key].outcomes
        for outcome_entry in _ensure_list(market_entry.get("odds") or []):
            if not isinstance(outcome_entry, dict):
                continue

            outcome_id = _stringify(
                outcome_entry.get("eventParticipantId")
                or outcome_entry.get("selection")
                or outcome_entry.get("score")
                or f"{market_key}:{len(outcomes)}"
            )

            outcome_label = _format_outcome_label(outcome_entry)

            outcomes.append(
                OddsOutcome(
                    id=outcome_id,
                    label=outcome_label,
                    selection_key=outcome_id,
                    odds_decimal=_try_parse_float(outcome_entry.get("value")),
                    odds_fractional=None,
                    probability=_try_parse_float(outcome_entry.get("probability")),
                )
            )

    return {bookmaker_id: list(market_map.values()) for bookmaker_id, market_map in aggregated.items()}


def _map_graphql_payload(event_id: str, node: Dict[str, Any]) -> OddsResponse:
    bookmaker_details = _map_graphql_bookmakers(node)
    bookmaker_markets = _map_graphql_markets(node)

    bookmakers: List[BookmakerOdds] = []
    for bookmaker_id, details in bookmaker_details.items():
        markets = bookmaker_markets.get(bookmaker_id, [])
        bookmakers.append(
            BookmakerOdds(
                id=details.get("id"),
                name=details.get("name"),
                region=details.get("region"),
                markets=markets,
            )
        )

    for bookmaker_id, markets in bookmaker_markets.items():
        if bookmaker_id not in bookmaker_details:
            bookmakers.append(
                BookmakerOdds(
                    id=bookmaker_id,
                    name=None,
                    region=None,
                    markets=markets,
                )
            )

    event_info_candidates = [
        _safe_dict(node.get("event")),
        _safe_dict(node.get("eventDetails")),
        _safe_dict(node.get("fixture")),
    ]
    event_info: Dict[str, Any] = {}
    for candidate in event_info_candidates:
        if candidate:
            event_info = candidate
            break

    start_time = _parse_datetime(
        _extract_first(event_info, "startTime", "startTimestamp", "kickoff", "startDate")
    )

    event = EventOdds(
        event_id=event_id,
        event_name=_extract_text(
            _extract_first(event_info, "name", "eventName", "shortName", "eventLabel", "eventTitle")
        ),
        competition_name=_extract_text(
            _extract_first(event_info, "competition", "tournament", "league", "competitionName")
        ),
        start_time=start_time,
        bookmakers=bookmakers,
    )

    return OddsResponse(
        event=event,
        retrieved_at=datetime.now(tz=timezone.utc),
        source=_extract_text(node.get("source") or "livesport"),
    )


def map_odds_payload(event_id: str, payload: Dict[str, Any]) -> OddsResponse:
    payload = payload or {}

    graphql_node = _safe_dict(payload.get("data")).get("findOddsByEventId")
    if isinstance(graphql_node, dict):
        return _map_graphql_payload(event_id=event_id, node=graphql_node)

    event_node = _extract_event_node(payload)
    event_info = _safe_dict(_extract_first(event_node, "event", "fixture", "details") or event_node)
    if not event_info:
        for node in _walk_nodes(event_node):
            if any(
                key in node
                for key in (
                    "name",
                    "eventName",
                    "shortName",
                    "competition",
                    "tournament",
                    "league",
                    "competitionName",
                    "startTime",
                    "startTimestamp",
                    "kickoff",
                    "startDate",
                )
            ):
                event_info = node
                break

    bookmakers = _normalise_bookmakers(
        _ensure_list(
            event_node.get("bookmakers")
            or event_node.get("bookmakerOdds")
            or event_node.get("odds")
            or []
        )
    )
    if not bookmakers:
        for node in _walk_nodes(event_node):
            candidates = node.get("bookmakers") or node.get("bookmakerOdds") or node.get("odds")
            if candidates:
                bookmakers = _normalise_bookmakers(_ensure_list(candidates))
                if bookmakers:
                    break

    start_time = _parse_datetime(
        _extract_first(event_info, "startTime", "startTimestamp", "kickoff", "startDate")
    )

    event = EventOdds(
        event_id=event_id,
        event_name=_extract_text(
            _extract_first(event_info, "name", "eventName", "shortName", "eventLabel", "eventTitle")
        ),
        competition_name=_extract_text(
            _extract_first(event_info, "competition", "tournament", "league", "competitionName")
        ),
        start_time=start_time,
        bookmakers=bookmakers,
    )

    return OddsResponse(
        event=event,
        retrieved_at=datetime.now(tz=timezone.utc),
        source=_extract_first(payload, "source", "provider", "origin") or "livesport",
    )
