"""Final watch stage with one bounded, evidence-directed revision."""
from __future__ import annotations

from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from .compile_video import CompileVideoTool
from .direct_video import DirectVideoTool
from .inspect_video import InspectVideoTool


class WatchVideoTool(ITool):
    def __init__(
        self,
        inspector: InspectVideoTool,
        compiler: CompileVideoTool,
        director: DirectVideoTool,
    ) -> None:
        self._inspector = inspector
        self._compiler = compiler
        self._director = director

    @property
    def name(self) -> str:
        return "watch_video"

    @property
    def description(self) -> str:
        return (
            "审看完整成片的可读性、遮挡、节奏、数学一致性与教学表达。若首版未达标，"
            "仅依据帧证据进行一次局部修复或重新导演，然后复审。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return self._inspector.parameters

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        artifacts: list[ArtifactSpec] = []
        first = await self._inspector.execute(args, ctx)
        artifacts.extend(first.artifacts)
        first_snapshot = {
            "code": ctx.state.get("latest_manim_code") or "",
            "video_path": ctx.state.get("latest_video_path"),
            "video_url": ctx.state.get("latest_video_url"),
            "review": first.data or {},
            "issues": ctx.state.get("last_visual_issues") or "",
        }
        if self._passed(first):
            return ToolResult(
                success=True,
                summary="成片首审通过：" + first.summary,
                data={**(first.data or {}), "internal_repair_count": 0},
                artifacts=artifacts,
            )
        if not first.success or not isinstance(first.data, dict):
            return ToolResult(
                success=False,
                summary="成片审查未返回可操作的帧证据，未盲目改写视频",
                data={"internal_repair_count": 0},
                artifacts=artifacts,
                error=first.error or first.summary,
            )

        # A proof/essence failure requires a new SceneSpec; technical layout
        # defects retain the plan and patch the code.  The decision comes from
        # review evidence, never from a problem-type branch.
        replanned = False
        if ctx.state.get("force_visual_replan"):
            directed = await self._director.execute({}, ctx)
            artifacts.extend(directed.artifacts)
            replanned = True
            if not directed.success:
                return self._failed(
                    "成片证据要求重新导演，但新 SceneSpec 未通过契约",
                    first,
                    artifacts,
                    replanned=True,
                )

        compiled = await self._compiler.execute({"review_repair": True}, ctx)
        artifacts.extend(compiled.artifacts)
        if not compiled.success:
            ctx.state["latest_manim_code"] = first_snapshot["code"]
            ctx.state["latest_video_path"] = first_snapshot["video_path"]
            ctx.state["latest_video_url"] = first_snapshot["video_url"]
            ctx.state["last_visual_review"] = first_snapshot["review"]
            ctx.state["last_visual_issues"] = first_snapshot["issues"]
            ctx.state["last_visual_failed"] = True
            return ToolResult(
                success=False,
                summary="成片定向修复未能重新编译，已恢复可播放的上一版候选",
                data={
                    **(first.data or {}),
                    "internal_repair_count": 1,
                    "replanned": replanned,
                    "repair_compile_failed": True,
                    "repair_error": compiled.error,
                    "video_path": first_snapshot["video_path"],
                    "video_url": first_snapshot["video_url"],
                },
                artifacts=artifacts,
                error=compiled.error or "visual_repair_compile_failed",
            )

        second = await self._inspector.execute({}, ctx)
        artifacts.extend(second.artifacts)
        for artifact in artifacts:
            if artifact.kind == "quality_report":
                artifact.meta["watch_internal_repair_count"] = 1
                artifact.meta["watch_replanned"] = replanned
        if not self._passed(second):
            if self._quality_rank(first) > self._quality_rank(second):
                ctx.state["latest_manim_code"] = first_snapshot["code"]
                ctx.state["latest_video_path"] = first_snapshot["video_path"]
                ctx.state["latest_video_url"] = first_snapshot["video_url"]
                ctx.state["last_visual_review"] = first_snapshot["review"]
                ctx.state["last_visual_issues"] = first_snapshot["issues"]
                ctx.state["last_visual_failed"] = True
                return ToolResult(
                    success=False,
                    summary="一次成片修复发生质量回归，已恢复更好的上一版候选",
                    data={
                        **(first.data or {}),
                        "internal_repair_count": 1,
                        "replanned": replanned,
                        "repair_regressed": True,
                        "video_path": first_snapshot["video_path"],
                        "video_url": first_snapshot["video_url"],
                    },
                    artifacts=artifacts,
                    error="visual_repair_regressed",
                )
            return self._failed(
                "一次成片定向修复后仍未达到生产门禁",
                second,
                artifacts,
                replanned=replanned,
            )

        ctx.state["watch_internal_repairs"] = 1
        return ToolResult(
            success=True,
            summary=(
                "成片复审通过：已根据首审证据完成一次"
                + ("重新导演" if replanned else "局部修复")
            ),
            data={
                **(second.data or {}),
                "internal_repair_count": 1,
                "replanned": replanned,
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
            },
            artifacts=artifacts,
        )

    @staticmethod
    def _passed(result: ToolResult) -> bool:
        return bool(
            result.success
            and isinstance(result.data, dict)
            and str(result.data.get("overall_quality") or "").lower() == "good"
            and not result.data.get("blacklist_hits")
        )

    @staticmethod
    def _quality_rank(result: ToolResult) -> tuple[int, int, int, int, int]:
        data = result.data or {}
        overall_rank = {"bad": 0, "acceptable": 1, "good": 2}.get(
            str(data.get("overall_quality") or "").lower(),
            -1,
        )
        technical_pass = int(not bool(data.get("technical_critical_issues")))
        scores = data.get("b_scores") or {}

        def score(name: str) -> int:
            try:
                return int(scores.get(name) or 0)
            except (TypeError, ValueError):
                return 0

        raw_total = data.get("b_total")
        try:
            total = int(str(raw_total).split("/", 1)[0])
        except (TypeError, ValueError):
            total = 0
        return overall_rank, technical_pass, score("b5"), score("b6"), total

    @staticmethod
    def _failed(
        label: str,
        result: ToolResult,
        artifacts: list[ArtifactSpec],
        *,
        replanned: bool,
    ) -> ToolResult:
        return ToolResult(
            success=False,
            summary=label,
            data={
                **(result.data or {}),
                "internal_repair_count": 1,
                "replanned": replanned,
            },
            artifacts=artifacts,
            error=result.error or label,
        )
