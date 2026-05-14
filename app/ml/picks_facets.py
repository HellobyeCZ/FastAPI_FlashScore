"""Source-aware facet enumeration for the picks filter bar.

For each filter dimension (model, market, sport, country, competition,
selection), return the distinct values present in the chosen data
source (live paper_bets, a specific backtest_bets run, or both).
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import List

from app.ml import db as ml_db


@dataclass(frozen=True)
class FacetsResponse:
    models: List[str] = field(default_factory=list)
    markets: List[str] = field(default_factory=list)
    sports: List[str] = field(default_factory=list)
    countries: List[str] = field(default_factory=list)
    competitions: List[str] = field(default_factory=list)
    selections: List[str] = field(default_factory=list)


def _distinct(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> List[str]:
    rows = conn.execute(sql, params).fetchall()
    return sorted(
        {str(r[0]) for r in rows if r[0] is not None and str(r[0]).strip()}
    )


def facets_for_live() -> FacetsResponse:
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        return FacetsResponse(
            models=_distinct(conn, "SELECT DISTINCT model FROM paper_bets"),
            markets=_distinct(conn, "SELECT DISTINCT market FROM paper_bets"),
            sports=_distinct(
                conn,
                "SELECT DISTINCT mes.sport FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            countries=_distinct(
                conn,
                "SELECT DISTINCT mes.country FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            competitions=_distinct(
                conn,
                "SELECT DISTINCT mes.competition FROM paper_bets pb "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = pb.event_id",
            ),
            selections=_distinct(conn, "SELECT DISTINCT selection FROM paper_bets"),
        )


def facets_for_backtest(run_id: str) -> FacetsResponse:
    with ml_db.connect(read_only=True) as conn:
        conn.row_factory = sqlite3.Row
        run = conn.execute(
            "SELECT model FROM backtest_runs WHERE id = ?", (run_id,)
        ).fetchone()
        models = [run["model"]] if run else []

        return FacetsResponse(
            models=models,
            markets=_distinct(
                conn,
                "SELECT DISTINCT market FROM backtest_bets WHERE run_id = ?",
                (run_id,),
            ),
            sports=_distinct(
                conn,
                "SELECT DISTINCT mes.sport FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            countries=_distinct(
                conn,
                "SELECT DISTINCT mes.country FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            competitions=_distinct(
                conn,
                "SELECT DISTINCT mes.competition FROM backtest_bets b "
                "LEFT JOIN match_event_summaries mes ON mes.event_id = b.event_id "
                "WHERE b.run_id = ?",
                (run_id,),
            ),
            selections=_distinct(
                conn,
                "SELECT DISTINCT selection FROM backtest_bets WHERE run_id = ?",
                (run_id,),
            ),
        )


def facets_for_both(run_id: str) -> FacetsResponse:
    live = facets_for_live()
    bt = facets_for_backtest(run_id)
    return FacetsResponse(
        models=sorted(set(live.models) | set(bt.models)),
        markets=sorted(set(live.markets) | set(bt.markets)),
        sports=sorted(set(live.sports) | set(bt.sports)),
        countries=sorted(set(live.countries) | set(bt.countries)),
        competitions=sorted(set(live.competitions) | set(bt.competitions)),
        selections=sorted(set(live.selections) | set(bt.selections)),
    )
