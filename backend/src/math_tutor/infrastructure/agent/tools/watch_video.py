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
            "delivery_fallback": bool(ctx.state.get("delivery_fallback")),
        }
        if self._passed(first):
            fallback_delivery = bool(ctx.state.get("delivery_fallback"))
            return ToolResult(
                success=True,
                summary=(
                    "可播放保底成片首审通过：" if fallback_delivery else "成片首审通过："
                )
                + first.summary,
                data={
                    **(first.data or {}),
                    "internal_repair_count": 0,
                    "quality_degraded": fallback_delivery,
                    "delivery_fallback": fallback_delivery,
                },
                artifacts=artifacts,
            )
        if not first.success or not isinstance(first.data, dict):
            return self._deliver_degraded(
                "成片审查未返回可操作的帧证据",
                first,
                artifacts,
                first_snapshot,
                ctx,
                replanned=False,
                internal_repair_count=0,
            )

        # A deterministic fallback has no model-authored code block to patch.
        # If its visual proof is still insufficient, the one useful bounded
        # repair is a new SceneSpec, followed by recompilation from that plan.
        if first_snapshot["delivery_fallback"]:
            ctx.state["force_visual_replan"] = True

        # A proof/essence failure requires a new SceneSpec; technical layout
        # defects retain the plan and patch the code.  The decision comes from
        # review evidence, never from a problem-type branch.
        replanned = False
        if ctx.state.get("force_visual_replan"):
            directed = await self._director.execute({}, ctx)
            artifacts.extend(directed.artifacts)
            replanned = True
            if not directed.success:
                return self._deliver_degraded(
                    "成片证据要求重新导演，但新 SceneSpec 未通过契约",
                    first,
                    artifacts,
                    first_snapshot,
                    ctx,
                    replanned=True,
                    internal_repair_count=1,
                )

        compiled = await self._compiler.execute({"review_repair": True}, ctx)
        artifacts.extend(compiled.artifacts)
        if not compiled.success:
            return self._deliver_degraded(
                "成片定向修复未能重新编译，已恢复可播放的上一版候选",
                first,
                artifacts,
                first_snapshot,
                ctx,
                replanned=replanned,
                internal_repair_count=1,
                extra={
                    "repair_compile_failed": True,
                    "repair_error": compiled.error,
                },
            )

        second = await self._inspector.execute({}, ctx)
        artifacts.extend(second.artifacts)
        for artifact in artifacts:
            if artifact.kind == "quality_report":
                artifact.meta["watch_internal_repair_count"] = 1
                artifact.meta["watch_replanned"] = replanned
        if not self._passed(second):
            if self._meaningless_visual(second) and not ctx.state.get("delivery_fallback"):
                fallback = await self._compiler.execute({"visual_fallback_only": True}, ctx)
                artifacts.extend(fallback.artifacts)
                if fallback.success:
                    fallback_review = await self._inspector.execute({}, ctx)
                    artifacts.extend(fallback_review.artifacts)
                    fallback_snapshot = {
                        "code": ctx.state.get("latest_manim_code") or "",
                        "video_path": ctx.state.get("latest_video_path"),
                        "video_url": ctx.state.get("latest_video_url"),
                        "review": fallback_review.data or {},
                        "issues": ctx.state.get("last_visual_issues") or "",
                        "delivery_fallback": True,
                    }
                    if self._passed(fallback_review):
                        ctx.state["watch_internal_repairs"] = 1
                        return ToolResult(
                            success=True,
                            summary="模型候选缺少有效可视化；确定性关系动画已替换并通过复审",
                            data={
                                **(fallback_review.data or {}),
                                "internal_repair_count": 1,
                                "replanned": replanned,
                                "delivery_fallback": True,
                                "video_path": ctx.state.get("latest_video_path"),
                                "video_url": ctx.state.get("latest_video_url"),
                                "text_only_candidate_replaced": True,
                            },
                            artifacts=artifacts,
                        )
                    return self._deliver_degraded(
                        "模型修复成片缺少有效可视化，确定性关系动画复审仍未通过",
                        fallback_review,
                        artifacts,
                        fallback_snapshot,
                        ctx,
                        replanned=replanned,
                        internal_repair_count=1,
                        extra={"text_only_candidate_replaced": True},
                    )
            if self._quality_rank(first) > self._quality_rank(second):
                return self._deliver_degraded(
                    "一次成片修复发生质量回归，已恢复更好的上一版候选",
                    first,
                    artifacts,
                    first_snapshot,
                    ctx,
                    replanned=replanned,
                    internal_repair_count=1,
                    extra={"repair_regressed": True},
                )
            current_snapshot = {
                "code": ctx.state.get("latest_manim_code") or "",
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
                "review": second.data or {},
                "issues": ctx.state.get("last_visual_issues") or "",
                "delivery_fallback": bool(ctx.state.get("delivery_fallback")),
            }
            return self._deliver_degraded(
                "一次成片定向修复后仍未达到生产门禁",
                second,
                artifacts,
                current_snapshot,
                ctx,
                replanned=replanned,
                internal_repair_count=1,
            )

        ctx.state["watch_internal_repairs"] = 1
        # Compile removes delivery_fallback when it produces a normal candidate.
        # A passed second review is the point where its old warning can be cleared.
        if not ctx.state.get("delivery_fallback"):
            ctx.state.pop("quality_degraded", None)
            ctx.state.pop("delivery_warning", None)
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
    def _meaningless_visual(result: ToolResult) -> bool:
        data = result.data or {}
        hits = " ".join(str(item) for item in (data.get("blacklist_hits") or []))
        return any(
            marker in hits
            for marker in ("PPT", "文字搬运", "纯文字", "静态幻灯片", "静态展示")
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

    @staticmethod
    def _deliver_degraded(
        label: str,
        result: ToolResult,
        artifacts: list[ArtifactSpec],
        snapshot: dict[str, Any],
        ctx: ToolContext,
        *,
        replanned: bool,
        internal_repair_count: int,
        extra: dict[str, Any] | None = None,
    ) -> ToolResult:
        """Preserve the best candidate for diagnosis, but never deliver it as success.

        A decodable MP4 is not a useful product when the visual quality gate says
        that students cannot follow it.  Keeping the candidate in state makes the
        failure reproducible; ``last_visual_failed`` prevents the agent loop and
        frontend from treating it as the final video.
        """
        video_path = snapshot.get("video_path")
        if not video_path:
            return WatchVideoTool._failed(
                label,
                result,
                artifacts,
                replanned=replanned,
            )
        ctx.state["latest_manim_code"] = snapshot.get("code") or ""
        ctx.state["latest_video_path"] = video_path
        ctx.state["latest_video_url"] = snapshot.get("video_url")
        ctx.state["last_visual_review"] = snapshot.get("review") or result.data or {}
        ctx.state["last_visual_issues"] = snapshot.get("issues") or label
        ctx.state["last_visual_failed"] = True
        ctx.state["quality_degraded"] = True
        ctx.state["delivery_warning"] = label
        if snapshot.get("delivery_fallback"):
            ctx.state["delivery_fallback"] = True
        else:
            ctx.state.pop("delivery_fallback", None)
            ctx.state.pop("delivery_fallback_reason", None)
        return ToolResult(
            success=False,
            summary=f"候选视频未交付：质量门禁未通过；{label}",
            data={
                **(result.data or {}),
                "internal_repair_count": internal_repair_count,
                "replanned": replanned,
                "quality_degraded": True,
                "delivery_warning": label,
                "video_path": video_path,
                "video_url": snapshot.get("video_url"),
                **(extra or {}),
            },
            artifacts=artifacts,
            error=label,
        )
