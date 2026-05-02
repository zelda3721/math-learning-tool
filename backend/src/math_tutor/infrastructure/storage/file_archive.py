"""
Per-session filesystem archive.

Stores text artifacts (Manim source code, error logs, raw prompts) under
`{data_dir}/sessions/{session_id}/...`. Videos are not duplicated here —
they remain in the Manim media directory and only their relative path is
recorded as an artifact in SQLite.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)


class FileArchive:
    def __init__(self, data_dir: Path | str) -> None:
        self._root = Path(data_dir).expanduser().resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        logger.info("FileArchive root: %s", self._root)

    @property
    def root(self) -> Path:
        return self._root

    def session_dir(self, session_id: str) -> Path:
        return self._root / "sessions" / session_id

    def _save_text_sync(self, session_id: str, filename: str, content: str) -> Path:
        sdir = self.session_dir(session_id)
        sdir.mkdir(parents=True, exist_ok=True)
        path = sdir / filename
        path.write_text(content, encoding="utf-8")
        return path

    async def save_text(self, session_id: str, filename: str, content: str) -> Path:
        return await asyncio.to_thread(self._save_text_sync, session_id, filename, content)

    async def read_text(self, session_id: str, filename: str) -> str | None:
        def _read() -> str | None:
            path = self.session_dir(session_id) / filename
            if not path.exists():
                return None
            return path.read_text(encoding="utf-8")

        return await asyncio.to_thread(_read)

    async def read_relative(self, rel_path: str) -> str | None:
        """Read a file by its archive-root-relative path (the form stored in
        the artifacts table)."""

        def _read() -> str | None:
            path = self._root / rel_path
            if not path.exists():
                return None
            return path.read_text(encoding="utf-8")

        return await asyncio.to_thread(_read)

    async def delete_session_dir(self, session_id: str) -> bool:
        """Remove the per-session directory and all its contents. Idempotent
        — returns True if anything was deleted, False if it didn't exist."""

        def _rm() -> bool:
            path = self.session_dir(session_id)
            if not path.exists():
                return False
            shutil.rmtree(path, ignore_errors=True)
            return True

        return await asyncio.to_thread(_rm)
