"""Plan-only endpoint — POST /api/v1/plan (engine invasion #4, design §05).

Runs Solve → Verify → Direct and returns the SceneSpec (Visual IR) WITHOUT
entering Compile/Watch. This feeds Mode A (Web dynamic explanation): the TS
explainer-web player renders the spec in any webview — no ffmpeg / Manim /
LaTeX involved. Mode B (Manim video) keeps using POST /chat unchanged.

Stateless by design: no session persistence, no media output. The returned
plan_id is an opaque correlation id for the caller's own bookkeeping.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...application.interfaces.tool import ToolContext
from ...config.dependencies import get_settings, get_tool_registry
from ...config.settings import Settings
from ...domain.value_objects.grade import EducationLevel
from ...infrastructure.agent import ToolRegistry

logger = logging.getLogger(__name__)

router = APIRouter()


class PlanRequest(BaseModel):
    problem: str
    grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    learner_id: str | None = None
    extra_directives: str | None = None


class PlanResponse(BaseModel):
    status: str  # 'ok' | 'failed'
    plan_id: str
    scene_spec: dict[str, Any] | None = None
    solution_answer: str | None = None
    solution_steps: list[dict[str, Any]] | None = None
    error: str | None = None


@router.post("", response_model=PlanResponse)
@router.post("/", response_model=PlanResponse, include_in_schema=False)
async def plan_only(
    req: PlanRequest,
    registry: ToolRegistry = Depends(get_tool_registry),
    settings: Settings = Depends(get_settings),
) -> PlanResponse:
    plan_id = f"plan-{uuid.uuid4().hex[:12]}"
    state: dict[str, Any] = {"extra_directives": req.extra_directives or ""}

    async def run(tool_name: str, turn: int) -> tuple[bool, str | None]:
        tool = registry.get(tool_name)
        ctx = ToolContext(
            session_id=plan_id,
            turn_index=turn,
            grade=req.grade.value,
            problem=req.problem,
            state=state,
        )
        try:
            result = await tool.execute({}, ctx)
        except Exception as exc:  # noqa: BLE001 — surface as clean failure
            logger.exception("plan-only %s failed", tool_name)
            return False, f"{tool_name}: {exc}"
        if not result.success:
            return False, f"{tool_name}: {result.error or result.summary or 'failed'}"
        return True, None

    # Solve → Verify → Direct（与五阶段前三段同构；verify 失败不阻断——
    # direct 会依据 solution_verified 自行选择保守路径，讲解仍可产出）
    ok, error = await run("solve_problem", 1)
    if not ok:
        return PlanResponse(status="failed", plan_id=plan_id, error=error)
    verified, verify_error = await run("verify_solution", 2)
    if not verified:
        logger.warning("plan-only verify failed (continuing): %s", verify_error)
    ok, error = await run("direct_video", 3)
    if not ok:
        return PlanResponse(status="failed", plan_id=plan_id, error=error)

    spec = state.get("visual_plan")
    if not isinstance(spec, dict):
        return PlanResponse(status="failed", plan_id=plan_id, error="direct produced no visual_plan")
    return PlanResponse(
        status="ok",
        plan_id=plan_id,
        scene_spec=spec,
        solution_answer=str(state.get("solution_answer") or "") or None,
        solution_steps=state.get("solution_steps") if isinstance(state.get("solution_steps"), list) else None,
    )
