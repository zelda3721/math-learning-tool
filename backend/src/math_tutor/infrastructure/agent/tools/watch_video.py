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
                summary=("可播放保底成片首审通过：" if fallback_delivery else "成片首审通过：")
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

        # Use the smallest repair unit that can address the observed failure.
        # Layout, clipping and pacing stay local to the existing source.  When
        # the rendered evidence says the visual thesis itself is absent or
        # mathematically inconsistent, keeping the same SceneSpec would only
        # rearrange a broken argument, so revise that contract exactly once.
        directive = (first.data or {}).get("repair_directive") or {}
        replanned = str(directive.get("scope") or "code") == "plan"
        if replanned:
            ctx.state["force_visual_replan"] = True
            directed = await self._director.execute({"review_repair": True}, ctx)
            artifacts.extend(directed.artifacts)
            if not directed.success:
                return self._deliver_degraded(
                    "成片语义失败，重新导演未能形成有效 SceneSpec",
                    first,
                    artifacts,
                    first_snapshot,
                    ctx,
                    replanned=True,
                    internal_repair_count=1,
                    extra={
                        "repair_plan_failed": True,
                        "repair_error": directed.error,
                    },
                )
        else:
            ctx.state.pop("force_visual_replan", None)

        compile_args = {"review_repair": True}
        if replanned:
            # A semantic repair replaces the SceneSpec. Keep the next hop
            # deterministic so review cannot regress into a fresh, unrelated
            # model-written program with a new set of runtime failure modes.
            compile_args["deterministic_ir"] = True
        compiled = await self._compiler.execute(compile_args, ctx)
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
                "成片复审通过：已根据首审证据完成一次" + ("重新导演" if replanned else "局部修复")
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
            marker in hits for marker in ("PPT", "文字搬运", "纯文字", "静态幻灯片", "静态展示")
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
