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


def match_probabilities(
    lam_home: float,
    lam_away: float,
    *,
    cfg: DCConfig = DCConfig(),
) -> Tuple[float, float, float]:
    """Compute (P(home_win), P(draw), P(away_win)) from match-rate
    estimates, applying the DC tau correction. Returns probabilities
    summing to 1."""
    k = cfg.max_goals + 1
    pmf_h = _poisson_pmf_vec(lam_home, k)
    pmf_a = _poisson_pmf_vec(lam_away, k)
    grid = np.outer(pmf_h, pmf_a)
    # Apply DC correction on the four low-score cells.
    for h in (0, 1):
        for a in (0, 1):
            grid[h, a] *= _dc_tau(h, a, lam_home, lam_away, cfg.rho)
    # Renormalise — tau can push slightly off 1.
    total = grid.sum()
    if total <= 0:
        return 1 / 3, 1 / 3, 1 / 3
    grid = grid / total
    p_home = float(np.tril(grid, k=-1).sum())
    p_draw = float(np.trace(grid))
    p_away = float(np.triu(grid, k=1).sum())
    return p_home, p_draw, p_away


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
    rates: Dict[str, TeamRates] = {}
    eta = _ewma_factor(cfg.ewma_half_life)

    for ev in events:
        home = ev["home_team"]
        away = ev["away_team"]
        home_rates = rates.get(
            home, TeamRates(cfg.initial_rate, cfg.initial_rate, 0),
        )
        away_rates = rates.get(
            away, TeamRates(cfg.initial_rate, cfg.initial_rate, 0),
        )

        snapshots.append(TeamRateSnapshot(
            event_id=ev["event_id"], team=home, side="home",
            pre_attack=home_rates.attack, pre_defense=home_rates.defense,
            matches_seen=home_rates.matches_seen,
        ))
        snapshots.append(TeamRateSnapshot(
            event_id=ev["event_id"], team=away, side="away",
            pre_attack=away_rates.attack, pre_defense=away_rates.defense,
            matches_seen=away_rates.matches_seen,
        ))

        # Update after recording pre-match state.
        home_score = _blend_score(ev["home_score"], ev.get("home_xg"), cfg.xg_weight)
        away_score = _blend_score(ev["away_score"], ev.get("away_xg"), cfg.xg_weight)

        # Opponent-adjusted attack: how many did we score relative to what
        # an average team would score against this defense?
        expected_home_atk = max(0.05, away_rates.defense * cfg.league_mean_goals * cfg.home_advantage)
        expected_away_atk = max(0.05, home_rates.defense * cfg.league_mean_goals)
        new_home_atk = home_score / expected_home_atk
        new_away_atk = away_score / expected_away_atk

        # Symmetric for defense — what we conceded relative to the
        # opponent's attack.
        expected_home_def = max(0.05, away_rates.attack * cfg.league_mean_goals)
        expected_away_def = max(0.05, home_rates.attack * cfg.league_mean_goals * cfg.home_advantage)
        # A team's defense is *good* when they concede less; the rate is
        # multiplicative on opponent rate so "concede less than expected"
        # = ratio < 1. We invert later in match_probabilities via the
        # multiplication structure.
        new_home_def_ratio = away_score / expected_home_def
        new_away_def_ratio = home_score / expected_away_def

        # Clip extreme values to keep rates bounded.
        def _clip(x: float) -> float:
            return max(0.1, min(4.0, x))

        rates[home] = TeamRates(
            attack=(1.0 - eta) * home_rates.attack + eta * _clip(new_home_atk),
            defense=(1.0 - eta) * home_rates.defense + eta * _clip(new_home_def_ratio),
            matches_seen=home_rates.matches_seen + 1,
        )
        rates[away] = TeamRates(
            attack=(1.0 - eta) * away_rates.attack + eta * _clip(new_away_atk),
            defense=(1.0 - eta) * away_rates.defense + eta * _clip(new_away_def_ratio),
            matches_seen=away_rates.matches_seen + 1,
        )

    return snapshots


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
