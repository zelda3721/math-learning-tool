"""Typed events the AgentLoop yields to the SSE endpoint and any consumers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SessionCreated:
    session_id: str


@dataclass
class TextChunk:
    text: str


@dataclass
class ReasoningChunk:
    text: str


@dataclass
class ToolCallStart:
    id: str
    name: str
    arguments: dict[str, Any]
    turn_index: int


@dataclass
class ToolCallResult:
    id: str
    name: str
    success: bool
    summary: str
    data: dict[str, Any] | None = None
    error: str | None = None
    duration_ms: int | None = None
    artifacts: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DoneEvent:
    status: str  # 'ok' / 'exhausted' / 'failed'
    text: str = ""
    final_video_url: str | None = None
    final_video_path: str | None = None


@dataclass
class ErrorEvent:
    message: str
    fatal: bool = False


AgentEvent = (
    SessionCreated
    | TextChunk
    | ReasoningChunk
    | ToolCallStart
    | ToolCallResult
    | DoneEvent
    | ErrorEvent
)
