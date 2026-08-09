"""
Engine contract endpoint — GET /api/v1/contract.

The TS gateway (apps/server) fetches this once at startup and validates it
against packages/schema/src/contract.ts (EngineContractSchema). Field names
here must stay aligned with that zod schema:

    { contract_version, tools: [{name, label_zh, stage, palette}],
      event_types, artifact_url_base }

Tool NAMES are derived programmatically from the production ToolRegistry
(build_default_registry) — never a second hand-written list — so a tool
added or removed from the registry is reflected here automatically.
label_zh / stage / palette mirror the semantics the web timeline already
uses (apps/web AgentTimeline.tsx toolLabel / toolPalette).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ...config.dependencies import get_tool_registry
from ...infrastructure.agent import ToolRegistry

router = APIRouter()

# Must match the "quality_contract" tag the AgentLoop stamps on sessions.
CONTRACT_VERSION = "open_world_v4"

# Wire names of the 7 event dataclasses in infrastructure/agent/events.py,
# exactly as the chat SSE endpoint emits them (see api/routes/chat.py):
#   SessionCreated → session, TextChunk → text, ReasoningChunk → reasoning,
#   ToolCallStart → tool_call, ToolCallResult → tool_result,
#   DoneEvent → done, ErrorEvent → error
EVENT_TYPES: tuple[str, ...] = (
    "session",
    "text",
    "reasoning",
    "tool_call",
    "tool_result",
    "done",
    "error",
)

ARTIFACT_URL_BASE = "/api/v1/media"

# Display metadata keyed by registry tool name. Labels are the exact strings
# the web timeline shows; palette is the tailwind hue family the timeline
# uses for that stage (verify shares teal with the "check" semantics).
_TOOL_DISPLAY: dict[str, dict[str, str]] = {
    "solve_problem": {
        "label_zh": "Solve · 理解与求解",
        "stage": "solve",
        "palette": "indigo",
    },
    "verify_solution": {
        "label_zh": "Verify · 独立验算",
        "stage": "verify",
        "palette": "teal",
    },
    "direct_video": {
        "label_zh": "Direct · 视觉导演",
        "stage": "direct",
        "palette": "sky",
    },
    "compile_video": {
        "label_zh": "Compile · 编译成片",
        "stage": "compile",
        "palette": "violet",
    },
    "watch_video": {
        "label_zh": "Watch · 成片审查",
        "stage": "watch",
        "palette": "emerald",
    },
}

# Fallback for tools present in the registry but not yet given display
# metadata — mirrors the timeline's default branch (slate + raw name).
_DEFAULT_DISPLAY = {"stage": "unknown", "palette": "slate"}


def build_contract(registry: ToolRegistry) -> dict[str, Any]:
    tools: list[dict[str, str]] = []
    for name in registry.names():
        display = _TOOL_DISPLAY.get(name)
        if display is None:
            display = {"label_zh": name, **_DEFAULT_DISPLAY}
        tools.append({"name": name, **display})
    return {
        "contract_version": CONTRACT_VERSION,
        "tools": tools,
        "event_types": list(EVENT_TYPES),
        "artifact_url_base": ARTIFACT_URL_BASE,
    }


@router.get("")
async def get_contract(
    registry: ToolRegistry = Depends(get_tool_registry),
) -> dict[str, Any]:
    """Engine capability contract for the TS gateway / web frontend."""
    return build_contract(registry)
