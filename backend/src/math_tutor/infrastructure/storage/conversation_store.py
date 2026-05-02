"""
ConversationStore — async API for sessions, messages, tool calls, artifacts,
and feedback. Backed by SQLite (Database) plus a filesystem archive
(FileArchive) for large text payloads.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from .database import Database
from .file_archive import FileArchive
from .models import Artifact, Feedback, Message, Session, ToolCallRecord

logger = logging.getLogger(__name__)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _loads_or_none(s: str | None) -> Any:
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


class ConversationStore:
    def __init__(self, db: Database, archive: FileArchive) -> None:
        self._db = db
        self._archive = archive

    @property
    def archive(self) -> FileArchive:
        return self._archive

    # --- sessions ---------------------------------------------------------

    async def create_session(
        self,
        problem: str,
        grade: str,
        *,
        meta: dict[str, Any] | None = None,
    ) -> str:
        session_id = str(uuid.uuid4())
        now = _utcnow_iso()
        await self._db.execute(
            """
            INSERT INTO sessions
                (id, created_at, updated_at, problem, grade, status, meta_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                now,
                now,
                problem,
                grade,
                "running",
                json.dumps(meta or {}, ensure_ascii=False),
            ),
        )
        return session_id

    async def update_session(
        self,
        session_id: str,
        *,
        status: str | None = None,
        final_video_path: str | None = None,
        error: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        sets: list[str] = ["updated_at = ?"]
        params: list[Any] = [_utcnow_iso()]
        if status is not None:
            sets.append("status = ?")
            params.append(status)
        if final_video_path is not None:
            sets.append("final_video_path = ?")
            params.append(final_video_path)
        if error is not None:
            sets.append("error = ?")
            params.append(error)
        if meta is not None:
            sets.append("meta_json = ?")
            params.append(json.dumps(meta, ensure_ascii=False))
        params.append(session_id)
        await self._db.execute(
            f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?",
            params,
        )

    async def get_session(self, session_id: str) -> Session | None:
        row = await self._db.fetch_one(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        )
        if row is None:
            return None
        return self._row_to_session(row)

    async def list_sessions(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        label: str | None = None,
    ) -> list[Session]:
        if label is None:
            rows = await self._db.fetch_all(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        else:
            rows = await self._db.fetch_all(
                """
                SELECT s.* FROM sessions s
                JOIN feedback f ON f.session_id = s.id
                WHERE f.label = ?
                GROUP BY s.id
                ORDER BY s.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (label, limit, offset),
            )
        return [self._row_to_session(r) for r in rows]

    async def delete_session(self, session_id: str) -> None:
        await self._db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    async def delete_session_with_files(
        self, session_id: str, *, drop_videos: bool = True
    ) -> dict[str, Any]:
        """Hard-delete a session: SQLite row (CASCADE → messages/tool_calls/
        artifacts/feedback) + the per-session text archive directory + (opt)
        the rendered video files referenced by artifacts.

        Returns a summary dict for the API response.
        """
        # 1. Pull artifacts before we wipe the row, so we know which video
        #    files to remove. Artifacts are CASCADE-deleted with the session.
        artifacts = await self.list_artifacts(session_id)
        session = await self.get_session(session_id)
        if session is None:
            return {"deleted": False, "reason": "session_not_found"}

        videos_removed: list[str] = []
        if drop_videos:
            import shutil as _sh
            from pathlib import Path as _Path

            # Candidate paths: artifacts table (kind='video'), and the
            # session row's final_video_path.
            video_paths = {
                a.path for a in artifacts if a.kind == "video" and a.path
            }
            if session.final_video_path:
                video_paths.add(session.final_video_path)

            for vp in video_paths:
                p = _Path(vp)
                if not p.is_absolute():
                    # final_video_path is typically Manim-relative
                    # (e.g. "media/videos/SolutionScene/480p15/SolutionScene.mp4")
                    # or just a filename. Best-effort resolve from CWD.
                    p = _Path.cwd() / vp
                if p.exists() and p.is_file():
                    try:
                        p.unlink()
                        videos_removed.append(str(p))
                    except OSError:
                        logger.warning("could not delete video %s", p)

        # 2. SQLite row (FK CASCADE handles related tables)
        await self.delete_session(session_id)

        # 3. Per-session text archive directory
        archive_removed = await self._archive.delete_session_dir(session_id)

        return {
            "deleted": True,
            "session_id": session_id,
            "archive_dir_removed": archive_removed,
            "videos_removed_count": len(videos_removed),
            "artifacts_count": len(artifacts),
        }

    # --- messages ---------------------------------------------------------

    async def append_message(
        self,
        session_id: str,
        turn_index: int,
        role: str,
        content: str,
        *,
        reasoning: str | None = None,
        tool_calls: list[dict[str, Any]] | None = None,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
    ) -> int:
        return await self._db.execute(
            """
            INSERT INTO messages
                (session_id, turn_index, role, content, reasoning,
                 tool_calls_json, tool_call_id, tool_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                turn_index,
                role,
                content,
                reasoning,
                json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None,
                tool_call_id,
                tool_name,
                _utcnow_iso(),
            ),
        )

    async def list_messages(self, session_id: str) -> list[Message]:
        rows = await self._db.fetch_all(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )
        return [self._row_to_message(r) for r in rows]

    # --- tool calls -------------------------------------------------------

    async def record_tool_call(
        self,
        session_id: str,
        turn_index: int,
        tool_call_id: str,
        name: str,
        arguments: dict[str, Any],
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO tool_calls
                (id, session_id, turn_index, name, arguments_json,
                 status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                tool_call_id,
                session_id,
                turn_index,
                name,
                json.dumps(arguments, ensure_ascii=False),
                _utcnow_iso(),
            ),
        )

    async def complete_tool_call(
        self,
        tool_call_id: str,
        *,
        status: str,
        result_summary: str | None = None,
        result_path: str | None = None,
        duration_ms: int | None = None,
        error: str | None = None,
    ) -> None:
        await self._db.execute(
            """
            UPDATE tool_calls SET
                status = ?,
                result_summary = ?,
                result_path = ?,
                duration_ms = ?,
                error = ?,
                completed_at = ?
            WHERE id = ?
            """,
            (
                status,
                result_summary,
                result_path,
                duration_ms,
                error,
                _utcnow_iso(),
                tool_call_id,
            ),
        )

    async def list_tool_calls(self, session_id: str) -> list[ToolCallRecord]:
        rows = await self._db.fetch_all(
            "SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
        )
        return [self._row_to_tool_call(r) for r in rows]

    # --- artifacts --------------------------------------------------------

    async def add_artifact(
        self,
        session_id: str,
        kind: str,
        path: str,
        meta: dict[str, Any] | None = None,
    ) -> int:
        return await self._db.execute(
            """
            INSERT INTO artifacts (session_id, kind, path, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                path,
                json.dumps(meta or {}, ensure_ascii=False),
                _utcnow_iso(),
            ),
        )

    async def save_text_artifact(
        self,
        session_id: str,
        kind: str,
        filename: str,
        content: str,
        meta: dict[str, Any] | None = None,
    ) -> tuple[int, str]:
        """Write text content to the file archive and record an artifact row.

        Returns (artifact_id, relative_path).
        """
        path = await self._archive.save_text(session_id, filename, content)
        # Store the path relative to the archive root for portability.
        try:
            rel = path.relative_to(self._archive.root).as_posix()
        except ValueError:
            rel = str(path)
        artifact_id = await self.add_artifact(session_id, kind, rel, meta)
        return artifact_id, rel

    async def list_artifacts(self, session_id: str) -> list[Artifact]:
        rows = await self._db.fetch_all(
            "SELECT * FROM artifacts WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )
        return [self._row_to_artifact(r) for r in rows]

    # --- feedback ---------------------------------------------------------

    async def add_feedback(
        self,
        session_id: str,
        label: str,
        notes: str = "",
        artifact_id: int | None = None,
    ) -> int:
        if label not in ("good", "bad", "neutral"):
            raise ValueError(f"invalid feedback label: {label!r}")
        return await self._db.execute(
            """
            INSERT INTO feedback (session_id, artifact_id, label, notes, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, artifact_id, label, notes, _utcnow_iso()),
        )

    async def list_feedback(self, session_id: str) -> list[Feedback]:
        rows = await self._db.fetch_all(
            "SELECT * FROM feedback WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )
        return [self._row_to_feedback(r) for r in rows]

    # --- row mappers ------------------------------------------------------

    @staticmethod
    def _row_to_session(row: dict[str, Any]) -> Session:
        return Session(
            id=row["id"],
            problem=row["problem"],
            grade=row["grade"],
            status=row["status"],
            created_at=_parse_iso(row["created_at"]),
            updated_at=_parse_iso(row["updated_at"]),
            final_video_path=row.get("final_video_path"),
            error=row.get("error"),
            meta=_loads_or_none(row.get("meta_json")) or {},
        )

    @staticmethod
    def _row_to_message(row: dict[str, Any]) -> Message:
        return Message(
            id=int(row["id"]),
            session_id=row["session_id"],
            turn_index=int(row["turn_index"]),
            role=row["role"],
            content=row["content"],
            created_at=_parse_iso(row["created_at"]),
            reasoning=row.get("reasoning"),
            tool_calls=_loads_or_none(row.get("tool_calls_json")),
            tool_call_id=row.get("tool_call_id"),
            tool_name=row.get("tool_name"),
        )

    @staticmethod
    def _row_to_tool_call(row: dict[str, Any]) -> ToolCallRecord:
        return ToolCallRecord(
            id=row["id"],
            session_id=row["session_id"],
            turn_index=int(row["turn_index"]),
            name=row["name"],
            arguments=_loads_or_none(row["arguments_json"]) or {},
            status=row["status"],
            created_at=_parse_iso(row["created_at"]),
            result_summary=row.get("result_summary"),
            result_path=row.get("result_path"),
            duration_ms=row.get("duration_ms"),
            error=row.get("error"),
            completed_at=_parse_iso(row["completed_at"]) if row.get("completed_at") else None,
        )

    @staticmethod
    def _row_to_artifact(row: dict[str, Any]) -> Artifact:
        return Artifact(
            id=int(row["id"]),
            session_id=row["session_id"],
            kind=row["kind"],
            path=row["path"],
            created_at=_parse_iso(row["created_at"]),
            meta=_loads_or_none(row.get("meta_json")) or {},
        )

    @staticmethod
    def _row_to_feedback(row: dict[str, Any]) -> Feedback:
        return Feedback(
            id=int(row["id"]),
            session_id=row["session_id"],
            label=row["label"],
            notes=row.get("notes") or "",
            created_at=_parse_iso(row["created_at"]),
            artifact_id=row.get("artifact_id"),
        )
