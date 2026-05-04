from __future__ import annotations

import pytest


@pytest.mark.skip(reason="Requires running Redis + Postgres; promote to CI later.")
async def test_create_job_enqueues_to_arq() -> None:
    pass
