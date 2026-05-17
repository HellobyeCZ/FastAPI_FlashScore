"""Walk-forward backtesting harness for 1X2 FT.

Phase 2 semantics:
  - Test set = every event in scope with kickoff strictly after
    ``train_until`` (and inside any provided test_window).
  - For each test event, ``as_of_ts = kickoff − CLOSING_LINE_BUFFER`` so
    closing-line market features are available (see ``features.py``).
  - Model returns ``{selection: probability}`` for home/draw/away.
  - Bet on each selection where ``edge = model_prob − devigged_prob >=
    min_edge``. Stake = ``kelly_fraction × full_kelly`` of one unit
    bankroll per bet (running bankroll not yet tracked — that's a
    Phase-4 concern).
  - CLV is populated only when a separate live-odds snapshot exists for
    the event at a time before our ``as_of_ts``. With archive-only
    data, ``as_of_ts ≈ kickoff − 5min`` and the archive *is* closing,
    so price_taken == closing_price and CLV is identically 0. The
    backtester records it for downstream consumers nonetheless.

The "sanity check" required by the spec is implemented in
:mod:`tests.ml.test_backtest`: the market_implied baseline at
``min_edge=0`` (forced bets) should produce ROI ≈ −vig and CLV ≈ 0.
"""
from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from app.ml import db as ml_db
from app.ml.features import CLOSING_LINE_BUFFER, get_features
from app.ml.labels import FOOTBALL_PHASE1_SCOPE
from app.ml.market_spec import FOOTBALL_1X2_FT, MarketSpec
from app.ml.models import ModelFn, get as get_model


SELECTIONS = ("home", "draw", "away")


@dataclass(frozen=True)
class BetRecord:
    event_id: str
    bet_ts: str
    market: str
    selection: str            # "home" | "draw" | "away"
    price_taken: float
    closing_price: float
    model_prob: float
    implied_prob: float
    devigged_prob: float
    edge: float
    stake_kelly_fraction: float
    result: float             # 1.0 or 0.0
    pnl: float                # (stake * (price-1)) on win, −stake on loss
    clv: Optional[float]      # forward-only; None for archive-only bets


@dataclass(frozen=True)
class ReliabilityBucket:
    lower: float
    upper: float
    n: int
    mean_pred: float
    hit_rate: float


@dataclass(frozen=True)
class BacktestReport:
    model: str
    scope_size: int
    test_events: int
    bets: List[BetRecord]
    total_bets: int
    hit_rate: float
    roi: float
    mean_clv: Optional[float]
    brier: float
    log_loss: float
    max_drawdown: float
    reliability_buckets: List[ReliabilityBucket]
    config: Dict[str, Any]
    n_train_events: int = 0
    return_per_bet: float = 1.0
    rmse_per_bet: float = 0.0
    sharpe_adjusted: float = 0.0
    reliability_svg: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out = asdict(self)
        # asdict converts the lists of dataclasses correctly; nothing
        # else to do.
        return out


# ---------------------------------------------------------------------------
# Closing-odds resolution
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ClosingMarket:
    """Aggregated per-event 1X2 FT view: ``selection -> (price, implied,
    devigged)``. Prices and devigged probs are averaged across bookmakers.
    """
    prices: Dict[str, float]
    implied: Dict[str, float]
    devigged: Dict[str, float]
    home_team: str
    away_team: str


def _resolve_home_selection_key(conn: sqlite3.Connection, event_id: str) -> Optional[str]:
    """Return the closing_odds.selection_key that corresponds to the home
    team. Following the convention validated in
    scripts/spot_check_closing.py: the first non-DRAW
    ``eventParticipantId`` in the upstream 1X2 FT market is the home
    team."""
    row = conn.execute(
        "SELECT upstream_payload_json FROM odds_snapshots WHERE event_id = ? ORDER BY id DESC LIMIT 1",
        (event_id,),
    ).fetchone()
    if row is None or not row["upstream_payload_json"]:
        return None
    try:
        upstream = json.loads(row["upstream_payload_json"])
    except (TypeError, json.JSONDecodeError):
        return None
    container = (upstream or {}).get("data", {}).get("findOddsByEventId")
    if not isinstance(container, dict):
        return None
    for entry in container.get("odds") or ():
        if entry.get("bettingType") != "HOME_DRAW_AWAY" or entry.get("bettingScope") != "FULL_TIME":
            continue
        for outcome in entry.get("odds") or ():
            pid = outcome.get("eventParticipantId")
            if pid:
                return str(pid)
    return None


def _load_closing_market(
    conn: sqlite3.Connection,
    event_id: str,
) -> Optional[ClosingMarket]:
    label = conn.execute(
        "SELECT home_team, away_team FROM bet_labels WHERE event_id = ?",
        (event_id,),
    ).fetchone()
    if label is None:
        return None
    home_team, away_team = label["home_team"], label["away_team"]
    home_sel = _resolve_home_selection_key(conn, event_id)
    rows = conn.execute(
        """
        SELECT selection_key,
               AVG(decimal_price) AS price,
               AVG(implied_prob) AS implied,
               AVG(devigged_prob) AS devigged
        FROM closing_odds
        WHERE event_id = ?
          AND market = 'HOME_DRAW_AWAY:FULL_TIME'
        GROUP BY selection_key
        """,
        (event_id,),
    ).fetchall()
    if not rows:
        return None

    prices: Dict[str, float] = {}
    implied: Dict[str, float] = {}
    devigged: Dict[str, float] = {}
    other_rows: List[sqlite3.Row] = []
    for r in rows:
        sk = r["selection_key"]
        if sk == "DRAW":
            prices["draw"] = float(r["price"])
            implied["draw"] = float(r["implied"])
            if r["devigged"] is not None:
                devigged["draw"] = float(r["devigged"])
        elif home_sel and sk == home_sel:
            prices["home"] = float(r["price"])
            implied["home"] = float(r["implied"])
            if r["devigged"] is not None:
                devigged["home"] = float(r["devigged"])
        else:
            other_rows.append(r)

    if home_sel and len(other_rows) == 1:
        away_row = other_rows[0]
        prices["away"] = float(away_row["price"])
        implied["away"] = float(away_row["implied"])
        if away_row["devigged"] is not None:
            devigged["away"] = float(away_row["devigged"])

    if set(prices.keys()) != {"home", "draw", "away"}:
        return None
    if set(devigged.keys()) != {"home", "draw", "away"}:
        return None
    return ClosingMarket(
        prices=prices, implied=implied, devigged=devigged,
        home_team=home_team, away_team=away_team,
    )


# ---------------------------------------------------------------------------
# Walk-forward driver
# ---------------------------------------------------------------------------

def _scope_filter_sql(scope: Sequence[Tuple[str, str]]) -> Tuple[str, List[str]]:
    if not scope:
        return "1=1", []
    placeholders = ",".join("(?, ?)" for _ in scope)
    params: List[str] = []
    for country, competition in scope:
        params.extend([country, competition])
    return f"(country, competition) IN (VALUES {placeholders})", params


def _iter_test_events(
    *,
    sport: str,
    scope: Sequence[Tuple[str, str]],
    train_until: str,
    test_until: Optional[str],
) -> List[Tuple[str, str]]:
    where, params = _scope_filter_sql(scope)
    extra = ""
    if test_until is not None:
        extra = " AND start_time_utc <= ?"
        params = list(params) + [test_until]
    with ml_db.connect(read_only=True) as conn:
        rows = conn.execute(
            f"""
            SELECT event_id, start_time_utc
            FROM bet_labels
            WHERE sport = ?
              AND {where}
              AND start_time_utc > ?
              {extra}
            ORDER BY start_time_utc ASC
            """,
            (sport, *params[: len(params) - (1 if test_until else 0)], train_until,
             *(params[-1:] if test_until else ())),
        ).fetchall()
    return [(r["event_id"], r["start_time_utc"]) for r in rows]


def run_backtest(
    *,
    model: ModelFn | str,
    sport: str = "football",
    scope: Sequence[Tuple[str, str]] = FOOTBALL_PHASE1_SCOPE,
    train_until: str,
    test_until: Optional[str] = None,
    min_edge: float = 0.02,
    kelly_fraction: float = 0.25,
    force_bets: bool = False,
    market_spec: MarketSpec = FOOTBALL_1X2_FT,
) -> BacktestReport:
    """Run a walk-forward backtest. ``model`` is either a registered name
    or a callable. ``force_bets=True`` disables the edge gate — used by
    the sanity tests to force every selection through the metrics path.
    """
    model_fn = get_model(model) if isinstance(model, str) else model
    model_name = model if isinstance(model, str) else getattr(model, "__name__", "anonymous")

    events = _iter_test_events(
        sport=sport, scope=scope, train_until=train_until, test_until=test_until,
    )
    bets: List[BetRecord] = []
    pnl_running = 0.0
    drawdown_peak = 0.0
    max_dd = 0.0
    hits = 0
    total_stake = 0.0

    with ml_db.connect(read_only=True) as conn:
        for event_id, kickoff_raw in events:
            market = _load_closing_market(conn, event_id)
            if market is None:
                continue
            kickoff = _parse_iso(kickoff_raw)
            as_of = (kickoff - CLOSING_LINE_BUFFER).isoformat().replace("+00:00", "Z")
            features = get_features(event_id, as_of)
            if features is None:
                continue
            label_row = conn.execute(
                "SELECT outcome_1x2 FROM bet_labels WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if label_row is None:
                continue
            outcome = label_row["outcome_1x2"]
            results = market_spec.label_fn({"outcome_1x2": outcome})

            market_ctx = {
                "implied_prob_home": market.implied["home"],
                "implied_prob_draw": market.implied["draw"],
                "implied_prob_away": market.implied["away"],
                "devigged_prob_home": market.devigged["home"],
                "devigged_prob_draw": market.devigged["draw"],
                "devigged_prob_away": market.devigged["away"],
            }
            try:
                probs = model_fn(features, market_ctx)
            except Exception:
                continue
            if not _valid_prob_dict(probs, market_spec.selections):
                continue

            for sel in market_spec.selections:
                model_p = float(probs[sel])
                price = market.prices[sel]
                implied = market.implied[sel]
                devigged = market.devigged[sel]
                edge = model_p - devigged
                if not force_bets and edge < min_edge:
                    continue
                stake = max(0.0, kelly_fraction * _kelly_fraction_of_bankroll(model_p, price))
                if not force_bets and stake <= 0:
                    continue
                if force_bets and stake <= 0:
                    stake = 1.0  # a unit stake to exercise the metrics path
                result = results[sel]
                pnl = stake * (price - 1.0) if result == 1.0 else -stake
                pnl_running += pnl
                total_stake += stake
                if result == 1.0:
                    hits += 1
                drawdown_peak = max(drawdown_peak, pnl_running)
                max_dd = max(max_dd, drawdown_peak - pnl_running)
                bets.append(BetRecord(
                    event_id=event_id,
                    bet_ts=as_of,
                    market="HOME_DRAW_AWAY:FULL_TIME",
                    selection=sel,
                    price_taken=price,
                    closing_price=price,
                    model_prob=model_p,
                    implied_prob=implied,
                    devigged_prob=devigged,
                    edge=edge,
                    stake_kelly_fraction=stake,
                    result=result,
                    pnl=pnl,
                    clv=0.0,    # price_taken == closing_price for archive bets
                ))

    metrics = _compute_metrics(bets, total_stake=total_stake, hits=hits, max_dd=max_dd)
    return_per_bet, rmse_per_bet, sharpe_adjusted = _compute_sharpe_adjusted(bets)
    return BacktestReport(
        model=str(model_name),
        scope_size=len(events),
        test_events=len(events),
        bets=bets,
        total_bets=len(bets),
        hit_rate=metrics["hit_rate"],
        roi=metrics["roi"],
        mean_clv=metrics["mean_clv"],
        brier=metrics["brier"],
        log_loss=metrics["log_loss"],
        max_drawdown=metrics["max_drawdown"],
        reliability_buckets=metrics["reliability_buckets"],
        config={
            "min_edge": min_edge,
            "kelly_fraction": kelly_fraction,
            "force_bets": force_bets,
            "train_until": train_until,
            "test_until": test_until,
        },
        n_train_events=0,  # populated by trainable adapters in a follow-up; 0 is safe today
        return_per_bet=return_per_bet,
        rmse_per_bet=rmse_per_bet,
        sharpe_adjusted=sharpe_adjusted,
        reliability_svg=None,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_iso(ts: str) -> datetime:
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _valid_prob_dict(probs: Mapping[str, float], selections: Sequence[str] = SELECTIONS) -> bool:
    if set(probs.keys()) != set(selections):
        return False
    s = sum(probs.values())
    return 0.99 <= s <= 1.01


def _compute_sharpe_adjusted(bets: Sequence[BetRecord]) -> tuple[float, float, float]:
    """Return (return_per_bet, rmse_per_bet, sharpe_adjusted).

    Definition: each bet contributes pnl = (k_i - 1) on win, -1 on loss for
    a unit stake. Return-to-bettor = 1 + pnl (so 1.0 = breakeven).
    Sharpe-adjusted = (R_p - 1) / RMSE_p with R_p = mean(1 + pnl) and
    RMSE_p = sqrt(mean(pnl^2)).
    """
    n = len(bets)
    if n == 0:
        return 1.0, 0.0, 0.0
    pnls = [b.pnl for b in bets]
    return_per_bet = 1.0 + sum(pnls) / n
    rmse_per_bet = math.sqrt(sum(p * p for p in pnls) / n)
    sharpe = (return_per_bet - 1.0) / rmse_per_bet if rmse_per_bet > 0 else 0.0
    return return_per_bet, rmse_per_bet, sharpe


def _kelly_fraction_of_bankroll(prob: float, price: float) -> float:
    """Full Kelly fraction f = (bp − q) / b, where b = price − 1, p = model
    prob, q = 1 − p. Negative or zero means don't bet."""
    b = price - 1.0
    if b <= 0:
        return 0.0
    return max(0.0, (b * prob - (1.0 - prob)) / b)


def _compute_metrics(
    bets: List[BetRecord],
    *,
    total_stake: float,
    hits: int,
    max_dd: float,
) -> Dict[str, Any]:
    n = len(bets)
    hit_rate = hits / n if n else 0.0
    total_pnl = sum(b.pnl for b in bets)
    roi = total_pnl / total_stake if total_stake > 0 else 0.0
    brier = sum((b.model_prob - b.result) ** 2 for b in bets) / n if n else 0.0
    # Log loss: cap probs to (eps, 1−eps) to avoid log(0) blowups.
    eps = 1e-9
    log_loss_sum = 0.0
    for b in bets:
        p = min(max(b.model_prob, eps), 1.0 - eps)
        if b.result == 1.0:
            log_loss_sum -= math.log(p)
        else:
            log_loss_sum -= math.log(1.0 - p)
    log_loss = log_loss_sum / n if n else 0.0
    clv_vals = [b.clv for b in bets if b.clv is not None]
    mean_clv = sum(clv_vals) / len(clv_vals) if clv_vals else None
    return {
        "hit_rate": hit_rate,
        "roi": roi,
        "mean_clv": mean_clv,
        "brier": brier,
        "log_loss": log_loss,
        "max_drawdown": max_dd,
        "reliability_buckets": _reliability_buckets(bets),
    }


def _reliability_buckets(bets: List[BetRecord], *, n_buckets: int = 10) -> List[ReliabilityBucket]:
    width = 1.0 / n_buckets
    buckets: List[List[BetRecord]] = [[] for _ in range(n_buckets)]
    for b in bets:
        idx = min(int(b.model_prob / width), n_buckets - 1)
        buckets[idx].append(b)
    out: List[ReliabilityBucket] = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        mean_pred = sum(b.model_prob for b in bucket) / len(bucket)
        hit_rate = sum(b.result for b in bucket) / len(bucket)
        out.append(ReliabilityBucket(
            lower=i * width,
            upper=(i + 1) * width,
            n=len(bucket),
            mean_pred=mean_pred,
            hit_rate=hit_rate,
        ))
    return out


# ---------------------------------------------------------------------------
# Reliability plot — pure-stdlib SVG renderer
# ---------------------------------------------------------------------------

def render_reliability_svg(buckets: Sequence[ReliabilityBucket], *, width: int = 480, height: int = 480) -> str:
    """Render a reliability/calibration diagram as an SVG string.

    Returns plain SVG markup so the caller can write it to disk or
    embed it directly. No external dependencies.
    """
    pad = 50
    plot_w = width - 2 * pad
    plot_h = height - 2 * pad

    def x_of(p: float) -> float:
        return pad + p * plot_w

    def y_of(p: float) -> float:
        return height - pad - p * plot_h

    parts: List[str] = []
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" font-family="sans-serif">')
    parts.append('<style>.axis{stroke:#222;stroke-width:1.5} .grid{stroke:#ccc;stroke-width:0.5} .ref{stroke:#999;stroke-dasharray:4 4;stroke-width:1} .pt{fill:#1f77b4} .lbl{fill:#222;font-size:11px}</style>')
    parts.append(f'<rect x="0" y="0" width="{width}" height="{height}" fill="white"/>')

    # Grid + axes
    for g in range(0, 11):
        v = g / 10.0
        parts.append(f'<line class="grid" x1="{x_of(v)}" y1="{y_of(0)}" x2="{x_of(v)}" y2="{y_of(1)}"/>')
        parts.append(f'<line class="grid" x1="{x_of(0)}" y1="{y_of(v)}" x2="{x_of(1)}" y2="{y_of(v)}"/>')
    parts.append(f'<line class="axis" x1="{x_of(0)}" y1="{y_of(0)}" x2="{x_of(1)}" y2="{y_of(0)}"/>')
    parts.append(f'<line class="axis" x1="{x_of(0)}" y1="{y_of(0)}" x2="{x_of(0)}" y2="{y_of(1)}"/>')
    parts.append(f'<line class="ref" x1="{x_of(0)}" y1="{y_of(0)}" x2="{x_of(1)}" y2="{y_of(1)}"/>')

    # Labels
    parts.append(f'<text class="lbl" x="{width/2}" y="{height-15}" text-anchor="middle">Predicted probability</text>')
    parts.append(f'<text class="lbl" x="15" y="{height/2}" text-anchor="middle" transform="rotate(-90 15 {height/2})">Empirical hit rate</text>')
    for g in (0, 0.25, 0.5, 0.75, 1.0):
        parts.append(f'<text class="lbl" x="{x_of(g)}" y="{height-pad+15}" text-anchor="middle">{g:.2f}</text>')
        parts.append(f'<text class="lbl" x="{pad-8}" y="{y_of(g)+4}" text-anchor="end">{g:.2f}</text>')

    # Bucket points; radius scales with sqrt(n) so n=1 isn't equal to n=1000.
    if buckets:
        max_n = max(b.n for b in buckets)
        for b in buckets:
            r = 3 + 9 * math.sqrt(b.n / max_n) if max_n else 4
            parts.append(
                f'<circle class="pt" cx="{x_of(b.mean_pred):.2f}" cy="{y_of(b.hit_rate):.2f}" r="{r:.2f}" fill-opacity="0.7"/>'
            )

    parts.append('</svg>')
    return "".join(parts)
