"""run_manim — execute Manim code via the existing IVideoGenerator."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, IVideoGenerator, ToolContext, ToolResult

logger = logging.getLogger(__name__)


def _video_path_to_url(video_path: str | None) -> str | None:
    if not video_path:
        return None
    if "videos/" in video_path:
        subpath = video_path.split("videos/", 1)[-1]
        return f"/api/v1/media/videos/{subpath}"
    return f"/api/v1/media/videos/{video_path}"


class RunManimTool(ITool):
    def __init__(self, video_generator: IVideoGenerator) -> None:
        self._gen = video_generator

    @property
    def name(self) -> str:
        return "run_manim"

    @property
    def description(self) -> str:
        return (
            "把 Manim 代码交给本地 Manim 渲染器执行，生成 mp4 视频。失败时返回"
            "stderr，应把它作为 error_hint 传给下一次 generate_manim_code。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "要渲染的完整 Manim 代码（必须包含 SolutionScene 类）",
                },
            },
            "required": ["code"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        code = args.get("code") or ctx.state.get("latest_manim_code") or ""
        if not code.strip():
            return ToolResult(
                success=False,
                summary="没有代码可执行",
                error="empty_code",
            )

        try:
            result = await asyncio.to_thread(self._gen.execute_code, code)
        except Exception as exc:
            logger.exception("Manim execution crashed for session %s", ctx.session_id)
            return ToolResult(
                success=False,
                summary="Manim 执行异常",
                error=str(exc),
            )

        if not result.success:
            err = (result.error_message or "")[:1500]
            ctx.state["last_run_error"] = err
            return ToolResult(
                success=False,
                summary="Manim 渲染失败",
                data={"error_excerpt": err},
                error=err,
            )

        video_path = result.video_path or ""
        video_url = _video_path_to_url(video_path)
        ctx.state["latest_video_path"] = video_path
        ctx.state["latest_video_url"] = video_url
        ctx.state["last_run_error"] = None

        return ToolResult(
            success=True,
            summary="渲染成功",
            data={"video_path": video_path, "video_url": video_url},
            artifacts=[
                ArtifactSpec(
                    kind="video",
                    external_path=video_path,
                    meta={"url": video_url},
                ),
            ],
        )
