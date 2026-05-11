"""Paper-trade log: records picks at recommendation time and settles
them once events terminate.

Each pick becomes a ``paper_bets`` row with status ``pending`` and the
live-snapshot price + model edge captured at recommendation time.
Once the event settles, the row gets ``result``, ``pnl``, ``clv``,
and ``closing_price`` filled in.

CLV uses the convention CLV = ln(price_at_recommendation /
closing_price). Positive when the price we took was longer than the
price the market eventually closed at — the standard sportsbook
metric for "we beat the close."
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from math import log
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.ml import db as ml_db


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def _ensure_paper_bets_table() -> None:
    """Create paper_bets if it doesn't exist. Idempotent."""
    with sqlite3.connect(ml_db.db_path(), timeout=60.0) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS paper_bets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,
                model TEXT NOT NULL,
                market TEXT NOT NULL,
                selection TEXT NOT NULL,
                recommended_at TEXT NOT NULL,
                bet_ts TEXT NOT NULL,
                price_at_recommendation REAL NOT NULL,
                closing_price REAL,
                model_prob REAL NOT NULL,
                devigged_prob REAL,
                edge REAL,
                kelly_full REAL,
                result REAL,
                pnl REAL,
                clv REAL,
                status TEXT NOT NULL DEFAULT 'pending',
                settled_at TEXT,
                UNIQUE(event_id, model, market, selection)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_paper_bets_status ON paper_bets(status, recommended_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_paper_bets_event ON paper_bets(event_id)"
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PickInput:
    event_id: str
    model: str
    market: str
    selection: str
    bet_ts: str               # as_of_ts passed to the model
    price_at_recommendation: float
    model_prob: float
    devigged_prob: Optional[float]
    edge: Optional[float]
    kelly_full: Optional[float]


def record_picks(picks: Iterable[PickInput]) -> int:
    """Insert pending paper_bets for each pick. Duplicates on
    (event_id, model, market, selection) are ignored — the earliest
    recording stands. Returns the count of *new* rows inserted."""
    _ensure_paper_bets_table()
    now_iso = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with sqlite3.connect(ml_db.db_path(), timeout=60.0) as conn:
        for p in picks:
            try:
                conn.execute(
                    """
                    INSERT INTO paper_bets (
                        event_id, model, market, selection,
                        recommended_at, bet_ts,
                        price_at_recommendation,
                        model_prob, devigged_prob, edge, kelly_full,
                        status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                    """,
                    (
                        p.event_id, p.model, p.market, p.selection,
                        now_iso, p.bet_ts,
                        p.price_at_recommendation,
                        p.model_prob, p.devigged_prob, p.edge, p.kelly_full,
                    ),
                )
                inserted += 1
            except sqlite3.IntegrityError:
                # Already recorded — skip silently.
                pass
        conn.commit()
    return inserted


# ---------------------------------------------------------------------------
# Settlement
# ---------------------------------------------------------------------------

def _outcome_for_market(label_row: sqlite3.Row, market: str, selection: str) -> Optional[int]:
    """Resolve the bet's result (1 win, 0 loss) given a settled bet_labels
    row and the (market, selection) of the bet. Returns None if the
    market isn't supported."""
    if market == "1X2_FT":
        target = label_row["outcome_1x2"]
        if target not in {"home", "draw", "away"}:
            return None
        return 1 if selection == target else 0
    if market == "OVER_UNDER_2.5_FT":
        over = bool(label_row["over_2_5"])
        if selection == "over":
            return 1 if over else 0
        if selection == "under":
            return 0 if over else 1
        return None
    if market == "BTTS_FT":
        yes = bool(label_row["btts"])
        if selection == "yes":
            return 1 if yes else 0
        if selection == "no":
            return 0 if yes else 1
        return None
    return None


def _closing_price_for_selection(
    conn: sqlite3.Connection,
    event_id: str,
    market: str,
    selection: str,
    home_selection_key: Optional[str],
    away_selection_key: Optional[str],
) -> Optional[float]:
    """Look up the closing price for a (event, market, selection) by
    averaging across bookmakers in closing_odds. Mapping selection →
    closing_odds.selection_key depends on the market."""
    if market == "1X2_FT":
        if selection == "draw":
            key = "DRAW"
        elif selection == "home":
            key = home_selection_key
        elif selection == "away":
            key = away_selection_key
        else:
            return None
        if key is None:
            return None
        target_market = "HOME_DRAW_AWAY:FULL_TIME"
        row = conn.execute(
            """
            SELECT AVG(decimal_price) AS p
            FROM closing_odds
            WHERE event_id = ? AND market = ? AND selection_key = ?
            """,
            (event_id, target_market, key),
        ).fetchone()
    elif market == "OVER_UNDER_2.5_FT":
        target_market = "OVER_UNDER:FULL_TIME"
        target_sel = f"{selection.upper()}@2.5"
        row = conn.execute(
            """
            SELECT AVG(decimal_price) AS p
            FROM closing_odds
            WHERE event_id = ? AND market = ? AND selection_key = ?
            """,
            (event_id, target_market, target_sel),
        ).fetchone()
    elif market == "BTTS_FT":
        target_market = "BOTH_TEAMS_TO_SCORE:FULL_TIME"
        target_sel = selection.upper()
        row = conn.execute(
            """
            SELECT AVG(decimal_price) AS p
            FROM closing_odds
            WHERE event_id = ? AND market = ? AND selection_key = ?
            """,
            (event_id, target_market, target_sel),
        ).fetchone()
    else:
        return None
    return float(row["p"]) if row and row["p"] is not None else None


def _resolve_home_away_keys(conn: sqlite3.Connection, event_id: str) -> Tuple[Optional[str], Optional[str]]:
    """Same logic as serving._predict — pull the first non-DRAW
    eventParticipantId out of the upstream payload as home, second as
    away. Used by the settler to look up the right closing_odds rows."""
    import json

    row = conn.execute(
        "SELECT upstream_payload_json FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1",
        (event_id,),
    ).fetchone()
    if row is None or not row["upstream_payload_json"]:
        return None, None
    try:
        up = json.loads(row["upstream_payload_json"])
    except (TypeError, ValueError):
        return None, None
    container = (up or {}).get("data", {}).get("findOddsByEventId")
    if not isinstance(container, dict):
        return None, None
    for entry in container.get("odds") or ():
        if entry.get("bettingType") != "HOME_DRAW_AWAY" or entry.get("bettingScope") != "FULL_TIME":
            continue
        non_draw: List[str] = [
            str(o.get("eventParticipantId"))
            for o in entry.get("odds") or ()
            if o.get("eventParticipantId")
        ]
        if len(non_draw) >= 2:
            return non_draw[0], non_draw[1]
    return None, None


@dataclass(frozen=True)
class SettlementSummary:
    pending_at_start: int
    settled: int
    voided: int
    skipped_no_label: int
    skipped_no_closing_price: int


def settle_pending_bets(*, kelly_stake_unit: float = 1.0) -> SettlementSummary:
    """Walk every pending paper_bet whose event is now in ``bet_labels``
    (i.e. terminal) and fill in result/pnl/clv. Idempotent — already
    settled rows are left alone.

    ``kelly_stake_unit`` scales the kelly_full fraction into an absolute
    stake. Defaults to 1.0 so a row's kelly_full=0.27 = 0.27 units risked
    on that bet. PnL = ``stake * (price - 1)`` on a win, ``−stake`` on a
    loss; CLV = ln(price_at_recommendation / closing_price).
    """
    _ensure_paper_bets_table()
    settled = voided = no_label = no_close = 0
    with sqlite3.connect(ml_db.db_path(), timeout=60.0) as conn:
        conn.row_factory = sqlite3.Row
        pending = conn.execute(
            "SELECT * FROM paper_bets WHERE status = 'pending'"
        ).fetchall()
        pending_at_start = len(pending)
        # Cache home/away selection-key resolution per event_id.
        home_away_cache: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
        now_iso = datetime.now(timezone.utc).isoformat()
        for row in pending:
            event_id = row["event_id"]
            label = conn.execute(
                "SELECT outcome_1x2, over_2_5, btts FROM bet_labels WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if label is None:
                # Event not settled yet — leave pending.
                no_label += 1
                continue

            result = _outcome_for_market(label, row["market"], row["selection"])
            if result is None:
                # Market not supported (shouldn't happen for the three we
                # currently record). Void it so the row doesn't accumulate.
                conn.execute(
                    """
                    UPDATE paper_bets
                    SET status = 'voided', settled_at = ?
                    WHERE id = ?
                    """,
                    (now_iso, row["id"]),
                )
                voided += 1
                continue

            if event_id not in home_away_cache:
                home_away_cache[event_id] = _resolve_home_away_keys(conn, event_id)
            home_sel, away_sel = home_away_cache[event_id]
            closing_price = _closing_price_for_selection(
                conn, event_id, row["market"], row["selection"],
                home_sel, away_sel,
            )
            if closing_price is None:
                no_close += 1
                continue

            stake = float(row["kelly_full"] or 0.0) * kelly_stake_unit
            if stake <= 0:
                stake = 0.0
            price = float(row["price_at_recommendation"])
            pnl = stake * (price - 1.0) if result == 1 else -stake
            try:
                clv = log(price / closing_price)
            except (ValueError, ZeroDivisionError):
                clv = None

            conn.execute(
                """
                UPDATE paper_bets
                SET closing_price = ?, result = ?, pnl = ?, clv = ?,
                    status = 'settled', settled_at = ?
                WHERE id = ?
                """,
                (closing_price, float(result), pnl, clv, now_iso, row["id"]),
            )
            settled += 1
        conn.commit()

    return SettlementSummary(
        pending_at_start=pending_at_start,
        settled=settled,
        voided=voided,
        skipped_no_label=no_label,
        skipped_no_closing_price=no_close,
    )


# ---------------------------------------------------------------------------
# Read helpers for the dashboard / API
# ---------------------------------------------------------------------------

def fetch_paper_bets(
    *,
    status: Optional[str] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    _ensure_paper_bets_table()
    with sqlite3.connect(ml_db.db_path(), timeout=60.0) as conn:
        conn.row_factory = sqlite3.Row
        if status:
            rows = conn.execute(
                "SELECT * FROM paper_bets WHERE status = ? ORDER BY id DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM paper_bets ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in rows]


def fetch_summary() -> Dict[str, Any]:
    """Aggregate stats over settled paper_bets — what the dashboard
    needs to render the rolling P&L + CLV trend + per-market breakdown."""
    _ensure_paper_bets_table()
    with sqlite3.connect(ml_db.db_path(), timeout=60.0) as conn:
        conn.row_factory = sqlite3.Row
        totals = conn.execute(
            """
            SELECT
                COUNT(*) AS n,
                SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status='voided' THEN 1 ELSE 0 END) AS voided,
                SUM(pnl) AS total_pnl,
                AVG(clv) AS mean_clv
            FROM paper_bets
            """
        ).fetchone()
        per_model = conn.execute(
            """
            SELECT model, COUNT(*) AS n,
                   SUM(CASE WHEN result=1.0 THEN 1 ELSE 0 END) AS wins,
                   SUM(pnl) AS pnl,
                   AVG(clv) AS mean_clv
            FROM paper_bets WHERE status='settled'
            GROUP BY model ORDER BY model
            """
        ).fetchall()
        per_market = conn.execute(
            """
            SELECT market, COUNT(*) AS n,
                   SUM(CASE WHEN result=1.0 THEN 1 ELSE 0 END) AS wins,
                   SUM(pnl) AS pnl,
                   AVG(clv) AS mean_clv
            FROM paper_bets WHERE status='settled'
            GROUP BY market ORDER BY market
            """
        ).fetchall()
        cumulative = conn.execute(
            """
            SELECT settled_at, pnl, clv
            FROM paper_bets WHERE status='settled'
            ORDER BY settled_at ASC
            """
        ).fetchall()
    return {
        "totals": dict(totals) if totals else {},
        "per_model": [dict(r) for r in per_model],
        "per_market": [dict(r) for r in per_market],
        "settled_series": [dict(r) for r in cumulative],
    }
