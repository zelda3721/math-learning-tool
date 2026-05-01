"""
LLM Provider Interface — low-level streaming chat with native tool calling.

The single abstraction the harness agent loop and tool implementations use
to talk to any OpenAI-compatible LLM endpoint (LMStudio / vLLM / Ollama /
OpenAI / DeepSeek...).

Design borrowed from DispatchMind/src/brain/LLMProvider.ts: a single
`chat_stream` that yields a typed event stream so callers (the agent loop,
the SSE endpoint) can react to text, reasoning, and tool calls in real time.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal


Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class ToolCallSpec:
    """A tool call carried on an assistant message (already parsed)."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ChatMessage:
    """One message in the conversation history sent to the model.

    `content` may be either a plain string (text only) or a list of OpenAI-
    style content parts for multimodal inputs:
        [{"type": "text", "text": "..."},
         {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}]
    """

    role: Role
    content: str | list[dict[str, Any]] = ""
    tool_calls: list[ToolCallSpec] | None = None
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class ToolDefinition:
    """A tool exposed to the model. JSONSchema for parameters."""

    name: str
    description: str
    parameters: dict[str, Any]

    def to_openai_format(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class TextDelta:
    text: str


@dataclass
class ReasoningDelta:
    """Thinking/reasoning content (between <think> tags or via API field)."""

    text: str


@dataclass
class ToolCallEvent:
    """A fully-assembled tool call (emitted once arguments JSON is complete)."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class StreamDone:
    """Stream finished. Carries the accumulated final state."""

    finish_reason: str
    text: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCallEvent] = field(default_factory=list)


StreamEvent = TextDelta | ReasoningDelta | ToolCallEvent | StreamDone


class ILLMProvider(ABC):
    """OpenAI-compatible streaming chat provider."""

    @abstractmethod
    def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Stream a chat completion as typed events."""
        ...

    @abstractmethod
    async def chat_complete(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        **kwargs: Any,
    ) -> StreamDone:
        """Drain the stream and return the final summary event."""
        ...
