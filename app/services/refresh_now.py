"""One-button orchestration: scrape upcoming → settle → predict.

Triggered by ``POST /refresh-now`` from the frontend. Runs entirely in the
background; the endpoint returns a ``run_id`` immediately and the UI polls
``GET /refresh-now/{run_id}`` for progress + final summary.

Pipeline stages:
1. **scrape**  — one tick of :class:`LiveOddsScheduler`, which discovers
   upcoming fixtures per stored league and writes fresh odds snapshots.
2. **settle**  — :func:`settle_pending_bets`: marks any pending paper
   bets whose events have completed.
3. **predict** — load models, run each on upcoming events in the next
   ``hours_ahead`` window, write positive-edge selections to
   ``paper_bets``.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Iterable, Literal, Optional

import json

from app.ml import db as ml_db
from app.ml.closing_odds import backfill_closing_odds
from app.ml.closing_odds_from_live import backfill_closing_from_live
from app.ml.elo import EloConfig, backfill_elo
from app.ml.labels import backfill_labels
from app.ml.paper_trade import PickInput, record_picks, settle_pending_bets
from app.ml.serving import list_upcoming_events, load_models, predict_event
from app.services.bulk_scrape import (
    LiveOddsScheduler,
    LiveOddsSchedulerConfig,
)
from app.services.odds_client import build_odds_client
from app.services.storage import build_snapshot_store

logger = logging.getLogger(__name__)

Stage = Literal["queued", "scrape", "phase1", "settle", "predict", "done", "error"]


@dataclass
class RefreshRun:
    run_id: str
    status: Stage = "queued"
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    stage_progress: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "started_at": datetime.fromtimestamp(self.started_at, tz=timezone.utc).isoformat(),
            "finished_at": (
                datetime.fromtimestamp(self.finished_at, tz=timezone.utc).isoformat()
                if self.finished_at is not None
                else None
            ),
            "duration_seconds": (
                (self.finished_at or time.time()) - self.started_at
            ),
            "stage_progress": self.stage_progress,
            "error": self.error,
            "summary": self.summary,
        }


class RefreshNowManager:
    """In-memory registry of refresh runs. Single-tenant; fine for a personal cockpit."""

    def __init__(self) -> None:
        self._runs: dict[str, RefreshRun] = {}
        self._lock = Lock()
        self._active_task: Optional[asyncio.Task[None]] = None

    def active_run(self) -> Optional[RefreshRun]:
        with self._lock:
            for r in self._runs.values():
                if r.status not in {"done", "error"}:
                    return r
        return None

    def get(self, run_id: str) -> Optional[RefreshRun]:
        with self._lock:
            return self._runs.get(run_id)

    def recent(self, limit: int = 10) -> list[RefreshRun]:
        with self._lock:
            return sorted(self._runs.values(), key=lambda r: r.started_at, reverse=True)[:limit]

    def start(
        self,
        *,
        window_days: int,
        max_concurrency: int,
        hours_ahead: int,
        min_edge: float,
    ) -> RefreshRun:
        existing = self.active_run()
        if existing is not None:
            return existing
        run = RefreshRun(run_id=uuid.uuid4().hex[:12])
        with self._lock:
            self._runs[run.run_id] = run
        self._active_task = asyncio.create_task(
            self._execute(run, window_days, max_concurrency, hours_ahead, min_edge)
        )
        return run

    async def _execute(
        self,
        run: RefreshRun,
        window_days: int,
        max_concurrency: int,
        hours_ahead: int,
        min_edge: float,
    ) -> None:
        try:
            await self._stage_scrape(run, window_days, max_concurrency)
            await self._stage_phase1(run)
            await self._stage_settle(run)
            await self._stage_predict(run, hours_ahead, min_edge)
            run.status = "done"
        except Exception as exc:  # noqa: BLE001 — surface anything to the UI
            logger.exception("refresh_run_failed run_id=%s", run.run_id)
            run.status = "error"
            run.error = f"{type(exc).__name__}: {exc}"
        finally:
            run.finished_at = time.time()

    async def _stage_scrape(
        self, run: RefreshRun, window_days: int, max_concurrency: int
    ) -> None:
        run.status = "scrape"
        run.stage_progress["scrape"] = {"state": "running"}

        snapshot_store = build_snapshot_store()
        await snapshot_store.initialize()
        odds_client = build_odds_client()
        scheduler = LiveOddsScheduler(
            snapshot_store=snapshot_store,
            odds_client=odds_client,
            config=LiveOddsSchedulerConfig(
                enabled=True,
                interval_seconds=28800,  # unused; we call run_once
                window_days=window_days,
                max_concurrency=max_concurrency,
                initial_delay_seconds=0,
            ),
        )
        try:
            summary = await scheduler.run_once()
        finally:
            await scheduler.shutdown()
            await odds_client.aclose()
        run.stage_progress["scrape"] = {"state": "done", **summary}
        run.summary["scrape"] = summary

    async def _stage_phase1(self, run: RefreshRun) -> None:
        """Backfill labels + closing_odds + elo for newly terminal events.

        The settler reads ``bet_labels`` to determine outcomes and
        ``closing_odds`` for CLV. Without this step the settle stage finds
        no labels for fresh matches and leaves every pick pending.
        """
        run.status = "phase1"
        run.stage_progress["phase1"] = {"state": "running"}
        result = await asyncio.to_thread(self._phase1_sync)
        run.stage_progress["phase1"] = {"state": "done", **result}
        run.summary["phase1"] = result

    @staticmethod
    def _phase1_sync() -> dict[str, Any]:
        # Rescue: undo is_terminal=1 on stats snapshots whose payload has no
        # usable Final score (the upstream sometimes returns status=finished
        # for a half-loaded page). Without this, those rows stay terminal
        # forever and the scheduler never re-fetches them.
        unstamped = RefreshNowManager._unstamp_unparseable_terminal_rows()

        # Sanitize team names: when the scraper hits a live match page it
        # occasionally captures "Plzen LIVE" / "Slavia HT" because the
        # state badge bled into the team-name slot. Strip a small fixed set
        # of trailing badges from existing rows in the summary + labels
        # tables. Fresh scrapes are sanitized at extraction time in
        # MatchStatsClient._sanitize_team_pair.
        sanitized = RefreshNowManager._sanitize_team_name_columns()

        # Labels: derive home/away/over/under/btts from terminal stats snapshots.
        labels = backfill_labels(sport="football")
        # Closing odds + live fallback: feed the settler's CLV column.
        closing = backfill_closing_odds(sport="football")
        live_closing = backfill_closing_from_live(sport="football")
        # Elo: chronological feature for the model. Skipped if it errors so a
        # transient feature-builder issue doesn't take the whole refresh down.
        elo_upserted = 0
        elo_error: Optional[str] = None
        try:
            elo = backfill_elo(config=EloConfig(sport="football"), rebuild=False)
            elo_upserted = getattr(elo, "upserted", 0)
        except Exception as exc:  # noqa: BLE001
            elo_error = f"{type(exc).__name__}: {exc}"
            logger.warning("phase1_elo_failed", exc_info=True)

        out: dict[str, Any] = {
            "unstamped_unparseable": unstamped,
            "sanitized_team_names": sanitized,
            "labels_scanned": labels.scanned,
            "labels_upserted": labels.upserted,
            "closing_upserted": getattr(closing, "upserted", 0),
            "closing_from_live_upserted": getattr(live_closing, "upserted", 0),
            "elo_upserted": elo_upserted,
        }
        if elo_error:
            out["elo_error"] = elo_error
        return out

    # Single source of truth for team-name badge stripping. Kept in sync
    # with MatchStatsClient._TRAILING_BADGES; updating one without the
    # other would let new captures slip through or leave old rows poisoned.
    _TRAILING_BADGES: tuple[str, ...] = (
        "LIVE", "HT", "FT", "AET", "AP", "PEN",
        "POSTPONED", "ABANDONED", "INTERRUPTED",
        "CANCELLED", "DELAYED", "AWARDED", "WALKOVER",
    )

    @staticmethod
    def _strip_trailing_badge(name: str) -> str:
        import re

        cleaned = name.strip()
        while True:
            match = re.search(r"\s+([A-Z]{2,}\.?)$", cleaned)
            if not match:
                break
            token = match.group(1).rstrip(".").upper()
            if token not in RefreshNowManager._TRAILING_BADGES:
                break
            cleaned = cleaned[: match.start()].rstrip()
        return cleaned or name.strip()

    @staticmethod
    def _sanitize_team_name_columns() -> int:
        """Strip trailing match-state badges from team-name columns in
        ``match_event_summaries`` and ``bet_labels``. Returns the number of
        rows updated across both tables.
        """
        total = 0
        targets = (
            ("match_event_summaries", "event_id", "home_team", "away_team"),
            ("bet_labels", "event_id", "home_team", "away_team"),
        )
        with ml_db.connect() as conn:
            for table, pk, home_col, away_col in targets:
                # Skip tables that don't exist in this DB (defensive: bet_labels
                # is filled by phase1 and might be empty on a fresh install).
                exists = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                    (table,),
                ).fetchone()
                if not exists:
                    continue
                rows = conn.execute(
                    f"SELECT {pk}, {home_col}, {away_col} FROM {table} "
                    f"WHERE {home_col} IS NOT NULL OR {away_col} IS NOT NULL"
                ).fetchall()
                updates: list[tuple[str | None, str | None, str]] = []
                for row in rows:
                    home = row[home_col]
                    away = row[away_col]
                    new_home = (
                        RefreshNowManager._strip_trailing_badge(home) if home else home
                    )
                    new_away = (
                        RefreshNowManager._strip_trailing_badge(away) if away else away
                    )
                    if new_home != home or new_away != away:
                        updates.append((new_home, new_away, row[pk]))
                if updates:
                    conn.executemany(
                        f"UPDATE {table} SET {home_col} = ?, {away_col} = ? WHERE {pk} = ?",
                        updates,
                    )
                    conn.commit()
                    total += len(updates)
        if total > 0:
            logger.info("refresh_sanitized_team_names count=%d", total)
        return total

    @staticmethod
    def _unstamp_unparseable_terminal_rows() -> int:
        """Flip ``is_terminal=1 -> 0`` for stats snapshots whose payload has
        no usable Final score. Returns the number of rows flipped.

        Mirrors :meth:`SnapshotStore._has_final_score` but evaluated in
        Python against the stored JSON. Idempotent — re-running on a clean
        DB returns 0.
        """
        unstamped = 0
        with ml_db.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, event_id, match_stats_payload_json
                FROM match_stats_snapshots
                WHERE is_terminal = 1
                """
            ).fetchall()
            bad_ids: list[int] = []
            for row in rows:
                try:
                    payload = json.loads(row["match_stats_payload_json"])
                except (TypeError, ValueError):
                    bad_ids.append(row["id"])
                    continue
                event = (payload or {}).get("event") or {}
                if not RefreshNowManager._payload_has_final_score(event):
                    bad_ids.append(row["id"])
            if bad_ids:
                conn.executemany(
                    "UPDATE match_stats_snapshots SET is_terminal = 0 WHERE id = ?",
                    [(rid,) for rid in bad_ids],
                )
                conn.commit()
                unstamped = len(bad_ids)
        if unstamped > 0:
            logger.info("refresh_unstamped_unparseable count=%d", unstamped)
        return unstamped

    @staticmethod
    def _payload_has_final_score(event: dict[str, Any]) -> bool:
        for period in event.get("periods") or ():
            if (period.get("name") or "").strip().lower() != "match":
                continue
            for category in period.get("categories") or ():
                if (category.get("name") or "").strip().lower() != "score":
                    continue
                for stat in category.get("stats") or ():
                    label = (stat.get("label") or "").lower()
                    if "final score" not in label:
                        continue
                    try:
                        int(stat["home"])
                        int(stat["away"])
                        return True
                    except (KeyError, TypeError, ValueError):
                        return False
        return False

    async def _stage_settle(self, run: RefreshRun) -> None:
        run.status = "settle"
        run.stage_progress["settle"] = {"state": "running"}
        # settle_pending_bets is synchronous + relatively quick; run in thread
        # to avoid blocking the event loop.
        summary = await asyncio.to_thread(settle_pending_bets)
        result = {
            "pending_at_start": summary.pending_at_start,
            "settled": summary.settled,
            "voided": summary.voided,
            "skipped_no_label": summary.skipped_no_label,
            "skipped_no_closing_price": summary.skipped_no_closing_price,
        }
        run.stage_progress["settle"] = {"state": "done", **result}
        run.summary["settle"] = result

    async def _stage_predict(
        self, run: RefreshRun, hours_ahead: int, min_edge: float
    ) -> None:
        run.status = "predict"
        run.stage_progress["predict"] = {"state": "running"}
        result = await asyncio.to_thread(self._predict_sync, hours_ahead, min_edge)
        run.stage_progress["predict"] = {"state": "done", **result}
        run.summary["predict"] = result

    @staticmethod
    def _predict_sync(hours_ahead: int, min_edge: float) -> dict[str, int]:
        artifacts = load_models()
        upcoming = list_upcoming_events(hours_ahead=hours_ahead)
        now_iso = datetime.now(timezone.utc).isoformat()
        picks: list[PickInput] = []
        for fx in upcoming:
            records = predict_event(fx["event_id"], artifacts)
            for r in records:
                if r.edge is None or r.edge < min_edge:
                    continue
                if r.market_price is None:
                    continue
                picks.append(
                    PickInput(
                        event_id=fx["event_id"],
                        model=r.model,
                        market=r.market,
                        selection=r.selection,
                        bet_ts=now_iso,
                        price_at_recommendation=float(r.market_price),
                        model_prob=r.model_prob,
                        devigged_prob=r.market_devigged,
                        edge=r.edge,
                        kelly_full=r.kelly_full,
                    )
                )
        inserted = record_picks(picks)
        return {
            "upcoming_events": len(upcoming),
            "candidate_picks": len(picks),
            "newly_inserted": inserted,
            "duplicates_skipped": len(picks) - inserted,
        }
