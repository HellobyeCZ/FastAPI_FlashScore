"""Bulk-scrape endpoints — stubs returning 503 until Task 14 lands Arq.

The pre-Task-13 implementation lived in src.py + app/services/bulk_scrape.py
and ran scraping work in-process via a `BulkScrapeManager`. Task 14 will
re-implement the same surface on top of Arq workers; until then we keep the
HTTP shape but return 503 so callers fail fast and clearly.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/bulk-scrape", tags=["bulk-scrape"])

_MIGRATING_DETAIL = "Bulk scrape is being migrated to Arq. See Task 14."


@router.post("/jobs")
async def create_bulk_scrape_job() -> None:
    raise HTTPException(status_code=503, detail=_MIGRATING_DETAIL)


@router.get("/jobs")
async def list_bulk_scrape_jobs() -> None:
    raise HTTPException(status_code=503, detail=_MIGRATING_DETAIL)


@router.get("/jobs/{job_id}")
async def get_bulk_scrape_job(job_id: int) -> None:
    raise HTTPException(status_code=503, detail=_MIGRATING_DETAIL)
