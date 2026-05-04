from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

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


def _to_float(value: str) -> Optional[float]:
    value = value.strip()
    if not value or value == "-":
        return None
    if ":" in value:
        parts = value.split(":")
        if len(parts) == 2 and all(part.isdigit() for part in parts):
            minutes = int(parts[0])
            seconds = int(parts[1])
            return minutes + (seconds / 60)
        return None
    cleaned = value.replace("%", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _merge_periods(target: List[MatchStatsPeriod], incoming: List[MatchStatsPeriod]) -> None:
    for incoming_period in incoming:
        target_period = next((period for period in target if period.name == incoming_period.name), None)
        if target_period is None:
            target.append(incoming_period)
            continue

        for incoming_category in incoming_period.categories:
            target_category = next(
                (category for category in target_period.categories if category.name == incoming_category.name),
                None,
            )
            if target_category is None:
                target_period.categories.append(incoming_category)
                continue

            existing_keys = {
                (stat.code or "", stat.label or "", stat.home or "", stat.away or "")
                for stat in target_category.stats
            }
            for stat in incoming_category.stats:
                key = (stat.code or "", stat.label or "", stat.home or "", stat.away or "")
                if key not in existing_keys:
                    target_category.stats.append(stat)
                    existing_keys.add(key)


def _remove_empty(periods: List[MatchStatsPeriod]) -> List[MatchStatsPeriod]:
    cleaned: List[MatchStatsPeriod] = []
    for period in periods:
        categories = [category for category in period.categories if category.stats]
        if not categories:
            continue
        cleaned.append(MatchStatsPeriod(name=period.name, categories=categories))
    return cleaned


def _parse_unix_timestamp(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    try:
        seconds = int(float(value))
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _normalize_status(status_code: Optional[str]) -> Optional[str]:
    if not status_code:
        return None

    normalized = {
        "0": "finished",
        "1": "scheduled",
        "2": "live",
        "3": "interrupted",
        "4": "postponed",
        "5": "abandoned",
        "6": "cancelled",
    }
    return normalized.get(status_code, status_code)


def _normalize_outcome(outcome_code: Optional[str]) -> Optional[str]:
    if not outcome_code:
        return None

    normalized = {
        "H": "home_win",
        "A": "away_win",
        "D": "draw",
    }
    return normalized.get(outcome_code, outcome_code)


def _extract_match_metadata(
    feed_payloads: Dict[str, str],
    *,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
    sport: Optional[str] = None,
    country: Optional[str] = None,
    competition: Optional[str] = None,
    competition_stage: Optional[str] = None,
    competition_path: Optional[str] = None,
) -> Dict[str, Optional[object]]:
    dc_payload = feed_payloads.get("dc")
    if not dc_payload:
        return {
            "home_team": home_team,
            "away_team": away_team,
            "sport": sport,
            "country": country,
            "competition": competition,
            "competition_stage": competition_stage,
            "competition_path": competition_path,
            "start_time_utc": None,
            "status": None,
            "status_detail": None,
            "outcome": None,
        }

    first_record = dc_payload.split("¬~", 1)[0]
    record = _parse_record(first_record)
    status_detail = (record.get("DM") or record.get("DT") or "").strip() or None

    start_time_utc = _parse_unix_timestamp(record.get("DC"))
    status = _normalize_status(record.get("DS"))
    outcome = _normalize_outcome(record.get("DJ"))

    # Upstream sometimes returns status='finished' for matches whose kickoff
    # is still in the future (likely a default in their feed). Override based
    # on time so the UI/Competition Browser don't mislabel scheduled fixtures.
    if start_time_utc is not None:
        now = datetime.now(timezone.utc)
        if start_time_utc > now and status == "finished":
            status = "scheduled"
            outcome = None

    return {
        "home_team": home_team,
        "away_team": away_team,
        "sport": sport,
        "country": country,
        "competition": competition,
        "competition_stage": competition_stage,
        "competition_path": competition_path,
        "start_time_utc": start_time_utc,
        "status": status,
        "status_detail": status_detail,
        "outcome": outcome,
    }


def _parse_df_st(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    periods: List[MatchStatsPeriod] = []
    current_period_name = "Match"
    current_category_name: Optional[str] = None
    period_map: Dict[str, MatchStatsPeriod] = {}

    def get_period(name: str) -> MatchStatsPeriod:
        if name in period_map:
            return period_map[name]
        period = MatchStatsPeriod(name=name, categories=[])
        period_map[name] = period
        periods.append(period)
        return period

    def get_category(period: MatchStatsPeriod, name: str) -> MatchStatsCategory:
        for category in period.categories:
            if category.name == name:
                return category
        category = MatchStatsCategory(name=name, stats=[])
        period.categories.append(category)
        return category

    for raw_record in payload.split("¬~"):
        if not raw_record:
            continue
        record = _parse_record(raw_record)
        if not record:
            continue

        period_name = record.get("SE")
        if period_name:
            current_period_name = period_name
            current_category_name = None
            continue

        category_name = record.get("SF")
        if category_name:
            current_category_name = category_name
            continue

        stat_code = record.get("SD")
        label = record.get("SG")
        home = record.get("SH")
        away = record.get("SI")
        # Some sports (e.g. hockey) do not include SD and only send SG/SH/SI.
        if not (label and home and away):
            continue

        period = get_period(current_period_name)
        category_name = current_category_name or ("General" if stat_code else "Match stats")
        category = get_category(period, category_name)
        category.stats.append(
            MatchStat(
                code=stat_code,
                label=label,
                home=home,
                away=away,
            )
        )

    return _remove_empty(periods)


def _parse_dc(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    first_record = payload.split("¬~", 1)[0]
    record = _parse_record(first_record)
    full_home = record.get("DE")
    full_away = record.get("DF")
    live_home = record.get("DG")
    live_away = record.get("DH")

    stats: List[MatchStat] = []
    if full_home and full_away:
        stats.append(MatchStat(label="Final score", home=full_home, away=full_away))
    if live_home and live_away and (live_home != full_home or live_away != full_away):
        stats.append(MatchStat(label="Current score", home=live_home, away=live_away))

    if not stats:
        return []

    return [
        MatchStatsPeriod(
            name="Match",
            categories=[MatchStatsCategory(name="Score", stats=stats)],
        )
    ]


def _parse_df_sur(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    score_tokens: List[str] = []
    for raw_record in payload.split("¬~"):
        if not raw_record:
            continue
        record = _parse_record(raw_record)
        for key, value in record.items():
            if re.match(r"^B[A-Z]$", key) and value:
                score_tokens.append(value)

    if len(score_tokens) < 2:
        return []

    stats: List[MatchStat] = []
    pair_index = 1
    for index in range(0, len(score_tokens) - 1, 2):
        stats.append(
            MatchStat(
                label=f"Period {pair_index}",
                home=score_tokens[index],
                away=score_tokens[index + 1],
            )
        )
        pair_index += 1

    if not stats:
        return []

    return [
        MatchStatsPeriod(
            name="Match",
            categories=[MatchStatsCategory(name="Period scoring", stats=stats)],
        )
    ]


def _parse_df_sui(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    periods: List[MatchStatsPeriod] = []
    for raw_record in payload.split("¬~"):
        if not raw_record:
            continue
        record = _parse_record(raw_record)
        period_name = record.get("AC")
        home = record.get("IG")
        away = record.get("IH")
        if not (period_name and home and away):
            continue
        periods.append(
            MatchStatsPeriod(
                name=period_name,
                categories=[
                    MatchStatsCategory(
                        name="Score",
                        stats=[MatchStat(label="Period score", home=home, away=away)],
                    )
                ],
            )
        )

    return _remove_empty(periods)


def _parse_df_psp(payload: str) -> List[MatchStatsPeriod]:
    if not payload:
        return []

    metrics: List[Tuple[str, str]] = []
    team_order: List[str] = []
    leaders: Dict[int, Dict[str, Tuple[float, str, str]]] = {}

    for raw_record in payload.split("¬~"):
        if not raw_record:
            continue
        record = _parse_record(raw_record)

        metric_code = record.get("PF")
        if metric_code:
            if metric_code == "Player":
                continue
            metrics.append((metric_code, record.get("PG") or metric_code))
            continue

        if "PJ" in record and "PC" in record:
            team = record.get("PN") or "TEAM"
            if team not in team_order:
                team_order.append(team)
            values = record["PC"].split("|")
            player_name = record.get("PJ") or "Player"
            for metric_index, (_, _) in enumerate(metrics):
                if metric_index >= len(values):
                    break
                raw_value = values[metric_index]
                numeric_value = _to_float(raw_value)
                if numeric_value is None:
                    continue
                metric_leaders = leaders.setdefault(metric_index, {})
                previous = metric_leaders.get(team)
                if previous is None or numeric_value > previous[0]:
                    metric_leaders[team] = (numeric_value, player_name, raw_value)

    if len(team_order) < 2:
        return []

    home_team, away_team = team_order[0], team_order[1]
    stats: List[MatchStat] = []

    for metric_index, (_, metric_label) in enumerate(metrics):
        metric_leaders = leaders.get(metric_index)
        if not metric_leaders:
            continue
        home_leader = metric_leaders.get(home_team)
        away_leader = metric_leaders.get(away_team)
        if not home_leader or not away_leader:
            continue
        stats.append(
            MatchStat(
                label=f"Top {metric_label}",
                home=f"{home_leader[2]} ({home_leader[1]})",
                away=f"{away_leader[2]} ({away_leader[1]})",
            )
        )

    if not stats:
        return []

    return [
        MatchStatsPeriod(
            name="Match",
            categories=[MatchStatsCategory(name=f"Top players ({home_team} vs {away_team})", stats=stats)],
        )
    ]


def parse_match_stats_payloads(feed_payloads: Dict[str, str]) -> List[MatchStatsPeriod]:
    periods: List[MatchStatsPeriod] = []
    parser_steps = (
        ("dc", _parse_dc),
        ("df_st", _parse_df_st),
        ("df_sur", _parse_df_sur),
        ("df_sui", _parse_df_sui),
        ("df_psp", _parse_df_psp),
    )

    for feed_name, parser in parser_steps:
        payload = feed_payloads.get(feed_name)
        if not payload:
            continue
        parsed = parser(payload)
        if parsed:
            _merge_periods(periods, parsed)

    return _remove_empty(periods)


def map_match_stats_payload(
    event_id: str,
    payload: Optional[str] = None,
    feed_payloads: Optional[Dict[str, str]] = None,
    home_team: Optional[str] = None,
    away_team: Optional[str] = None,
    sport: Optional[str] = None,
    country: Optional[str] = None,
    competition: Optional[str] = None,
    competition_stage: Optional[str] = None,
    competition_path: Optional[str] = None,
    source: str = "flashscore.ninja",
) -> MatchStatsResponse:
    if feed_payloads is None:
        feed_payloads = {"df_st": payload or ""}

    periods = parse_match_stats_payloads(feed_payloads)
    metadata = _extract_match_metadata(
        feed_payloads,
        home_team=home_team,
        away_team=away_team,
        sport=sport,
        country=country,
        competition=competition,
        competition_stage=competition_stage,
        competition_path=competition_path,
    )
    return MatchStatsResponse(
        event=MatchStatsEvent(
            event_id=event_id,
            home_team=metadata["home_team"],
            away_team=metadata["away_team"],
            sport=metadata["sport"],
            country=metadata["country"],
            competition=metadata["competition"],
            competition_stage=metadata["competition_stage"],
            competition_path=metadata["competition_path"],
            start_time_utc=metadata["start_time_utc"],
            status=metadata["status"],
            status_detail=metadata["status_detail"],
            outcome=metadata["outcome"],
            periods=periods,
        ),
        retrieved_at=datetime.now(timezone.utc),
        source=source,
    )
