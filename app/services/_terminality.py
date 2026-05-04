"""Shared terminality logic for match snapshots.

A match is "terminal" when no further updates are expected — at that point
the bulk-scrape job can short-circuit and stop refetching it. The status
string alone is not enough: we've seen upstream payloads return
status='finished' for matches whose kickoff is still days in the future
(likely a default in their feed). To avoid prematurely sealing future
fixtures, we additionally require start_time_utc to be safely in the past.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

TERMINAL_MATCH_STATUSES: frozenset[str] = frozenset(
    {
        "finished",
        "abandoned",
        "cancelled",
        "awarded",
        "walkover",
        "forfeit",
    }
)

# Generous grace window: even after kickoff a match takes ~2h to finish, plus
# extra time / shootouts / late stat corrections. Anything older than this is
# safely past, anything newer is still potentially live.
_TERMINAL_GRACE = timedelta(hours=6)


def is_terminal_event(
    *, status: str | None, start_time_utc: datetime | None
) -> bool:
    """Return True only if the match is both finished AND in the past.

    Treats matches with future or unknown kickoff as non-terminal so they get
    re-scraped (which is what we want for fixtures we expect to update).
    """
    if (status or "").lower() not in TERMINAL_MATCH_STATUSES:
        return False
    if start_time_utc is None:
        return False
    now = datetime.now(timezone.utc)
    return start_time_utc + _TERMINAL_GRACE <= now
