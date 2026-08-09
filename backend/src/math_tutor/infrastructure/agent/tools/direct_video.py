"""High-level visual direction stage.

The existing open-world planner remains the implementation.  This adapter
gives the product workflow a stable five-stage contract without duplicating
planning logic or exposing internal planner/auditor details as separate
timeline failures.
"""
from __future__ import annotations

from typing import Any

from ....application.interfaces import ITool, ToolContext, ToolResult
from .visual_plan import (
    VisualPlanTool,
    build_grounded_math_visual_plan,
    build_linear_balance_visual_plan,
    build_minimal_narrative_plan,
    build_mix_swap_visual_plan,
    build_quantity_story_visual_plan,
    build_safe_visual_plan,
    store_visual_plan,
)


def _semantic_plan_ready_for_codegen(candidate: Any) -> bool:
    """Whether a plan is meaningful even if generic IR lowering is incomplete.

    This checks universal directing evidence, not a problem category: graphical
    objects, a visible change, an attention target and a final verification.
    A code model can implement continuous or custom geometry from that contract
    without forcing it through the finite deterministic primitive renderer.
    """
    if not isinstance(candidate, dict):
        return False
    if not str(candidate.get("visual_thesis") or "").strip():
        return False
    if len(str(candidate.get("essence_rationale") or "").strip()) < 20:
        return False
    objects = [item for item in candidate.get("visual_objects") or [] if isinstance(item, dict)]
    if len(objects) < 2 or any(not item.get("primitive") for item in objects):
        return False
    scenes = [item for item in candidate.get("scenes") or [] if isinstance(item, dict)]
    roles = {str(scene.get("role") or "") for scene in scenes}
    if len(scenes) < 3 or not {"transform", "verify"}.issubset(roles):
        return False
    return all(
        str(scene.get("action") or "").strip()
        and str(scene.get("attention_target") or "").strip()
        and str(scene.get("teaching_line") or "").strip()
        for scene in scenes
    )


class DirectVideoTool(ITool):
    def __init__(self, planner: VisualPlanTool) -> None:
        self._planner = planner

    @property
    def name(self) -> str:
        return "direct_video"

    @property
    def description(self) -> str:
        return (
            "把已验证解答导演成开放式 SceneSpec：定义视觉论证、稳定符号语言、"
            "时空布局、每个 beat 的动作语义与最终可见验证。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return self._planner.parameters

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        # A rendered semantic failure is evidence that the current contract
        # needs revision.  Do not immediately reconstruct the same deterministic
        # baseline; let the open-world planner consume the frame feedback once.
        # Normal cold starts prefer deterministic authorship: a verified
        # quantity story first (the simplest arithmetic deserves the most
        # reliable visual path), then curve/root-grounded Math IR.
        force_replan = bool(
            args.get("review_repair") or ctx.state.get("force_visual_replan")
        )
        grounded_plan = None
        if not force_replan:
            grounded_plan = (
                build_quantity_story_visual_plan(ctx)
                or build_mix_swap_visual_plan(ctx)
                or build_linear_balance_visual_plan(ctx)
                or build_grounded_math_visual_plan(ctx)
            )
        else:
            previous_plan = ctx.state.get("visual_plan")
            if (
                isinstance(previous_plan, dict)
                and previous_plan.get("grounding_source") == "quantity_story"
            ):
                # Parametric repair: a review failure of a deterministic story
                # plan reruns the same story with different pacing/style
                # instead of regressing to a stochastic full replan.
                grounded_plan = build_quantity_story_visual_plan(ctx, variant="repair")
        if grounded_plan is not None:
            store_visual_plan(ctx, grounded_plan)
            return ToolResult(
                success=True,
                summary=(
                    "已从独立数学证据直接构造可执行图形计划（"
                    + str(grounded_plan.get("grounding_source") or "math_ir")
                    + "）；无需模型猜测表达式或重写视觉计划"
                ),
                data=grounded_plan,
            )
        result = await self._planner.execute(args, ctx)
        if result.success:
            return ToolResult(
                success=True,
                summary="视觉导演完成：" + result.summary,
                data=result.data,
                artifacts=result.artifacts,
            )
        first_summary = result.summary
        candidate = (
            (result.data or {}).get("plan")
            if result.error != "plan_math_inconsistent"
            else None
        )
        violations = list((result.data or {}).get("violations") or [])
        lowering_only = bool(violations) and all(
            "未知图形对象" in str(item) for item in violations
        )
        if (
            result.error == "contract_violation"
            and lowering_only
            and _semantic_plan_ready_for_codegen(candidate)
        ):
            candidate["compile_strategy"] = "model_codegen"
            candidate["lowering_violations"] = violations[:10]
            store_visual_plan(ctx, candidate)
            return ToolResult(
                success=True,
                summary=(
                    "视觉语义计划完整；通用 IR 无法无损降级，"
                    "将由 Manim 写码阶段实现连续图形变化"
                ),
                data=candidate,
                artifacts=result.artifacts,
            )
        safe_plan = build_safe_visual_plan(candidate, ctx)
        if safe_plan is not None:
            safe_plan["discarded_plan_error"] = result.error
            safe_plan["discarded_plan_summary"] = first_summary[:500]
            store_visual_plan(ctx, safe_plan)
            return ToolResult(
                success=True,
                summary=(
                    "视觉导演首稿文案未通过契约；已保留可验证图形对象并切换为安全视觉基线"
                ),
                data=safe_plan,
                artifacts=result.artifacts,
            )
        # Absolute last resort: a session must never end with no video
        # because directing failed. Deliver a minimal verified-quantity
        # narrative, explicitly marked degraded so review warns on it.
        minimal_plan = build_minimal_narrative_plan(ctx)
        if minimal_plan is not None:
            minimal_plan["discarded_plan_error"] = result.error
            minimal_plan["discarded_plan_summary"] = first_summary[:500]
            store_visual_plan(ctx, minimal_plan)
            ctx.state["plan_degraded"] = (
                "视觉导演未产出完整计划，已降级为最小可验证叙事：" + first_summary[:200]
            )
            return ToolResult(
                success=True,
                summary=(
                    "视觉导演降级：LLM 计划与安全基线均不可用，"
                    "已改用最小已验证数量叙事（成片审查将附降级警告）"
                ),
                data=minimal_plan,
                artifacts=result.artifacts,
            )
        return ToolResult(
            success=False,
            summary="视觉导演未通过内部契约，已停止整稿重生成：" + first_summary,
            data={**(result.data or {}), "internal_repair_count": 0},
            artifacts=result.artifacts,
            error=result.error,
        )
