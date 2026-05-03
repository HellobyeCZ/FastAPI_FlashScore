"""Shared diagnostic helper for golden-file tests.

`assert actual == expected` on deeply nested dicts produces unreadable failure
output (truncated reprs, no path info). `assert_golden_match` runs the same
equality check but, on failure, attaches a `deepdiff` summary listing exactly
which paths and values changed.
"""
from __future__ import annotations

from typing import Any

from deepdiff import DeepDiff


def assert_golden_match(actual: Any, expected: Any) -> None:
    """Compare two payloads; on mismatch, raise AssertionError with a deepdiff path summary."""
    if actual == expected:
        return
    diff = DeepDiff(expected, actual, view="tree", verbose_level=2)
    raise AssertionError(f"Golden mismatch:\n{diff.pretty()}")
