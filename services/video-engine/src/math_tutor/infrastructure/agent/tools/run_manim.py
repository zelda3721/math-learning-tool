"""run_manim — execute Manim code via the existing IVideoGenerator."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, IVideoGenerator, ToolContext, ToolResult
from ...media import (
    NarrationPostProcessor,
    build_narration_cues,
    probe_duration,
    render_webvtt,
)

logger = logging.getLogger(__name__)


def _compact_manim_error(value: str, *, max_chars: int = 2400) -> str:
    """Keep the traceback tail where Python/Manim prints the real exception."""
    text = (value or "").replace("\r", "\n").strip()
    if len(text) <= max_chars:
        return text
    return "…[traceback head omitted]…\n" + text[-max_chars:]


def _video_path_to_url(video_path: str | None) -> str | None:
    if not video_path:
        return None
    if "videos/" in video_path:
        subpath = video_path.split("videos/", 1)[-1]
        return f"/api/v1/media/videos/{subpath}"
    return f"/api/v1/media/videos/{video_path}"


class RunManimTool(ITool):
    def __init__(
        self,
        video_generator: IVideoGenerator,
        *,
        narration: NarrationPostProcessor | None = None,
        subtitles_enabled: bool = True,
    ) -> None:
        self._gen = video_generator
        self._narration = narration
        self._subtitles_enabled = subtitles_enabled

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
            "required": [],
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
            err = _compact_manim_error(result.error_message or "")
            ctx.state["last_run_error"] = err
            return ToolResult(
                success=False,
                summary="Manim 渲染失败",
                data={"error_excerpt": err},
                error=err,
            )

        video_path = result.video_path or ""
        source_video_path = video_path
        duration_s = probe_duration(Path(video_path)) if video_path else None
        cues = build_narration_cues(ctx.state.get("visual_plan"), actual_duration_s=duration_s)
        audio_attached = False
        narration_warning: str | None = None
        if video_path and self._narration is not None and cues:
            narration_result = await asyncio.to_thread(
                self._narration.attach_audio,
                Path(video_path),
                cues,
                duration_s=duration_s,
            )
            video_path = str(narration_result.video_path)
            audio_attached = narration_result.audio_attached
            narration_warning = narration_result.warning

        video_url = _video_path_to_url(video_path)
        ctx.state["latest_video_path"] = video_path
        ctx.state["latest_video_url"] = video_url
        ctx.state["last_run_error"] = None
        beat_manifest = getattr(result, "beat_manifest", None)
        if isinstance(beat_manifest, dict) and beat_manifest.get("beats"):
            ctx.state["beat_manifest"] = beat_manifest
        else:
            ctx.state.pop("beat_manifest", None)
        ctx.state.pop("fix_attempt_count", None)
        ctx.state.pop("last_visual_review", None)
        ctx.state.pop("last_visual_failed", None)
        ctx.state["narration_cues"] = [
            {"start_s": cue.start_s, "end_s": cue.end_s, "text": cue.text} for cue in cues
        ]
        ctx.state["narration_audio_attached"] = audio_attached

        artifacts: list[ArtifactSpec] = []
        if audio_attached and source_video_path != video_path:
            artifacts.append(
                ArtifactSpec(
                    kind="video",
                    external_path=source_video_path,
                    meta={
                        "url": _video_path_to_url(source_video_path),
                        "role": "source_without_narration",
                    },
                )
            )
        artifacts.append(
            ArtifactSpec(
                kind="video",
                external_path=video_path,
                meta={"url": video_url, "has_narration_audio": audio_attached},
            )
        )
        if self._subtitles_enabled and cues:
            artifacts.append(
                ArtifactSpec(
                    kind="subtitle",
                    filename=f"narration-turn{ctx.turn_index:02d}.vtt",
                    content=render_webvtt(cues),
                    meta={"format": "webvtt", "language": "zh", "cue_count": len(cues)},
                )
            )

        return ToolResult(
            success=True,
            summary=(
                "渲染成功"
                + (f"，已生成 {len(cues)} 段字幕" if cues else "")
                + ("并合成旁白" if audio_attached else "")
                + (f"（{narration_warning}）" if narration_warning else "")
            ),
            data={
                "video_path": video_path,
                "video_url": video_url,
                "subtitle_cues": len(cues),
                "narration_audio_attached": audio_attached,
                "narration_warning": narration_warning,
            },
            artifacts=artifacts,
        )
