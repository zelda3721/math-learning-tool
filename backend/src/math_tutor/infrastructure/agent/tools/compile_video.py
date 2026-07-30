"""One bounded compile stage: write → validate → render.

Static/semantic validation and Manim execution are compiler internals, not
agent planning stages.  A first production draft receives at most one
evidence-directed repair before the high-level stage returns.
"""
from __future__ import annotations

import json
import re
import textwrap
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from .generate_manim_code import GenerateManimCodeTool
from .run_manim import RunManimTool
from .validate_manim_code import ValidateManimCodeTool


def _plain_fallback_text(value: Any) -> str:
    """Convert common math markup into glyphs safe for Manim Text."""
    text = str(value or "").strip()
    text = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"\1/\2", text)
    text = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", text)
    replacements = {
        r"\times": "×",
        r"\div": "÷",
        r"\cdot": "·",
        r"\le": "≤",
        r"\ge": "≥",
        r"\neq": "≠",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return re.sub(r"[$`{}]", "", text).replace("\\", "").strip()


def _wrap_fallback_text(value: Any, *, width: int = 26, max_lines: int = 4) -> str:
    text = " ".join(_plain_fallback_text(value).split())
    if not text:
        return ""
    actual_width = width if re.search(r"[\u3400-\u9fff]", text) else width * 2
    lines = textwrap.wrap(
        text,
        width=actual_width,
        break_long_words=True,
        break_on_hyphens=False,
    )
    if len(lines) > max_lines:
        lines = [*lines[: max_lines - 1], lines[max_lines - 1][: actual_width - 1] + "…"]
    return "\n".join(lines)


def build_verified_fallback_code(ctx: ToolContext) -> str:
    """Build a deterministic, content-agnostic playable explanation.

    This is a delivery fallback, not a problem-type renderer. It displays the
    exact question, independently verified steps, and answer with a stable
    progress visualization when model-authored Manim cannot compile.
    """
    raw_steps = ctx.state.get("solution_steps") or []
    steps: list[str] = []
    for index, raw in enumerate(raw_steps, start=1):
        if isinstance(raw, dict):
            parts: list[str] = []
            for key in ("description", "operation", "result"):
                value = _plain_fallback_text(raw.get(key))
                if value and value not in parts:
                    parts.append(value)
            text = "；".join(parts)
        else:
            text = _plain_fallback_text(raw)
        if text:
            steps.append(f"第{index}步：{text}")
    if len(steps) > 6:
        steps = [*steps[:5], steps[-1]]
    if not steps:
        steps = ["解答已经通过独立数学校验。"]

    problem = _wrap_fallback_text(ctx.problem, width=22, max_lines=5)
    answer = _wrap_fallback_text(
        "答案：" + _plain_fallback_text(ctx.state.get("solution_answer") or "已验证"),
        width=24,
        max_lines=3,
    )
    wrapped_steps = [_wrap_fallback_text(step, width=25, max_lines=4) for step in steps]
    return f'''from manim import *

PROBLEM_TEXT = {json.dumps(problem, ensure_ascii=False)}
STEP_TEXTS = {json.dumps(wrapped_steps, ensure_ascii=False, indent=4)}
ANSWER_TEXT = {json.dumps(answer, ensure_ascii=False)}


class SolutionScene(Scene):
    def fit(self, item, max_width=10.8, max_height=4.6):
        if item.width > max_width:
            item.scale_to_fit_width(max_width)
        if item.height > max_height:
            item.scale_to_fit_height(max_height)
        return item

    def construct(self):
        problem_card = self.fit(Text(PROBLEM_TEXT, font_size=40, color=WHITE))
        problem_card.move_to(ORIGIN)
        self.play(Write(problem_card))
        self.wait(3)
        self.play(FadeOut(problem_card))

        title = Text("已验证解题过程", font_size=34, color=BLUE).to_edge(UP, buff=0.45)
        progress = VGroup(*[
            Circle(radius=0.11, stroke_color=WHITE, stroke_width=2)
            for _ in STEP_TEXTS
        ]).arrange(RIGHT, buff=0.28).next_to(title, DOWN, buff=0.3)
        progress[0].set_fill(BLUE, opacity=1)
        body = self.fit(Text(STEP_TEXTS[0], font_size=30, color=WHITE))
        body.move_to(DOWN * 0.15)
        self.play(FadeIn(title), FadeIn(progress), FadeIn(body))
        self.wait(2)

        for index in range(1, len(STEP_TEXTS)):
            next_body = self.fit(Text(STEP_TEXTS[index], font_size=30, color=WHITE))
            next_body.move_to(body.get_center())
            self.play(
                FadeOut(body),
                progress[index].animate.set_fill(BLUE, opacity=1),
            )
            body = next_body
            self.play(FadeIn(body))
            self.wait(2)

        answer = self.fit(Text(ANSWER_TEXT, font_size=38, color=GREEN), max_height=3.2)
        answer.move_to(UP * 0.35)
        verified = Text("上述结果已通过独立校验", font_size=26, color=WHITE)
        verified.next_to(answer, DOWN, buff=0.55)
        self.play(FadeOut(body), FadeOut(progress), FadeOut(title))
        self.play(FadeIn(answer), FadeIn(verified))
        self.wait(3)
'''


class CompileVideoTool(ITool):
    def __init__(
        self,
        writer: GenerateManimCodeTool,
        validator: ValidateManimCodeTool,
        renderer: RunManimTool,
    ) -> None:
        self._writer = writer
        self._validator = validator
        self._renderer = renderer

    @property
    def name(self) -> str:
        return "compile_video"

    @property
    def description(self) -> str:
        return (
            "把 SceneSpec 编译为可播放视频。阶段内部完成 Manim 写码、确定性静态门禁、"
            "语义审计和渲染；首稿失败时只允许一次由具体证据驱动的修复。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "review_repair": {
                    "type": "boolean",
                    "description": "是否由成片审查触发；该模式不再进行内部二次修复",
                }
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        review_repair = bool(args.get("review_repair"))
        artifacts: list[ArtifactSpec] = []
        steps: list[dict[str, Any]] = []
        repair_count = 0

        generated = await self._writer.execute({}, ctx)
        artifacts.extend(generated.artifacts)
        steps.append(self._step("write", generated))
        if not generated.success:
            if review_repair:
                return self._failed("写码失败", generated, steps, artifacts, repair_count)
            repair_count += 1
            ctx.state["last_generation_error"] = generated.error or generated.summary
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("write_repair", generated))
            if not generated.success:
                return await self._fallback_or_failed(
                    "写码修复失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )

        validated = await self._validator.execute({}, ctx)
        steps.append(self._step("validate", validated))
        if not validated.success:
            if review_repair or repair_count >= 1:
                return await self._fallback_or_failed(
                    "代码门禁未通过",
                    validated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            repair_count += 1
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("repair", generated))
            if not generated.success:
                return await self._fallback_or_failed(
                    "证据定向修复失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            validated = await self._validator.execute({}, ctx)
            steps.append(self._step("revalidate", validated))
            if not validated.success:
                return await self._fallback_or_failed(
                    "修复后代码门禁仍未通过",
                    validated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )

        rendered = await self._renderer.execute({}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("render", rendered))
        if not rendered.success:
            if review_repair or repair_count >= 1:
                return await self._fallback_or_failed(
                    "渲染未通过",
                    rendered,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            repair_count += 1
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("render_repair", generated))
            if not generated.success:
                return await self._fallback_or_failed(
                    "渲染修复写码失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            validated = await self._validator.execute({}, ctx)
            steps.append(self._step("repair_validate", validated))
            if not validated.success:
                return await self._fallback_or_failed(
                    "渲染修复未通过代码门禁",
                    validated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            rendered = await self._renderer.execute({}, ctx)
            artifacts.extend(rendered.artifacts)
            steps.append(self._step("rerender", rendered))
            if not rendered.success:
                return await self._fallback_or_failed(
                    "修复后仍无法渲染",
                    rendered,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )

        ctx.state["compile_internal_repairs"] = (
            int(ctx.state.get("compile_internal_repairs") or 0) + repair_count
        )
        # A normal model-authored render replaces any earlier delivery fallback.
        # Keep the quality warning until Watch has reviewed this new candidate.
        ctx.state.pop("delivery_fallback", None)
        ctx.state.pop("delivery_fallback_reason", None)
        data = {
            "code": ctx.state.get("latest_manim_code") or "",
            "video_path": ctx.state.get("latest_video_path"),
            "video_url": ctx.state.get("latest_video_url"),
            "internal_repair_count": repair_count,
            "internal_steps": steps,
        }
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename=f"compile-turn{ctx.turn_index:02d}.json",
                content=json.dumps(
                    {"stage": self.name, "internal_repair_count": repair_count},
                    ensure_ascii=False,
                    indent=2,
                ),
                meta={"stage": self.name, "internal_repair_count": repair_count},
            )
        )
        return ToolResult(
            success=True,
            summary=(
                "编译成功：写码、校验、渲染均通过"
                + (f"（内部定向修复 {repair_count} 次）" if repair_count else "（首稿通过）")
            ),
            data=data,
            artifacts=artifacts,
        )

    @staticmethod
    def _step(name: str, result: ToolResult) -> dict[str, Any]:
        return {
            "name": name,
            "success": result.success,
            "summary": result.summary,
            "error": result.error,
        }

    def _failed(
        self,
        label: str,
        result: ToolResult,
        steps: list[dict[str, Any]],
        artifacts: list[ArtifactSpec],
        repair_count: int,
    ) -> ToolResult:
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename="compile-failed.json",
                content=json.dumps(
                    {
                        "stage": self.name,
                        "internal_repair_count": repair_count,
                        "success": False,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                meta={
                    "stage": self.name,
                    "internal_repair_count": repair_count,
                    "success": False,
                },
            )
        )
        return ToolResult(
            success=False,
            summary=f"{label}；编译阶段已停止无证据试错",
            data={
                "code": "",
                "internal_repair_count": repair_count,
                "internal_steps": steps,
            },
            artifacts=artifacts,
            error=result.error or result.summary,
        )

    async def _fallback_or_failed(
        self,
        label: str,
        result: ToolResult,
        steps: list[dict[str, Any]],
        artifacts: list[ArtifactSpec],
        repair_count: int,
        ctx: ToolContext,
        *,
        review_repair: bool,
    ) -> ToolResult:
        """Guarantee a playable first delivery without hiding quality loss."""
        if review_repair:
            return self._failed(label, result, steps, artifacts, repair_count)

        original_error = result.error or result.summary
        fallback_code = build_verified_fallback_code(ctx)
        ctx.state["latest_manim_code"] = fallback_code
        ctx.state["delivery_fallback"] = True
        ctx.state["delivery_fallback_reason"] = original_error
        ctx.state["last_validation_passed"] = False
        fallback_artifact = ArtifactSpec(
            kind="manim_code",
            filename=f"fallback-turn{ctx.turn_index:02d}.py",
            content=fallback_code,
            meta={"mode": "verified_delivery_fallback", "quality_degraded": True},
        )
        artifacts.append(fallback_artifact)
        rendered = await self._renderer.execute({"code": fallback_code}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("verified_fallback_render", rendered))
        if not rendered.success:
            return self._failed(
                "模型代码与确定性交付保底均未能渲染",
                rendered,
                steps,
                artifacts,
                repair_count,
            )

        report = {
            "stage": self.name,
            "success": True,
            "quality_degraded": True,
            "delivery_fallback": True,
            "internal_repair_count": repair_count,
            "primary_failure": label,
            "primary_error": original_error,
        }
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename=f"compile-fallback-turn{ctx.turn_index:02d}.json",
                content=json.dumps(report, ensure_ascii=False, indent=2),
                meta=report,
            )
        )
        return ToolResult(
            success=True,
            summary=(
                f"{label}；已生成可播放的已验证解答保底视频，"
                "画面质量标记为 degraded，后续仍会进入成片审查"
            ),
            data={
                "code": fallback_code,
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
                "internal_repair_count": repair_count,
                "internal_steps": steps,
                "delivery_fallback": True,
                "quality_degraded": True,
                "primary_error": original_error,
            },
            artifacts=artifacts,
        )
