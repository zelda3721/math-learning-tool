"""
SQLite database connection + schema migration.

Sync helpers wrapped in `asyncio.to_thread` from the async stores. SQLite
calls are fast enough for this workload (single-user math tutor) that a
fresh connection per query is fine; we don't need a pool.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

logger = logging.getLogger(__name__)


_SCHEMA_STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        problem          TEXT NOT NULL,
        grade            TEXT NOT NULL,
        status           TEXT NOT NULL,
        final_video_path TEXT,
        error            TEXT,
        meta_json        TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        turn_index      INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        reasoning       TEXT,
        tool_calls_json TEXT,
        tool_call_id    TEXT,
        tool_name       TEXT,
        created_at      TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)",
    """
    CREATE TABLE IF NOT EXISTS tool_calls (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        turn_index      INTEGER NOT NULL,
        name            TEXT NOT NULL,
        arguments_json  TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        result_summary  TEXT,
        result_path     TEXT,
        duration_ms     INTEGER,
        error           TEXT,
        created_at      TEXT NOT NULL,
        completed_at    TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)",
    """
    CREATE TABLE IF NOT EXISTS artifacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        path        TEXT NOT NULL,
        meta_json   TEXT,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)",
    """
    CREATE TABLE IF NOT EXISTS feedback (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        artifact_id INTEGER,
        label       TEXT NOT NULL,
        notes       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_feedback_label ON feedback(label)",
    """
    CREATE TABLE IF NOT EXISTS examples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT,
        problem     TEXT NOT NULL,
        grade       TEXT NOT NULL,
        manim_code  TEXT NOT NULL,
        video_path  TEXT,
        label       TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_examples_label ON examples(label)",
    "CREATE INDEX IF NOT EXISTS idx_examples_grade ON examples(grade)",
)


class Database:
    """Thin wrapper around stdlib sqlite3 with async-friendly helpers."""

    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        logger.info("SQLite database ready at %s", self._path)

    @property
    def path(self) -> Path:
        return self._path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self._path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            yield conn
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self.connect() as conn:
            for stmt in _SCHEMA_STATEMENTS:
                conn.execute(stmt)

    # --- Sync helpers (callable from to_thread) ----------------------------

    def execute_sync(self, sql: str, params: Sequence[Any] = ()) -> int:
        with self.connect() as conn:
            cur = conn.execute(sql, tuple(params))
            return int(cur.lastrowid or cur.rowcount or 0)

    def execute_many_sync(self, sql: str, seq: Sequence[Sequence[Any]]) -> None:
        with self.connect() as conn:
            conn.executemany(sql, [tuple(row) for row in seq])

    def fetch_one_sync(
        self, sql: str, params: Sequence[Any] = ()
    ) -> dict[str, Any] | None:
        with self.connect() as conn:
            cur = conn.execute(sql, tuple(params))
            row = cur.fetchone()
            return dict(row) if row is not None else None

    def fetch_all_sync(
        self, sql: str, params: Sequence[Any] = ()
    ) -> list[dict[str, Any]]:
        with self.connect() as conn:
            cur = conn.execute(sql, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    # --- Async wrappers ----------------------------------------------------

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        return await asyncio.to_thread(self.execute_sync, sql, params)

    async def execute_many(self, sql: str, seq: Sequence[Sequence[Any]]) -> None:
        await asyncio.to_thread(self.execute_many_sync, sql, seq)

    async def fetch_one(
        self, sql: str, params: Sequence[Any] = ()
    ) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.fetch_one_sync, sql, params)

    async def fetch_all(
        self, sql: str, params: Sequence[Any] = ()
    ) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.fetch_all_sync, sql, params)
