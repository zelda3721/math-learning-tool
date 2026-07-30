"""One bounded compile stage: write → validate → render.

Static/semantic validation and Manim execution are compiler internals, not
agent planning stages.  A first production draft receives at most one
evidence-directed repair before the high-level stage returns.
"""
from __future__ import annotations

import json
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from .generate_manim_code import GenerateManimCodeTool
from .run_manim import RunManimTool
from .validate_manim_code import ValidateManimCodeTool


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
                return self._failed("写码修复失败", generated, steps, artifacts, repair_count)

        validated = await self._validator.execute({}, ctx)
        steps.append(self._step("validate", validated))
        if not validated.success:
            if review_repair or repair_count >= 1:
                return self._failed("代码门禁未通过", validated, steps, artifacts, repair_count)
            repair_count += 1
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("repair", generated))
            if not generated.success:
                return self._failed("证据定向修复失败", generated, steps, artifacts, repair_count)
            validated = await self._validator.execute({}, ctx)
            steps.append(self._step("revalidate", validated))
            if not validated.success:
                return self._failed(
                    "修复后代码门禁仍未通过", validated, steps, artifacts, repair_count
                )

        rendered = await self._renderer.execute({}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("render", rendered))
        if not rendered.success:
            if review_repair or repair_count >= 1:
                return self._failed("渲染未通过", rendered, steps, artifacts, repair_count)
            repair_count += 1
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("render_repair", generated))
            if not generated.success:
                return self._failed("渲染修复写码失败", generated, steps, artifacts, repair_count)
            validated = await self._validator.execute({}, ctx)
            steps.append(self._step("repair_validate", validated))
            if not validated.success:
                return self._failed(
                    "渲染修复未通过代码门禁", validated, steps, artifacts, repair_count
                )
            rendered = await self._renderer.execute({}, ctx)
            artifacts.extend(rendered.artifacts)
            steps.append(self._step("rerender", rendered))
            if not rendered.success:
                return self._failed("修复后仍无法渲染", rendered, steps, artifacts, repair_count)

        ctx.state["compile_internal_repairs"] = (
            int(ctx.state.get("compile_internal_repairs") or 0) + repair_count
        )
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
