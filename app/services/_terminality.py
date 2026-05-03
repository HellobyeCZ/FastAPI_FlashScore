"""Shared constant for which match statuses count as terminal.

Owned here (not in storage.py or snapshot_repo.py) so the legacy SnapshotStore
and the new SnapshotRepo can't drift during the Task-10-to-Task-13 overlap.
After Task 13 deletes storage.py, this module is the single source of truth.
"""
from __future__ import annotations

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
