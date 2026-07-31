"""Final watch stage with one bounded, evidence-directed revision.

Delivery policy: "good" and "acceptable" reviews deliver directly.  A "bad"
review gets exactly one evidence-directed repair (local source fix or one
SceneSpec revision) and a re-review.  If the repair still misses the gate, the
stage delivers the best playable candidate with an explicit quality warning
instead of failing the whole session — a watchable-but-imperfect video with a
diagnosis attached is strictly more useful than no video.
"""

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
            "仅依据帧证据进行一次局部修复或重新导演，然后复审；复审仍未达标时交付"
            "当前最佳候选并附质量警告。"
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
            return self._deliver_reviewed(first, artifacts, ctx, internal_repair_count=0)
        if not first.success or not isinstance(first.data, dict):
            return self._deliver_best_available(
                "成片审查未返回可操作的帧证据",
                first,
                artifacts,
                first_snapshot,
                ctx,
                replanned=False,
                internal_repair_count=0,
            )

        # Use the smallest repair unit that can address the observed failure.
        # Layout, clipping and pacing stay local to the existing source; only
        # a video without a usable visual argument revises the SceneSpec.
        directive = (first.data or {}).get("repair_directive") or {}
        replanned = str(directive.get("scope") or "code") == "plan"
        last_compiler = str(ctx.state.get("last_compiler") or "")
        if replanned:
            ctx.state["force_visual_replan"] = True
            directed = await self._director.execute({"review_repair": True}, ctx)
            artifacts.extend(directed.artifacts)
            if not directed.success:
                return self._deliver_best_available(
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
            compile_args: dict[str, Any] = {"review_repair": True}
            replanned_plan = ctx.state.get("visual_plan")
            parametric_story_repair = (
                isinstance(replanned_plan, dict)
                and replanned_plan.get("grounding_source") == "quantity_story"
            )
            if parametric_story_repair:
                # A parametric story variant (different pacing/style) already
                # guarantees different footage; the deterministic compiler is
                # the reliable lowering for quantity verbs.
                compile_args["deterministic_ir"] = True
            elif last_compiler == "visual_ir":
                # The failing video came from the deterministic template; a
                # similar replanned SceneSpec would compile to nearly the same
                # video (render cache included).  Force the model compiler so
                # the repair can actually change the footage.
                compile_args["model_codegen"] = True
            else:
                # A model-written program failed semantically; keep the next
                # hop deterministic so review cannot regress into a fresh,
                # unrelated program with new runtime failure modes.
                compile_args["deterministic_ir"] = True
        else:
            ctx.state.pop("force_visual_replan", None)
            # Mark that the one local repair is being spent; a later bad
            # review escalates to a SceneSpec revision instead of repeating
            # local patches on the same footage.
            ctx.state["visual_local_fix_attempted"] = True
            compile_args = {"review_repair": True}

        compiled = await self._compiler.execute(compile_args, ctx)
        artifacts.extend(compiled.artifacts)
        if not compiled.success:
            return self._deliver_best_available(
                "成片定向修复未能重新编译，已交付可播放的候选",
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
                return self._deliver_best_available(
                    "一次成片修复发生质量回归，已交付更好的候选",
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
            return self._deliver_best_available(
                "一次成片定向修复后仍未达到质量门禁，已交付最佳候选",
                second,
                artifacts,
                current_snapshot,
                ctx,
                replanned=replanned,
                internal_repair_count=1,
            )

        ctx.state["watch_internal_repairs"] = 1
        return self._deliver_reviewed(
            second, artifacts, ctx, internal_repair_count=1, replanned=replanned
        )

    @staticmethod
    def _passed(result: ToolResult) -> bool:
        """Good and acceptable both deliver; inspect_video already forces
        objective failures (layout硬伤/blacklist/technical) down to "bad"."""
        return bool(
            result.success
            and isinstance(result.data, dict)
            and str(result.data.get("overall_quality") or "").lower()
            in {"good", "acceptable"}
        )

    def _deliver_reviewed(
        self,
        result: ToolResult,
        artifacts: list[ArtifactSpec],
        ctx: ToolContext,
        *,
        internal_repair_count: int,
        replanned: bool = False,
    ) -> ToolResult:
        """Deliver a review that met the gate (good or acceptable)."""
        overall = str((result.data or {}).get("overall_quality") or "").lower()
        fallback_delivery = bool(ctx.state.get("delivery_fallback"))
        acceptable = overall == "acceptable"
        if acceptable:
            ctx.state["quality_degraded"] = True
            ctx.state["delivery_warning"] = "成片评审为 acceptable：可交付，问题已写入质量报告"
        elif not fallback_delivery:
            ctx.state.pop("quality_degraded", None)
            ctx.state.pop("delivery_warning", None)
        prefix = "可播放保底成片" if fallback_delivery else "成片"
        band = "复审" if internal_repair_count else "首审"
        verdict = "通过（acceptable，附改进建议）" if acceptable else "通过"
        return ToolResult(
            success=True,
            summary=f"{prefix}{band}{verdict}：" + result.summary,
            data={
                **(result.data or {}),
                "internal_repair_count": internal_repair_count,
                "replanned": replanned,
                "quality_degraded": bool(ctx.state.get("quality_degraded")),
                "delivery_fallback": fallback_delivery,
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
            },
            artifacts=artifacts,
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
    def _deliver_best_available(
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
        """Deliver the best playable candidate with an explicit warning.

        The full diagnosis stays in the quality report and in
        ``delivery_warning``; the session still ends with a watchable video.
        A rubric-vetted ``best_visual_candidate`` (kept by inspect_video)
        wins over the raw snapshot.  Only a session with no playable video at
        all fails.
        """
        best = ctx.state.get("best_visual_candidate") or {}
        if best.get("video_path"):
            candidate = {
                "code": best.get("code") or "",
                "video_path": best.get("video_path"),
                "video_url": best.get("video_url"),
                "review": best.get("review") or {},
                "source": "best_visual_candidate",
            }
        elif snapshot.get("video_path"):
            candidate = {**snapshot, "source": "snapshot"}
        else:
            return WatchVideoTool._failed(
                label,
                result,
                artifacts,
                replanned=replanned,
            )
        ctx.state["latest_manim_code"] = candidate.get("code") or ""
        ctx.state["latest_video_path"] = candidate["video_path"]
        ctx.state["latest_video_url"] = candidate.get("video_url")
        ctx.state["last_visual_review"] = candidate.get("review") or result.data or {}
        ctx.state["last_visual_issues"] = snapshot.get("issues") or label
        ctx.state["last_visual_failed"] = False
        ctx.state["quality_degraded"] = True
        ctx.state["delivery_warning"] = label
        if candidate.get("source") == "snapshot" and snapshot.get("delivery_fallback"):
            ctx.state["delivery_fallback"] = True
        return ToolResult(
            success=True,
            summary=f"已交付当前最佳候选视频（未达到质量门禁）：{label}",
            data={
                **(result.data or {}),
                "internal_repair_count": internal_repair_count,
                "replanned": replanned,
                "quality_degraded": True,
                "delivery_warning": label,
                "delivered_candidate_source": candidate.get("source"),
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
            },
            artifacts=artifacts,
            error=None,
        )
