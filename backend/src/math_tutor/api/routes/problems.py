"""
Problems API endpoints — synchronous wrapper that drains the harness
AgentLoop and returns one consolidated JSON payload. Kept for backward
compatibility (curl / scripts); the streaming UX lives at /api/v1/chat.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...config.dependencies import get_agent_loop
from ...domain.value_objects import EducationLevel
from ...infrastructure.agent import (
    AgentLoop,
    DoneEvent,
    ErrorEvent,
    SessionCreated,
    ToolCallResult,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class ProcessProblemRequest(BaseModel):
    problem: str
    grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER

    class Config:
        json_schema_extra = {
            "example": {
                "problem": "鸡兔同笼，头35脚94，各多少？",
                "grade": "elementary_upper",
            }
        }


class ProcessProblemResponse(BaseModel):
    status: str
    problem: str
    grade: str
    session_id: str | None = None
    analysis: dict[str, Any] | None = None
    solution: dict[str, Any] | None = None
    visualization_code: str | None = None
    video_path: str | None = None
    video_url: str | None = None
    error: str | None = None
    fallback_content: str | None = None


async def _run_collected(
    loop: AgentLoop,
    problem: str,
    grade: str,
) -> dict[str, Any]:
    session_id: str | None = None
    final_video_url: str | None = None
    final_video_path: str | None = None
    final_text = ""
    visualization_code: str | None = None
    analysis: dict[str, Any] | None = None
    error: str | None = None
    status = "failed"
    last_error_event: str | None = None

    async for evt in loop.run(problem=problem, grade=grade):
        if isinstance(evt, SessionCreated):
            session_id = evt.session_id
        elif isinstance(evt, ToolCallResult):
            if not evt.success:
                continue
            if evt.name == "analyze_problem" and evt.data:
                analysis = dict(evt.data)
            elif evt.name == "generate_manim_code" and evt.data:
                code = evt.data.get("code")
                if isinstance(code, str):
                    visualization_code = code
            elif evt.name == "run_manim" and evt.data:
                video_url = evt.data.get("video_url")
                video_path = evt.data.get("video_path")
                if isinstance(video_url, str):
                    final_video_url = video_url
                if isinstance(video_path, str):
                    final_video_path = video_path
        elif isinstance(evt, DoneEvent):
            status = "success" if evt.status == "ok" else evt.status
            final_text = evt.text or final_text
            final_video_url = evt.final_video_url or final_video_url
            final_video_path = evt.final_video_path or final_video_path
        elif isinstance(evt, ErrorEvent):
            last_error_event = evt.message
            if evt.fatal:
                status = "failed"

    if status != "success" and last_error_event and not error:
        error = last_error_event

    return {
        "session_id": session_id,
        "status": status,
        "analysis": analysis,
        "visualization_code": visualization_code,
        "video_url": final_video_url,
        "video_path": final_video_path,
        "fallback_content": final_text or None,
        "error": error,
    }


@router.post("/process", response_model=ProcessProblemResponse)
async def process_problem(
    request: ProcessProblemRequest,
    loop: AgentLoop = Depends(get_agent_loop),
) -> ProcessProblemResponse:
    """Run the harness agent and return one consolidated response.

    For real-time progress (recommended UX), use POST /api/v1/chat with SSE.
    """
    try:
        result = await _run_collected(loop, request.problem, request.grade.value)
    except Exception as exc:
        logger.exception("agent loop failed for /process")
        return ProcessProblemResponse(
            status="failed",
            problem=request.problem,
            grade=request.grade.value,
            error=str(exc),
        )

    return ProcessProblemResponse(
        status=result["status"],
        problem=request.problem,
        grade=request.grade.value,
        session_id=result["session_id"],
        analysis=result["analysis"],
        solution=None,
        visualization_code=result["visualization_code"],
        video_path=result["video_url"],
        video_url=result["video_url"],
        error=result["error"],
        fallback_content=result["fallback_content"],
    )
