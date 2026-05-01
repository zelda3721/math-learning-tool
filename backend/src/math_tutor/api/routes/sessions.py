"""
Sessions API — list and inspect persisted conversations, attach feedback.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...config.dependencies import get_conversation_store, get_examples_store
from ...infrastructure.storage import (
    Artifact,
    ConversationStore,
    ExamplesStore,
    Feedback,
    Message,
    Session,
    ToolCallRecord,
)

router = APIRouter()


class FeedbackRequest(BaseModel):
    label: str = Field(..., description="good / bad / neutral")
    notes: str = ""
    artifact_id: int | None = None


class ExampleRequest(BaseModel):
    label: str = Field(..., description="good / bad")
    tags: list[str] = Field(default_factory=list)
    notes: str = ""


def _session_to_dict(s: Session) -> dict[str, Any]:
    return {
        "id": s.id,
        "problem": s.problem,
        "grade": s.grade,
        "status": s.status,
        "created_at": s.created_at.isoformat(),
        "updated_at": s.updated_at.isoformat(),
        "final_video_path": s.final_video_path,
        "error": s.error,
        "meta": s.meta,
    }


def _message_to_dict(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "session_id": m.session_id,
        "turn_index": m.turn_index,
        "role": m.role,
        "content": m.content,
        "reasoning": m.reasoning,
        "tool_calls": m.tool_calls,
        "tool_call_id": m.tool_call_id,
        "tool_name": m.tool_name,
        "created_at": m.created_at.isoformat(),
    }


def _tool_call_to_dict(t: ToolCallRecord) -> dict[str, Any]:
    return {
        "id": t.id,
        "session_id": t.session_id,
        "turn_index": t.turn_index,
        "name": t.name,
        "arguments": t.arguments,
        "status": t.status,
        "result_summary": t.result_summary,
        "result_path": t.result_path,
        "duration_ms": t.duration_ms,
        "error": t.error,
        "created_at": t.created_at.isoformat(),
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
    }


def _artifact_to_dict(a: Artifact) -> dict[str, Any]:
    return {
        "id": a.id,
        "session_id": a.session_id,
        "kind": a.kind,
        "path": a.path,
        "meta": a.meta,
        "created_at": a.created_at.isoformat(),
    }


def _feedback_to_dict(f: Feedback) -> dict[str, Any]:
    return {
        "id": f.id,
        "session_id": f.session_id,
        "artifact_id": f.artifact_id,
        "label": f.label,
        "notes": f.notes,
        "created_at": f.created_at.isoformat(),
    }


@router.get("")
async def list_sessions(
    limit: int = 50,
    offset: int = 0,
    label: str | None = None,
    store: ConversationStore = Depends(get_conversation_store),
) -> list[dict[str, Any]]:
    sessions = await store.list_sessions(limit=limit, offset=offset, label=label)
    return [_session_to_dict(s) for s in sessions]


@router.get("/{session_id}")
async def get_session_detail(
    session_id: str,
    store: ConversationStore = Depends(get_conversation_store),
) -> dict[str, Any]:
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    messages = await store.list_messages(session_id)
    tool_calls = await store.list_tool_calls(session_id)
    artifacts = await store.list_artifacts(session_id)
    feedback = await store.list_feedback(session_id)
    return {
        "session": _session_to_dict(session),
        "messages": [_message_to_dict(m) for m in messages],
        "tool_calls": [_tool_call_to_dict(t) for t in tool_calls],
        "artifacts": [_artifact_to_dict(a) for a in artifacts],
        "feedback": [_feedback_to_dict(f) for f in feedback],
    }


@router.post("/{session_id}/feedback")
async def add_feedback(
    session_id: str,
    body: FeedbackRequest,
    store: ConversationStore = Depends(get_conversation_store),
) -> dict[str, Any]:
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        fb_id = await store.add_feedback(
            session_id=session_id,
            label=body.label,
            notes=body.notes,
            artifact_id=body.artifact_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": fb_id}


@router.post("/{session_id}/promote_example")
async def promote_to_example(
    session_id: str,
    body: ExampleRequest,
    store: ConversationStore = Depends(get_conversation_store),
    examples: ExamplesStore = Depends(get_examples_store),
) -> dict[str, Any]:
    """Copy this session's manim_code into the examples store for few-shot use."""
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    if body.label not in ("good", "bad"):
        raise HTTPException(status_code=400, detail="label must be good or bad")

    artifacts = await store.list_artifacts(session_id)
    # There may be multiple manim_code artifacts when generate retried.
    # Walk newest → oldest and return the first whose file actually exists.
    manim_artifacts = [a for a in artifacts if a.kind == "manim_code"]
    if not manim_artifacts:
        raise HTTPException(status_code=400, detail="session has no manim_code artifact")

    code: str | None = None
    code_artifact = None
    tried: list[str] = []
    for candidate in reversed(manim_artifacts):
        # 1) the path stored in the artifact row
        path_candidates = [candidate.path]
        # 2) just the filename under the session dir (handles archive-root drift)
        leaf = Path(candidate.path).name
        path_candidates.append(f"sessions/{session_id}/{leaf}")
        # 3) legacy "solution.py" location used by the old /process route
        path_candidates.append(f"sessions/{session_id}/solution.py")

        for p in path_candidates:
            tried.append(p)
            data = await store.archive.read_relative(p)
            if data:
                code = data
                code_artifact = candidate
                break
        if code is not None:
            break

    if code is None or code_artifact is None:
        # List what's actually in the session dir so the user can see the mismatch
        session_dir = store.archive.session_dir(session_id)
        on_disk = (
            sorted(p.name for p in session_dir.iterdir()) if session_dir.exists() else []
        )
        raise HTTPException(
            status_code=400,
            detail=(
                "manim_code artifact missing on disk. "
                f"Tried paths: {tried}. Files actually in session dir: {on_disk}"
            ),
        )

    example_id = await examples.add_example(
        problem=session.problem,
        grade=session.grade,
        manim_code=code,
        label=body.label,
        session_id=session.id,
        video_path=session.final_video_path,
        tags=body.tags,
        notes=body.notes,
    )
    return {"id": example_id}
