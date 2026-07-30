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


def _fallback_relation_model(raw: Any, index: int) -> dict[str, Any]:
    """Build a universal relation model from one verified solution step."""
    if isinstance(raw, dict):
        description = _plain_fallback_text(raw.get("description"))
        operation = _plain_fallback_text(raw.get("operation"))
        result = _plain_fallback_text(raw.get("result"))
    else:
        description = _plain_fallback_text(raw)
        operation = ""
        result = ""

    number = r"-?\d+(?:\.\d+)?"
    arithmetic = re.search(
        rf"(?P<left>{number})\s*(?P<operator>[+\-−×÷*/])\s*"
        rf"(?P<right>{number})\s*=\s*(?P<output>{number})",
        operation,
    )
    title = _wrap_fallback_text(
        f"第{index}步：{description or result or operation}", width=25, max_lines=2
    )
    if arithmetic:
        operator = arithmetic.group("operator").replace("*", "×").replace("/", "÷")
        return {
            "mode": "quantity",
            "title": title,
            "operator": operator,
            "left_label": arithmetic.group("left"),
            "right_label": arithmetic.group("right"),
            "output_label": arithmetic.group("output"),
            "left_value": float(arithmetic.group("left")),
            "right_value": float(arithmetic.group("right")),
            "output_value": float(arithmetic.group("output")),
            "result": _wrap_fallback_text(result, width=25, max_lines=2),
        }

    if "=" in operation:
        left, right = operation.split("=", 1)
    else:
        left = operation or description or "已验证前提"
        right = result or "已验证结论"
    return {
        "mode": "relation",
        "title": title,
        "left": _wrap_fallback_text(left, width=16, max_lines=3),
        "right": _wrap_fallback_text(right, width=16, max_lines=3),
        "result": _wrap_fallback_text(result, width=25, max_lines=2),
    }


def build_verified_fallback_code(ctx: ToolContext) -> str:
    """Build a deterministic, content-agnostic visual relation explanation.

    This is a delivery fallback, not a problem-type renderer. Numeric steps
    become animated magnitude relations; other steps become premise-to-result
    diagrams. The fallback therefore preserves visual reasoning instead of
    degrading into pages of prose.
    """
    raw_steps = ctx.state.get("solution_steps") or []
    if len(raw_steps) > 6:
        raw_steps = [*raw_steps[:5], raw_steps[-1]]
    models = [
        _fallback_relation_model(raw, index)
        for index, raw in enumerate(raw_steps, start=1)
    ]
    if not models:
        models = [
            {
                "mode": "relation",
                "title": "已验证推理",
                "left": "题目条件",
                "right": "已验证结论",
                "result": "",
            }
        ]

    problem = _wrap_fallback_text(ctx.problem, width=22, max_lines=5)
    answer = _wrap_fallback_text(
        "答案：" + _plain_fallback_text(ctx.state.get("solution_answer") or "已验证"),
        width=24,
        max_lines=3,
    )
    return f'''from manim import *

PROBLEM_TEXT = {json.dumps(problem, ensure_ascii=False)}
STEP_MODELS = {json.dumps(models, ensure_ascii=False, indent=4)}
ANSWER_TEXT = {json.dumps(answer, ensure_ascii=False)}


class SolutionScene(Scene):
    def fit(self, item, max_width=10.8, max_height=4.8):
        if item.width > max_width:
            item.scale_to_fit_width(max_width)
        if item.height > max_height:
            item.scale_to_fit_height(max_height)
        return item

    def quantity_bar(self, value, label, color, max_value):
        ratio = abs(float(value)) / max(max_value, 1.0)
        width = max(1.0, 4.2 * ratio)
        body = RoundedRectangle(
            width=width,
            height=0.72,
            corner_radius=0.12,
            stroke_color=color,
            stroke_width=3,
            fill_color=color,
            fill_opacity=0.28,
        )
        tick_count = min(max(int(abs(float(value))), 1), 12)
        ticks = VGroup()
        for tick_index in range(1, tick_count):
            x = -width / 2 + width * tick_index / tick_count
            ticks.add(Line([x, -0.29, 0], [x, 0.29, 0], color=color, stroke_width=1))
        value_text = Text(str(label), font_size=28, color=WHITE).move_to(body)
        return VGroup(body, ticks, value_text)

    def relation_card(self, text, color):
        label = self.fit(Text(str(text), font_size=27, color=WHITE), 4.2, 1.8)
        box = RoundedRectangle(
            width=max(2.4, label.width + 0.65),
            height=max(1.15, label.height + 0.5),
            corner_radius=0.14,
            stroke_color=color,
            stroke_width=3,
            fill_color=color,
            fill_opacity=0.18,
        )
        label.move_to(box)
        return VGroup(box, label)

    def make_board(self, model):
        if model["mode"] == "quantity":
            maximum = max(
                abs(float(model["left_value"])),
                abs(float(model["right_value"])),
                abs(float(model["output_value"])),
                1.0,
            )
            left = self.quantity_bar(
                model["left_value"], model["left_label"], BLUE, maximum
            )
            right = self.quantity_bar(
                model["right_value"], model["right_label"], ORANGE, maximum
            )
            operator = Text(model["operator"], font_size=38, color=YELLOW)
            inputs = VGroup(left, operator, right).arrange(RIGHT, buff=0.35)
            arrow = Arrow(UP * 0.2, DOWN * 0.55, color=WHITE, buff=0.05)
            output = self.quantity_bar(
                model["output_value"], model["output_label"], GREEN, maximum
            )
            output_tag = Text("得到", font_size=22, color=GREEN).next_to(output, LEFT, buff=0.28)
            result_group = VGroup(output_tag, output).arrange(RIGHT, buff=0.28)
            board = VGroup(inputs, arrow, result_group).arrange(DOWN, buff=0.32)
            focus = result_group
        else:
            premise = self.relation_card(model["left"], BLUE)
            conclusion = self.relation_card(model["right"], GREEN)
            arrow = Arrow(LEFT, RIGHT, color=YELLOW, buff=0.12, max_tip_length_to_length_ratio=0.15)
            board = VGroup(premise, arrow, conclusion).arrange(RIGHT, buff=0.45)
            focus = conclusion
        self.fit(board, 10.6, 3.7)
        return board, focus

    def construct(self):
        problem_card = self.fit(Text(PROBLEM_TEXT, font_size=40, color=WHITE))
        problem_card.move_to(ORIGIN)
        self.play(Write(problem_card))
        self.wait(3)
        self.play(FadeOut(problem_card))

        title = Text("已验证的数学关系", font_size=34, color=BLUE).to_edge(UP, buff=0.35)
        progress = VGroup(*[
            Circle(radius=0.11, stroke_color=WHITE, stroke_width=2)
            for _ in STEP_MODELS
        ]).arrange(RIGHT, buff=0.28).next_to(title, DOWN, buff=0.3)
        progress[0].set_fill(BLUE, opacity=1)
        step_title = self.fit(Text(STEP_MODELS[0]["title"], font_size=27, color=WHITE), 10.4, 1.0)
        step_title.next_to(progress, DOWN, buff=0.38)
        board, focus = self.make_board(STEP_MODELS[0])
        board.move_to(DOWN * 0.65)
        self.play(FadeIn(title), FadeIn(progress), FadeIn(step_title))
        self.play(FadeIn(board, shift=UP * 0.2))
        self.play(Indicate(focus, color=GREEN, scale_factor=1.04))
        self.wait(1.2)

        for index in range(1, len(STEP_MODELS)):
            next_title = self.fit(
                Text(STEP_MODELS[index]["title"], font_size=27, color=WHITE), 10.4, 1.0
            )
            next_title.move_to(step_title)
            next_board, next_focus = self.make_board(STEP_MODELS[index])
            next_board.move_to(board)
            self.play(
                FadeOut(step_title),
                FadeOut(board, shift=DOWN * 0.15),
                progress[index].animate.set_fill(BLUE, opacity=1),
            )
            step_title = next_title
            board = next_board
            focus = next_focus
            self.play(FadeIn(step_title), FadeIn(board, shift=UP * 0.15))
            self.play(Indicate(focus, color=GREEN, scale_factor=1.04))
            self.wait(1.2)

        answer = self.fit(Text(ANSWER_TEXT, font_size=38, color=GREEN), max_height=3.2)
        answer.move_to(UP * 0.35)
        verified = Text("上述结果已通过独立校验", font_size=26, color=WHITE)
        verified.next_to(answer, DOWN, buff=0.55)
        self.play(FadeOut(step_title), FadeOut(board), FadeOut(progress), FadeOut(title))
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
                f"{label}；已生成可播放的已验证关系图保底视频，"
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
