"""Dixon-Coles structural model with xG-augmented goal rates.

The textbook DC paper (1997) fits global attack/defense parameters per
team via MLE on a fixed window, then computes match probabilities from
a bivariate Poisson PMF with a low-score correction tau for the four
cells {(0,0), (1,0), (0,1), (1,1)}.

This implementation differs in one practical way: we estimate per-team
attack/defense rates **chronologically** via exponential moving
averages of opponent-adjusted goal output, so each event has a
well-defined pre-match rate. That matches the walk-forward constraint
without paying the cost of refitting a global MLE at every event.

Goal data is xG when present, raw goals otherwise:

    blended_score = (1 - α) * goals + α * xg     if xg present
    blended_score = goals                         otherwise

α=0.4 by default. xG is a lower-variance signal of underlying
performance so it gets a meaningful weight where available.

At prediction time:

    λ_home = atk_home * def_away * home_advantage * league_mean
    λ_away = atk_away * def_home               * league_mean

Then build the Poisson grid up to MAX_GOALS each side, apply the
low-score correction with parameter ρ ∈ (−1, 1) (we use a sensible
default and don't fit it; the residual gain is small relative to the
rate-estimation noise), and marginalise into P(home_win), P(draw),
P(away_win).

The model is intentionally **not** registered into ``app.ml.models``
the way logistic/HGB are. It plugs into the backtester via a custom
``ModelFn`` that reads pre-match rates from a `team_rate_history`
table populated by the trainer. That table is the equivalent of
``team_elo_history`` for this model.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# Hyperparameters with defaults
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DCConfig:
    xg_weight: float = 0.4        # α in the blended score
    ewma_half_life: int = 10      # matches; ~Premier-League quarter season
    home_advantage: float = 1.30  # multiplicative on home λ
    rho: float = -0.12            # DC low-score correction (negative
                                  # = more 1-1 and 0-0 than independent
                                  # Poisson predicts, well-documented)
    max_goals: int = 10           # grid size for Poisson marginalisation
    initial_rate: float = 1.0     # starting attack/defense for new teams
    league_mean_goals: float = 1.35  # crude prior for home/away rate scale


# ---------------------------------------------------------------------------
# Bivariate-Poisson with Dixon-Coles low-score correction
# ---------------------------------------------------------------------------

def _poisson_pmf_vec(lam: float, k: int) -> np.ndarray:
    """Return [P(0), P(1), ..., P(k-1)] for a Poisson(lam)."""
    pmf = np.zeros(k)
    if lam <= 0:
        pmf[0] = 1.0
        return pmf
    pmf[0] = math.exp(-lam)
    for i in range(1, k):
        pmf[i] = pmf[i - 1] * lam / i
    return pmf


def _dc_tau(home_goals: int, away_goals: int, lam_h: float, lam_a: float, rho: float) -> float:
    """Dixon-Coles low-score correction factor τ(h, a)."""
    if home_goals == 0 and away_goals == 0:
        return 1.0 - lam_h * lam_a * rho
    if home_goals == 0 and away_goals == 1:
        return 1.0 + lam_h * rho
    if home_goals == 1 and away_goals == 0:
        return 1.0 + lam_a * rho
    if home_goals == 1 and away_goals == 1:
        return 1.0 - rho
    return 1.0


def _score_grid(
    lam_home: float,
    lam_away: float,
    *,
    cfg: DCConfig = DCConfig(),
) -> np.ndarray:
    """Return the renormalised joint score PMF up to (cfg.max_goals,
    cfg.max_goals). Cell [h, a] is P(home_goals=h, away_goals=a)."""
    k = cfg.max_goals + 1
    pmf_h = _poisson_pmf_vec(lam_home, k)
    pmf_a = _poisson_pmf_vec(lam_away, k)
    grid = np.outer(pmf_h, pmf_a)
    for h in (0, 1):
        for a in (0, 1):
            grid[h, a] *= _dc_tau(h, a, lam_home, lam_away, cfg.rho)
    total = grid.sum()
    if total <= 0:
        # Degenerate; fall back to uniform-ish grid.
        return np.full_like(grid, 1.0 / grid.size)
    return grid / total


def match_probabilities(
    lam_home: float,
    lam_away: float,
    *,
    cfg: DCConfig = DCConfig(),
) -> Tuple[float, float, float]:
    """Compute (P(home_win), P(draw), P(away_win)) from match-rate
    estimates, applying the DC tau correction. Returns probabilities
    summing to 1."""
    grid = _score_grid(lam_home, lam_away, cfg=cfg)
    p_home = float(np.tril(grid, k=-1).sum())
    p_draw = float(np.trace(grid))
    p_away = float(np.triu(grid, k=1).sum())
    return p_home, p_draw, p_away


def over_under_probabilities(
    lam_home: float,
    lam_away: float,
    *,
    line: float = 2.5,
    cfg: DCConfig = DCConfig(),
) -> Tuple[float, float]:
    """Return (P(total > line), P(total < line)) marginalising the score
    grid. ``line`` is assumed non-integer (typical 2.5, 1.5, 3.5) so the
    push case doesn't arise."""
    grid = _score_grid(lam_home, lam_away, cfg=cfg)
    over = 0.0
    under = 0.0
    for h in range(grid.shape[0]):
        for a in range(grid.shape[1]):
            if h + a > line:
                over += grid[h, a]
            elif h + a < line:
                under += grid[h, a]
    return float(over), float(under)


def btts_probabilities(
    lam_home: float,
    lam_away: float,
    *,
    cfg: DCConfig = DCConfig(),
) -> Tuple[float, float]:
    """Return (P(both teams score), P(not both)) — i.e. P(home>=1 ∧
    away>=1) vs the complement, marginalised from the score grid."""
    grid = _score_grid(lam_home, lam_away, cfg=cfg)
    yes = float(grid[1:, 1:].sum())  # both >= 1
    no = float(1.0 - yes)
    return yes, no


# ---------------------------------------------------------------------------
# Chronological rate estimation (EWMA)
# ---------------------------------------------------------------------------

@dataclass
class TeamRates:
    """Current rolling attack/defense rates for a team. ``matches_seen``
    is used to soften the rate during the warm-up phase (the first few
    matches use a wider prior so a single freak result doesn't dominate
    a team's history)."""
    attack: float
    defense: float
    matches_seen: int


def _blend_score(goals: int, xg: Optional[float], alpha: float) -> float:
    if xg is None:
        return float(goals)
    return (1.0 - alpha) * float(goals) + alpha * float(xg)


def _ewma_factor(half_life: int) -> float:
    """λ such that after `half_life` updates the weight on a single
    observation is 0.5."""
    return 1.0 - math.pow(0.5, 1.0 / max(1, half_life))


@dataclass(frozen=True)
class TeamRateSnapshot:
    """Persisted per (event_id, team): the rate as it was *before* this
    match. Used as feature input by the backtester model_fn."""
    event_id: str
    team: str
    side: str          # "home" | "away"
    pre_attack: float
    pre_defense: float
    matches_seen: int


def _iter_rate_updates(
    events: Sequence[dict],
    cfg: DCConfig,
):
    """Internal generator that yields ``(event, pre_home, pre_away,
    post_rates_dict)`` for each event in chronological order. Centralises
    the EWMA update so callers (snapshot-emitter, final-state-collector)
    don't duplicate the math."""
    rates: Dict[str, TeamRates] = {}
    eta = _ewma_factor(cfg.ewma_half_life)
    for ev in events:
        home = ev["home_team"]
        away = ev["away_team"]
        home_rates = rates.get(home, TeamRates(cfg.initial_rate, cfg.initial_rate, 0))
        away_rates = rates.get(away, TeamRates(cfg.initial_rate, cfg.initial_rate, 0))

        home_score = _blend_score(ev["home_score"], ev.get("home_xg"), cfg.xg_weight)
        away_score = _blend_score(ev["away_score"], ev.get("away_xg"), cfg.xg_weight)

        expected_home_atk = max(0.05, away_rates.defense * cfg.league_mean_goals * cfg.home_advantage)
        expected_away_atk = max(0.05, home_rates.defense * cfg.league_mean_goals)
        expected_home_def = max(0.05, away_rates.attack * cfg.league_mean_goals)
        expected_away_def = max(0.05, home_rates.attack * cfg.league_mean_goals * cfg.home_advantage)

        def _clip(x: float) -> float:
            return max(0.1, min(4.0, x))

        new_home = TeamRates(
            attack=(1.0 - eta) * home_rates.attack + eta * _clip(home_score / expected_home_atk),
            defense=(1.0 - eta) * home_rates.defense + eta * _clip(away_score / expected_home_def),
            matches_seen=home_rates.matches_seen + 1,
        )
        new_away = TeamRates(
            attack=(1.0 - eta) * away_rates.attack + eta * _clip(away_score / expected_away_atk),
            defense=(1.0 - eta) * away_rates.defense + eta * _clip(home_score / expected_away_def),
            matches_seen=away_rates.matches_seen + 1,
        )

        yield ev, home_rates, away_rates, new_home, new_away

        rates[home] = new_home
        rates[away] = new_away


def estimate_rates_chronological(
    events: Sequence[dict],
    cfg: DCConfig = DCConfig(),
) -> List[TeamRateSnapshot]:
    """Iterate ``events`` in order and produce per (event_id, team)
    pre-match rates.

    ``events`` is an ordered sequence of dicts with keys
    ``event_id, home_team, away_team, home_score, away_score,
    home_xg, away_xg`` (xg may be None). The output preserves order.
    """
    snapshots: List[TeamRateSnapshot] = []
    for ev, pre_home, pre_away, _, _ in _iter_rate_updates(events, cfg):
        snapshots.append(TeamRateSnapshot(
            event_id=ev["event_id"], team=ev["home_team"], side="home",
            pre_attack=pre_home.attack, pre_defense=pre_home.defense,
            matches_seen=pre_home.matches_seen,
        ))
        snapshots.append(TeamRateSnapshot(
            event_id=ev["event_id"], team=ev["away_team"], side="away",
            pre_attack=pre_away.attack, pre_defense=pre_away.defense,
            matches_seen=pre_away.matches_seen,
        ))
    return snapshots


def final_team_rates(
    events: Sequence[dict],
    cfg: DCConfig = DCConfig(),
) -> Dict[str, TeamRates]:
    """Walk ``events`` and return the *post-match* rates for each team
    after the last event they played. Used at serve time to predict
    upcoming fixtures whose event_id wasn't in the training set."""
    rates: Dict[str, TeamRates] = {}
    for ev, _, _, new_home, new_away in _iter_rate_updates(events, cfg):
        rates[ev["home_team"]] = new_home
        rates[ev["away_team"]] = new_away
    return rates


# ---------------------------------------------------------------------------
# Temperature scaling — single scalar per multinomial
# ---------------------------------------------------------------------------

def fit_temperature(probs: np.ndarray, y: np.ndarray) -> float:
    """Fit a single temperature T such that softmax(log(p) / T) minimises
    NLL on (probs, y). Uses a 1-D golden-section search over T ∈ [0.1, 5.0].
    Returns the optimal T (1.0 = no change)."""
    # Convert probs to logits via log; clamp to avoid -inf.
    eps = 1e-12
    logits = np.log(np.clip(probs, eps, 1.0))

    def nll(T: float) -> float:
        z = logits / T
        z = z - z.max(axis=1, keepdims=True)
        scaled = np.exp(z)
        norm = scaled / scaled.sum(axis=1, keepdims=True)
        chosen = norm[np.arange(len(y)), y]
        return float(-np.log(np.clip(chosen, eps, 1.0)).mean())

    # Golden-section over [0.1, 5.0].
    a, b = 0.1, 5.0
    phi = (math.sqrt(5) - 1) / 2
    c = b - phi * (b - a)
    d = a + phi * (b - a)
    for _ in range(40):
        if nll(c) < nll(d):
            b = d
        else:
            a = c
        c = b - phi * (b - a)
        d = a + phi * (b - a)
    return (a + b) / 2.0


def apply_temperature(probs: np.ndarray, T: float) -> np.ndarray:
    """Apply temperature T to a probability matrix."""
    if T == 1.0:
        return probs
    eps = 1e-12
    logits = np.log(np.clip(probs, eps, 1.0)) / T
    logits = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(logits)
    return e / e.sum(axis=1, keepdims=True)
