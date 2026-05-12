"""Spot-check that the archive's recorded 1X2 FT odds line up with an
independent closing-line reference (football-data.co.uk historical CSVs).

This guards the load-bearing assumption — established outside the code in
the Phase 0 conversation — that *the single odds row per terminal event in
the archive is the latest pre-kickoff (closing) snapshot*. The Phase 1
label/feature/backtest pipeline treats archive odds as closing prices; if
this script ever stops passing on a refreshed sample we need to revisit.

Pass criteria:
  - Test A: each archive selection price is within ``--price-tolerance``
    (default 7%) of B365 *or* Pinnacle closing for that match. Reports the
    selection pass rate.
  - Test B: archive's devigged implied probability (proportional method,
    averaged across CZ books) differs from football-data's ``AvgC*``
    devigged probability by at most ``--devig-tolerance`` (default 0.03)
    on every selection.

Outcome ordering in the archive is **[home, away, draw]** (the draw being
the upstream entry with ``eventParticipantId=None``). This is a load-bearing
quirk that any 1X2 consumer must handle.

Usage:
    python -m scripts.spot_check_closing --league EPL --season 2324 --sample 5
    python -m scripts.spot_check_closing --league BUN --season 2324

Currently supported leagues (limited to what football-data.co.uk publishes):

    EPL  - England Premier League   (fd code E0, archive: football/england/premier-league)
    BUN  - Germany Bundesliga       (fd code D1, archive: football/germany/bundesliga)
    LIGA - Spain LaLiga             (fd code SP1, archive: football/spain/laliga)
    L1   - France Ligue 1           (fd code F1, archive: football/france/ligue-1)
    CH   - England Championship     (fd code E1, archive: football/england/championship)

Czech leagues are not covered by football-data.co.uk; cross-checking
Chance Liga requires a different reference source (OddsPortal scrape).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import random
import sqlite3
import sys
import urllib.request
from dataclasses import dataclass
from statistics import mean
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class LeagueRef:
    short: str
    fd_code: str
    archive_country: str
    archive_competition: str
    # Mapping from archive's team name to football-data.co.uk's name when they
    # differ (FD uses short forms like "Man United", FlashScore uses
    # "Manchester Utd"). Bidirectional via canonicalization.
    name_aliases: Dict[str, str]


_LEAGUES: Dict[str, LeagueRef] = {
    "EPL": LeagueRef(
        short="EPL",
        fd_code="E0",
        archive_country="ENGLAND",
        archive_competition="Premier League",
        name_aliases={
            "Manchester Utd": "Man United",
            "Manchester City": "Man City",
            "Newcastle": "Newcastle",
            "Nottingham": "Nott'm Forest",
            "Sheffield Utd": "Sheffield United",
            "Wolves": "Wolves",
        },
    ),
    "BUN": LeagueRef(
        short="BUN",
        fd_code="D1",
        archive_country="GERMANY",
        archive_competition="Bundesliga",
        name_aliases={
            "Bayern Munich": "Bayern Munich",
            "B. Monchengladbach": "M'gladbach",
            "Bayer Leverkusen": "Leverkusen",
            "Hoffenheim": "Hoffenheim",
            "Eintracht Frankfurt": "Ein Frankfurt",
            "Heidenheim": "Heidenheim",
        },
    ),
    "LIGA": LeagueRef(
        short="LIGA",
        fd_code="SP1",
        archive_country="SPAIN",
        archive_competition="LaLiga",
        name_aliases={
            "Atletico Madrid": "Ath Madrid",
            "Athletic Bilbao": "Ath Bilbao",
            "Real Sociedad": "Sociedad",
            "Celta Vigo": "Celta",
            "Rayo Vallecano": "Vallecano",
        },
    ),
    "L1": LeagueRef(
        short="L1",
        fd_code="F1",
        archive_country="FRANCE",
        archive_competition="Ligue 1",
        name_aliases={
            "Paris Saint Germain": "Paris SG",
            "Saint Etienne": "St Etienne",
        },
    ),
    "CH": LeagueRef(
        short="CH",
        fd_code="E1",
        archive_country="ENGLAND",
        archive_competition="Championship",
        name_aliases={},
    ),
}


def _db_path() -> str:
    return os.environ.get(
        "APP_STORAGE_DB_PATH",
        "data/flashscore_snapshots.sqlite3",
    )


def _fd_url(fd_code: str, season: str) -> str:
    return f"https://www.football-data.co.uk/mmz4281/{season}/{fd_code}.csv"


def _fetch_fd_csv(fd_code: str, season: str) -> List[Dict[str, str]]:
    url = _fd_url(fd_code, season)
    with urllib.request.urlopen(url, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(raw))
    return [row for row in reader]


def _season_to_dates(season: str) -> Tuple[str, str]:
    """Convert FD's 'YYYY-YY' or 'YYZZ' season (e.g. '2324' -> 2023-2024) to
    a UTC ISO date window for SQL filtering. Most European leagues start
    around early August and end mid-May/June."""
    yy_start = int(season[:2]) + 2000
    yy_end = yy_start + 1
    return f"{yy_start}-07-01", f"{yy_end}-07-15"


def _canonicalize(name: str, aliases: Dict[str, str]) -> str:
    return aliases.get(name, name).strip()


def _resolve_archive_row(
    conn: sqlite3.Connection,
    league: LeagueRef,
    sample_size: int,
    season_start: str,
    season_end: str,
    seed: int,
) -> List[Tuple[str, str, str, str]]:
    """Return random ``(event_id, home, away, start_time_utc)`` tuples for the
    given league/season window."""
    rows = conn.execute(
        """
        SELECT s.event_id,
               json_extract(s.match_stats_payload_json, '$.event.home_team') AS home,
               json_extract(s.match_stats_payload_json, '$.event.away_team') AS away,
               json_extract(s.match_stats_payload_json, '$.event.start_time_utc') AS kickoff
        FROM match_stats_snapshots s
        JOIN match_event_summaries m USING(event_id)
        WHERE m.sport = 'football'
          AND m.country = ?
          AND m.competition = ?
          AND m.start_time_utc BETWEEN ? AND ?
        """,
        (league.archive_country, league.archive_competition, season_start, season_end),
    ).fetchall()
    rng = random.Random(seed)
    rng.shuffle(rows)
    return [tuple(r) for r in rows[:sample_size]]


def _archive_1x2_ft(conn: sqlite3.Connection, event_id: str) -> List[Tuple[str, float, float, float]]:
    """Return ``(bookmaker, home_price, draw_price, away_price)`` per CZ book.

    Outcome ordering in the mapped payload is **[home, away, draw]**. The
    draw row is identifiable in the upstream payload as the entry with
    ``eventParticipantId=None``. We default to ``draw_index=2`` (the third
    entry) if the upstream is unavailable.
    """
    row = conn.execute(
        "SELECT odds_payload_json, upstream_payload_json FROM odds_snapshots WHERE event_id = ?",
        (event_id,),
    ).fetchone()
    if not row:
        return []
    payload = json.loads(row[0])
    upstream = json.loads(row[1]) if row[1] else None

    draw_index = 2
    if upstream:
        for entry in upstream.get("data", {}).get("findOddsByEventId", {}).get("odds", []):
            if (
                entry.get("bettingType") == "HOME_DRAW_AWAY"
                and entry.get("bettingScope") == "FULL_TIME"
            ):
                for i, o in enumerate(entry.get("odds", [])):
                    if o.get("eventParticipantId") is None:
                        draw_index = i
                        break
                break

    out: List[Tuple[str, float, float, float]] = []
    for bk in payload.get("event", {}).get("bookmakers", []):
        bk_name = bk.get("name") or "unknown"
        for m in bk.get("markets", []):
            if m.get("key") != "HOME_DRAW_AWAY:FULL_TIME":
                continue
            outcomes = m.get("outcomes", [])
            if len(outcomes) != 3:
                continue
            prices = [o.get("odds_decimal") for o in outcomes]
            if any(p is None for p in prices):
                continue
            non_draw_indices = [i for i in range(3) if i != draw_index]
            home_p = float(prices[non_draw_indices[0]])
            away_p = float(prices[non_draw_indices[1]])
            draw_p = float(prices[draw_index])
            out.append((bk_name, home_p, draw_p, away_p))
    return out


def _proportional_devig(h: float, d: float, a: float) -> Tuple[float, float, float]:
    inv = [1.0 / h, 1.0 / d, 1.0 / a]
    s = sum(inv)
    return inv[0] / s, inv[1] / s, inv[2] / s


def _find_fd_match(
    fd_rows: List[Dict[str, str]],
    league: LeagueRef,
    home_archive: str,
    away_archive: str,
    kickoff_iso: str,
) -> Optional[Dict[str, str]]:
    """Match an archive event to a football-data row.

    Matches on FD-canonical team names + date. Date check is tolerant of
    timezone shifts because FD's ``Date`` is European local and our
    ``start_time_utc`` is UTC; we compare ±1 day.
    """
    home_canon = _canonicalize(home_archive, league.name_aliases)
    away_canon = _canonicalize(away_archive, league.name_aliases)
    kickoff_date = kickoff_iso.split("T")[0]
    target_y, target_m, target_d = (int(p) for p in kickoff_date.split("-"))

    for row in fd_rows:
        if row.get("HomeTeam") != home_canon or row.get("AwayTeam") != away_canon:
            continue
        # FD date is dd/mm/yyyy
        try:
            d, m, y = (int(p) for p in row["Date"].split("/"))
        except (KeyError, ValueError):
            continue
        if y != target_y or m != target_m:
            continue
        if abs(d - target_d) <= 1:
            return row
    return None


def run(
    league_key: str,
    season: str,
    sample: int,
    seed: int,
    price_tolerance: float,
    devig_tolerance: float,
) -> int:
    league = _LEAGUES.get(league_key.upper())
    if league is None:
        print(f"error: unknown league '{league_key}'. Known: {sorted(_LEAGUES)}", file=sys.stderr)
        return 2

    season_start, season_end = _season_to_dates(season)
    print(f"league={league.short}  fd_code={league.fd_code}  season={season}  "
          f"window=[{season_start},{season_end}]  sample={sample}")

    try:
        fd_rows = _fetch_fd_csv(league.fd_code, season)
    except Exception as exc:
        print(f"error: failed to fetch football-data CSV: {exc}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    try:
        candidates = _resolve_archive_row(
            conn, league, sample, season_start, season_end, seed,
        )
        if not candidates:
            print("error: no archive matches for that league/season window", file=sys.stderr)
            return 2

        print()
        print(f"{'event_id':<10} {'archive H/D/A':<26} {'B365 H/D/A':<22} "
              f"{'dv_arch':<25} {'dv_avgC':<25} {'maxΔ':<6}")
        print("-" * 120)

        pass_price = 0
        pass_devig_match = 0
        total_selections = 0
        sample_actual = 0

        for event_id, home, away, kickoff in candidates:
            fd_row = _find_fd_match(fd_rows, league, home, away, kickoff)
            if fd_row is None:
                print(f"{event_id}  no fd match for {home!r} vs {away!r} on {kickoff}")
                continue
            archive = _archive_1x2_ft(conn, event_id)
            if not archive:
                print(f"{event_id}  no archive 1X2 FT odds")
                continue
            sample_actual += 1
            h_arch = mean(t[1] for t in archive)
            d_arch = mean(t[2] for t in archive)
            a_arch = mean(t[3] for t in archive)
            arch_dv = _proportional_devig(h_arch, d_arch, a_arch)
            try:
                avgch = float(fd_row["AvgCH"])
                avgcd = float(fd_row["AvgCD"])
                avgca = float(fd_row["AvgCA"])
                b365 = (float(fd_row["B365CH"]), float(fd_row["B365CD"]), float(fd_row["B365CA"]))
                pinn = (float(fd_row["PSCH"]), float(fd_row["PSCD"]), float(fd_row["PSCA"]))
            except (KeyError, ValueError):
                print(f"{event_id}  fd row missing closing columns")
                continue
            market_dv = _proportional_devig(avgch, avgcd, avgca)
            diffs = [abs(a - m) for a, m in zip(arch_dv, market_dv)]
            max_diff = max(diffs)

            print(
                f"{event_id}  {h_arch:>5.2f}/{d_arch:>5.2f}/{a_arch:>5.2f}        "
                f"{b365[0]:>5.2f}/{b365[1]:>5.2f}/{b365[2]:>5.2f}    "
                f"{arch_dv[0]:.3f}/{arch_dv[1]:.3f}/{arch_dv[2]:.3f}    "
                f"{market_dv[0]:.3f}/{market_dv[1]:.3f}/{market_dv[2]:.3f}    "
                f"{max_diff:.3f}"
            )
            for arch_price, b_price, p_price in zip([h_arch, d_arch, a_arch], b365, pinn):
                rel_b = abs(arch_price - b_price) / b_price
                rel_p = abs(arch_price - p_price) / p_price
                total_selections += 1
                if min(rel_b, rel_p) <= price_tolerance:
                    pass_price += 1
            if max_diff <= devig_tolerance:
                pass_devig_match += 1

        print("-" * 120)
        print()
        if sample_actual == 0:
            print("FAIL: no archive matches resolved against football-data CSV")
            return 1
        a_pct = 100 * pass_price / max(total_selections, 1)
        b_pct = 100 * pass_devig_match / sample_actual
        print(f"Test A (selection prices within {price_tolerance*100:.0f}% of B365 or PS closing): "
              f"{pass_price}/{total_selections} ({a_pct:.0f}%)")
        print(f"Test B (devigged max diff <= {devig_tolerance:.2f} per match): "
              f"{pass_devig_match}/{sample_actual} matches ({b_pct:.0f}%)")
        passed = a_pct >= 90 and b_pct >= 80
        print()
        print("RESULT:", "PASS" if passed else "FAIL")
        return 0 if passed else 1
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True, help="EPL, BUN, LIGA, L1, CH")
    parser.add_argument("--season", default="2324", help="FD season code, e.g. 2324 for 2023-24")
    parser.add_argument("--sample", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--price-tolerance", type=float, default=0.07)
    parser.add_argument("--devig-tolerance", type=float, default=0.03)
    args = parser.parse_args()
    return run(
        args.league, args.season, args.sample, args.seed,
        args.price_tolerance, args.devig_tolerance,
    )


if __name__ == "__main__":
    sys.exit(main())
