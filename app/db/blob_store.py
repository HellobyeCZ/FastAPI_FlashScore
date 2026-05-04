"""Content-addressed blob storage. Local filesystem implementation."""
from __future__ import annotations

import asyncio
import gzip
from pathlib import Path
from typing import Protocol


class BlobStore(Protocol):
    async def put(self, *, namespace: str, key: str, payload: bytes) -> str: ...
    async def get(self, url: str) -> bytes: ...


class LocalBlobStore:
    """Stores gzipped blobs under {root}/{namespace}/{key}.json.gz.

    Returns `file://` URLs. The same (namespace, key) pair always produces
    the same URL — `put` overwrites.
    """

    def __init__(self, root: Path) -> None:
        self._root = root

    async def put(self, *, namespace: str, key: str, payload: bytes) -> str:
        return await asyncio.to_thread(self._put_sync, namespace, key, payload)

    async def get(self, url: str) -> bytes:
        return await asyncio.to_thread(self._get_sync, url)

    def _put_sync(self, namespace: str, key: str, payload: bytes) -> str:
        target = self._root / namespace / f"{key}.json.gz"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.compress(payload))
        return f"file://{target.resolve()}"

    def _get_sync(self, url: str) -> bytes:
        path = Path(url.removeprefix("file://"))
        return gzip.decompress(path.read_bytes())
