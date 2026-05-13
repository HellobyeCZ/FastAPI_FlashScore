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

from app.ml.paper_trade import PickInput, record_picks, settle_pending_bets
from app.ml.serving import list_upcoming_events, load_models, predict_event
from app.services.bulk_scrape import (
    LiveOddsScheduler,
    LiveOddsSchedulerConfig,
)
from app.services.odds_client import build_odds_client
from app.services.storage import build_snapshot_store

logger = logging.getLogger(__name__)

Stage = Literal["queued", "scrape", "settle", "predict", "done", "error"]


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
