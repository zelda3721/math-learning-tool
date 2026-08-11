"""Plan-only endpoint — POST /api/v1/plan (engine invasion #4, design §05).

Runs Solve → Verify → Direct and returns the SceneSpec (Visual IR) WITHOUT
entering Compile/Watch. This feeds Mode A (Web dynamic explanation): the TS
explainer-web player renders the spec in any webview — no ffmpeg / Manim /
LaTeX involved. Mode B (Manim video) keeps using POST /chat unchanged.

`route` picks who designs the picture:
  - "plan"  → SceneSpec，交给固定播放器渲染（画不出假话，但受图元词表限制）
  - "html"  → 模型直接写自足的 HTML（表达上限最高，靠契约门禁把住真实性）
  - "both"  → 两条都跑，用于并行攒对比数据（生成成本翻倍）

每一次生成都往数据集追加一行（题干 + 地面真值 + 走了哪条路 + 产物 + 门禁判定），
这是日后训练与「该往哪条路使劲」的唯一依据。

Stateless by design: no session persistence, no media output. The returned
plan_id is an opaque correlation id for the caller's own bookkeeping.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...application.interfaces.tool import ToolContext
from ...config.dependencies import get_settings, get_tool_registry
from ...config.settings import Settings
from ...domain.value_objects.grade import EducationLevel
from ...infrastructure.agent import ToolRegistry
from ...infrastructure.agent.generation_dataset import (
    ROUTE_DETERMINISTIC,
    ROUTE_LLM_HTML,
    ROUTE_LLM_PLAN,
    record_generation,
)

logger = logging.getLogger(__name__)

router = APIRouter()

PlanRoute = Literal["plan", "html", "both"]


class PlanRequest(BaseModel):
    problem: str
    grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    learner_id: str | None = None
    extra_directives: str | None = None
    #: 谁来设计画面；缺省沿用既有行为（SceneSpec）
    route: PlanRoute = "plan"
    #: 原题原图（data URL）。有它时讲解**不许重画图形**，只能把注解叠在原图上——
    #: 一致性因此是构造出来的，不是事后检查出来的。见 generate_web_explanation。
    figure_image: str | None = None


class PlanResponse(BaseModel):
    status: str  # 'ok' | 'failed'
    plan_id: str
    scene_spec: dict[str, Any] | None = None
    #: route 含 html 时的自足讲解页面（已过契约门禁）
    html: str | None = None
    #: html 的门禁判定（errors/warnings）；未生成时为 None
    html_gate: dict[str, Any] | None = None
    solution_answer: str | None = None
    solution_steps: list[dict[str, Any]] | None = None
    error: str | None = None


def _route_of(spec: Any) -> tuple[str, str | None]:
    """从计划本身判断它是谁写的：确定性构造器会盖 grounding_source 的章。"""
    source = spec.get("grounding_source") if isinstance(spec, dict) else None
    if isinstance(source, str) and source:
        return ROUTE_DETERMINISTIC, source
    return ROUTE_LLM_PLAN, None


@router.post("", response_model=PlanResponse)
@router.post("/", response_model=PlanResponse, include_in_schema=False)
async def plan_only(
    req: PlanRequest,
    registry: ToolRegistry = Depends(get_tool_registry),
    settings: Settings = Depends(get_settings),
) -> PlanResponse:
    plan_id = f"plan-{uuid.uuid4().hex[:12]}"
    state: dict[str, Any] = {
        "extra_directives": req.extra_directives or "",
        "figure_image": req.figure_image or "",
    }

    async def run(tool_name: str, turn: int, args: dict[str, Any] | None = None):
        tool = registry.get(tool_name)
        ctx = ToolContext(
            session_id=plan_id,
            turn_index=turn,
            grade=req.grade.value,
            problem=req.problem,
            state=state,
        )
        try:
            result = await tool.execute(args or {}, ctx)
        except Exception as exc:  # noqa: BLE001 — surface as clean failure
            logger.exception("plan-only %s failed", tool_name)
            return None, f"{tool_name}: {exc}"
        if not result.success:
            return result, f"{tool_name}: {result.error or result.summary or 'failed'}"
        return result, None

    # Solve → Verify → Direct（与五阶段前三段同构；verify 失败不阻断——
    # direct 会依据 solution_verified 自行选择保守路径，讲解仍可产出）
    _, error = await run("solve_problem", 1)
    if error:
        return PlanResponse(status="failed", plan_id=plan_id, error=error)
    _, verify_error = await run("verify_solution", 2)
    if verify_error:
        logger.warning("plan-only verify failed (continuing): %s", verify_error)

    # 必须用锚定后的路径：settings.data_dir 是原始字符串（"./data"），
    # 直接拿它会按进程 CWD 落盘，语料就散到各处去了
    data_dir = settings.resolved_data_dir
    common = {
        "problem": req.problem,
        "grade": req.grade.value,
        "learner_id": req.learner_id,
        "session_id": plan_id,
        "math_request": state.get("verify_math_request") or state.get("solve_math_request"),
        "math_evidence": state.get("verify_math_evidence") or state.get("solve_math_evidence"),
    }

    spec: dict[str, Any] | None = None
    plan_error: str | None = None
    if req.route in ("plan", "both"):
        _, plan_error = await run("direct_video", 3)
        candidate = state.get("visual_plan")
        if isinstance(candidate, dict):
            spec = candidate
            route, source = _route_of(candidate)
            record_generation(
                data_dir,
                route=route,
                grounding_source=source,
                artifact=candidate,
                artifact_kind="plan",
                # 计划这条路的真实性由折叠/播放器结构性保证，没有独立门禁判定
                gate={"ok": True, "errors": [], "warnings": []},
                **common,
            )
        elif plan_error is None:
            plan_error = "direct produced no visual_plan"

    html: str | None = None
    html_gate: dict[str, Any] | None = None
    html_error: str | None = None
    if req.route in ("html", "both"):
        result, html_error = await run(
            "generate_web_explanation", 4, {"extra_directives": req.extra_directives or ""}
        )
        payload = (result.data if result else None) or {}
        html_gate = payload.get("gate")
        produced = payload.get("html")
        if result is not None and result.success:
            html = produced
        record_generation(
            data_dir,
            route=ROUTE_LLM_HTML,
            artifact=produced,
            artifact_kind="html",
            gate=html_gate or {"ok": False, "errors": [html_error or "未产出"]},
            **common,
        )

    # both 模式下只要有一条成功就算成功——攒数据不该被另一条的失败拖垮
    if spec is None and html is None:
        return PlanResponse(
            status="failed",
            plan_id=plan_id,
            html_gate=html_gate,
            error=plan_error or html_error or "no explanation produced",
        )
    return PlanResponse(
        status="ok",
        plan_id=plan_id,
        scene_spec=spec,
        html=html,
        html_gate=html_gate,
        solution_answer=str(state.get("solution_answer") or "") or None,
        solution_steps=state.get("solution_steps")
        if isinstance(state.get("solution_steps"), list)
        else None,
    )
