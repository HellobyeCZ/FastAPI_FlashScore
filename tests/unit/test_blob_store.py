"""Tests for app.db.blob_store.LocalBlobStore."""
from __future__ import annotations

import gzip
from pathlib import Path

import pytest

from app.db.blob_store import LocalBlobStore


@pytest.fixture
def tmp_store(tmp_path: Path) -> LocalBlobStore:
    return LocalBlobStore(root=tmp_path)


async def test_put_then_get_roundtrips_bytes(tmp_store: LocalBlobStore) -> None:
    payload = b'{"hello": "world"}'
    url = await tmp_store.put(namespace="odds", key="abc123", payload=payload)
    assert url.startswith("file://")
    fetched = await tmp_store.get(url)
    assert fetched == payload


async def test_put_compresses_with_gzip(tmp_store: LocalBlobStore, tmp_path: Path) -> None:
    payload = b'{"k": "' + b"x" * 10000 + b'"}'
    url = await tmp_store.put(namespace="odds", key="big", payload=payload)
    on_disk = Path(url.removeprefix("file://"))
    assert on_disk.suffix == ".gz"
    assert on_disk.stat().st_size < len(payload)
    assert gzip.decompress(on_disk.read_bytes()) == payload


async def test_url_is_deterministic(tmp_store: LocalBlobStore) -> None:
    url1 = await tmp_store.put(namespace="odds", key="evt1", payload=b"a")
    url2 = await tmp_store.put(namespace="odds", key="evt1", payload=b"b")
    # Same namespace+key MUST produce the same URL (overwrite semantics).
    assert url1 == url2
