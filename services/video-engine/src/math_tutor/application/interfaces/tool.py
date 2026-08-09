"""
Tool interface for the harness agent loop.

Tools are stateless functions that the LLM may call. Long-lived dependencies
(LLM provider, skill repository, Manim executor) are injected in the tool's
constructor; per-call state arrives via `ToolContext`.

Artifacts (generated code, videos) are reported back through `ToolResult`
and persisted by the AgentLoop — tools never write directly to the store.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .llm_provider import ToolDefinition


@dataclass
class ToolContext:
    """Per-call context. Mutable `state` is shared across a session's turns."""

    session_id: str
    turn_index: int
    grade: str
    problem: str
    state: dict[str, Any] = field(default_factory=dict)


@dataclass
class ArtifactSpec:
    """A side-effect artifact produced by a tool, persisted by the loop."""

    kind: str  # 'manim_code' / 'video' / 'log' / ...
    meta: dict[str, Any] = field(default_factory=dict)
    # text payload (saved into FileArchive)
    filename: str | None = None
    content: str | None = None
    # OR an existing file path on disk (e.g. Manim mp4 in ./media)
    external_path: str | None = None


@dataclass
class ToolResult:
    """Outcome of a tool call.

    `summary` is short Chinese text the model reads; `data` carries
    structured payload that goes back to the LLM as JSON in the tool message.
    """

    success: bool
    summary: str
    data: dict[str, Any] | None = None
    artifacts: list[ArtifactSpec] = field(default_factory=list)
    error: str | None = None


class ITool(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def description(self) -> str: ...

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """JSONSchema describing the input."""
        ...

    def to_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
        )

    @abstractmethod
    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult: ...
