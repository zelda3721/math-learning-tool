"""Plain data records for the storage layer (not domain entities)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class Session:
    id: str
    problem: str
    grade: str
    status: str
    created_at: datetime
    updated_at: datetime
    final_video_path: str | None = None
    error: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Message:
    id: int
    session_id: str
    turn_index: int
    role: str
    content: str
    created_at: datetime
    reasoning: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None


@dataclass
class ToolCallRecord:
    id: str
    session_id: str
    turn_index: int
    name: str
    arguments: dict[str, Any]
    status: str
    created_at: datetime
    result_summary: str | None = None
    result_path: str | None = None
    duration_ms: int | None = None
    error: str | None = None
    completed_at: datetime | None = None


@dataclass
class Artifact:
    id: int
    session_id: str
    kind: str
    path: str
    created_at: datetime
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Feedback:
    id: int
    session_id: str
    label: str
    notes: str
    created_at: datetime
    artifact_id: int | None = None


@dataclass
class Example:
    id: int
    problem: str
    grade: str
    manim_code: str
    label: str
    created_at: datetime
    session_id: str | None = None
    video_path: str | None = None
    tags: list[str] = field(default_factory=list)
    notes: str = ""
