"""High-level visual direction stage.

The existing open-world planner remains the implementation.  This adapter
gives the product workflow a stable five-stage contract without duplicating
planning logic or exposing internal planner/auditor details as separate
timeline failures.
"""
from __future__ import annotations

import json
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from .visual_plan import VisualPlanTool, build_safe_visual_plan, store_visual_plan


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
        repaired = await self._planner.execute(args, ctx)
        if repaired.success:
            report = {
                "stage": self.name,
                "internal_repair_count": 1,
                "first_failure": first_summary,
            }
            return ToolResult(
                success=True,
                summary="视觉导演完成（内部契约修正 1 次）：" + repaired.summary,
                data={**(repaired.data or {}), "internal_repair_count": 1},
                artifacts=[
                    *result.artifacts,
                    *repaired.artifacts,
                    ArtifactSpec(
                        kind="pipeline_report",
                        filename=f"direct-turn{ctx.turn_index:02d}.json",
                        content=json.dumps(report, ensure_ascii=False, indent=2),
                        meta=report,
                    ),
                ],
            )
        repaired_candidate = (
            (repaired.data or {}).get("plan")
            if repaired.error != "plan_math_inconsistent"
            else None
        )
        repaired_safe_plan = build_safe_visual_plan(repaired_candidate, ctx)
        if repaired_safe_plan is not None:
            repaired_safe_plan["discarded_plan_error"] = repaired.error
            repaired_safe_plan["discarded_plan_summary"] = repaired.summary[:500]
            store_visual_plan(ctx, repaired_safe_plan)
            return ToolResult(
                success=True,
                summary=(
                    "视觉导演无法解析首稿，修正版文案未通过契约；"
                    "已保留可验证图形对象并切换为安全视觉基线"
                ),
                data={**repaired_safe_plan, "internal_repair_count": 1},
                artifacts=[*result.artifacts, *repaired.artifacts],
            )
        return ToolResult(
            success=False,
            summary="视觉导演首稿及一次证据定向修正均未通过内部契约：" + repaired.summary,
            data={
                **(repaired.data or {}),
                "internal_repair_count": 1,
                "first_failure": first_summary,
            },
            artifacts=[*result.artifacts, *repaired.artifacts],
            error=repaired.error,
        )
