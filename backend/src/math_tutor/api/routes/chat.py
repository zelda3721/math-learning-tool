"""
Chat endpoint — runs the harness AgentLoop and streams events as SSE.

Event types:
  session       — { session_id }
  text          — { text }
  reasoning     — { text }
  tool_call     — { id, name, arguments, turn_index }
  tool_result   — { id, name, success, summary, data, error, duration_ms, artifacts }
  done          — { status, text, final_video_url, final_video_path }
  error         — { message, fatal }
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ...config.dependencies import get_agent_loop
from ...domain.value_objects import EducationLevel
from ...infrastructure.agent import (
    AgentLoop,
    DoneEvent,
    ErrorEvent,
    ReasoningChunk,
    SessionCreated,
    TextChunk,
    ToolCallResult,
    ToolCallStart,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    problem: str
    grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    session_id: str | None = None
    extra_directives: str | None = None


def _event_to_sse(event_type: str, payload: dict) -> str:
    """Format a single SSE message."""
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event_type}\ndata: {body}\n\n"


async def _stream_events(loop: AgentLoop, req: ChatRequest) -> AsyncIterator[str]:
    try:
        async for evt in loop.run(
            problem=req.problem,
            grade=req.grade.value,
            session_id=req.session_id,
            extra_directives=req.extra_directives,
        ):
            if isinstance(evt, SessionCreated):
                yield _event_to_sse("session", {"session_id": evt.session_id})
            elif isinstance(evt, TextChunk):
                yield _event_to_sse("text", {"text": evt.text})
            elif isinstance(evt, ReasoningChunk):
                yield _event_to_sse("reasoning", {"text": evt.text})
            elif isinstance(evt, ToolCallStart):
                yield _event_to_sse(
                    "tool_call",
                    {
                        "id": evt.id,
                        "name": evt.name,
                        "arguments": evt.arguments,
                        "turn_index": evt.turn_index,
                    },
                )
            elif isinstance(evt, ToolCallResult):
                yield _event_to_sse(
                    "tool_result",
                    {
                        "id": evt.id,
                        "name": evt.name,
                        "success": evt.success,
                        "summary": evt.summary,
                        "data": evt.data,
                        "error": evt.error,
                        "duration_ms": evt.duration_ms,
                        "artifacts": evt.artifacts,
                    },
                )
            elif isinstance(evt, DoneEvent):
                yield _event_to_sse(
                    "done",
                    {
                        "status": evt.status,
                        "text": evt.text,
                        "final_video_url": evt.final_video_url,
                        "final_video_path": evt.final_video_path,
                    },
                )
            elif isinstance(evt, ErrorEvent):
                yield _event_to_sse(
                    "error",
                    {"message": evt.message, "fatal": evt.fatal},
                )
            else:
                logger.warning("unknown agent event type: %s", type(evt).__name__)
                yield _event_to_sse("error", {"message": "unknown event type", "fatal": False})
    except Exception as exc:
        logger.exception("agent loop crashed inside stream")
        yield _event_to_sse(
            "error", {"message": f"agent loop crashed: {exc}", "fatal": True}
        )


@router.post("")
async def chat(
    req: ChatRequest,
    loop: AgentLoop = Depends(get_agent_loop),
) -> StreamingResponse:
    """Stream a math-tutor agent run as Server-Sent Events.

    Frontend is expected to consume this with the EventSource API or a
    fetch+ReadableStream pipeline.
    """
    return StreamingResponse(
        _stream_events(loop, req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering if present
        },
    )
