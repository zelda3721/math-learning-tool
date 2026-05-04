"""inspect_video — extract a few frames from the rendered Manim video and
send them to a multimodal LLM for visual feedback.

Output is markdown with `## 视觉评审`, `**整体质量**: ...`, and `### 问题/亮点/帧描述`
sub-sections. JSON fallback is provided.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ....application.interfaces import (
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from .. import markdown_extract as md
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


def _png_to_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


async def _ffprobe_duration(video_path: Path) -> float | None:
    if shutil.which("ffprobe") is None:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        text = out.decode().strip()
        return float(text) if text else None
    except Exception:
        return None


async def _extract_frame(video_path: Path, time_s: float, out_path: Path) -> bool:
    """Extract a single frame and downscale to 854px wide. Smaller payload
    means faster VLM call (fewer image tokens) without losing layout info."""
    if shutil.which("ffmpeg") is None:
        return False
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, time_s):.2f}",
        "-i",
        str(video_path),
        "-vframes",
        "1",
        "-vf",
        "scale=854:-1",  # downscale to 854 wide; height auto, divisible by 2
        "-q:v",
        "3",
        str(out_path),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.communicate(), timeout=20)
        return proc.returncode == 0 and out_path.exists()
    except Exception:
        logger.exception("ffmpeg frame extraction failed")
        return False


def _resolve_video_path(arg: str | None, ctx: ToolContext) -> Path | None:
    candidates: list[str] = []
    if arg:
        candidates.append(arg)
    state_path = ctx.state.get("latest_video_path")
    if isinstance(state_path, str) and state_path:
        candidates.append(state_path)
    for c in candidates:
        p = Path(c)
        if p.exists():
            return p
        if c.startswith("/api/v1/media/"):
            stripped = c.replace("/api/v1/media/", "")
            p2 = Path("media") / stripped
            if p2.exists():
                return p2
        p3 = Path(c)
        if not p3.is_absolute():
            for base in (Path.cwd(), Path.cwd() / "backend"):
                candidate = base / c
                if candidate.exists():
                    return candidate
    return None


def _parse_review(done: Any) -> dict[str, Any] | None:
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        if not source:
            continue
        section = md.find_section(source, "视觉评审", level=2) or md.find_section(
            source, "视觉评审"
        )
        if section is not None:
            return _md_to_review(section)
        json_payload = md.parse_json_anywhere(source)
        if json_payload:
            return json_payload
    return None


def _md_to_review(section: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "overall_quality": md.get_field(section, "整体质量", "overall_quality"),
        "b_total": md.get_field(section, "B 段总分", "b_total"),
        "blacklist_hits": md.get_field(section, "命中黑名单", "blacklist_hits"),
        "issues": md.get_bullets(md.find_section(section, "问题")),
        "highlights": md.get_bullets(md.find_section(section, "亮点")),
        "frame_descriptions": md.get_bullets(md.find_section(section, "帧描述")),
        "fix_suggestion": md.get_bullets(md.find_section(section, "修复建议")),
    }

    # Parse the per-criterion B-section scores (0/1/2)
    b_kv = md.get_kv_dict(md.find_section(section, "B 段打分"))
    scores: dict[str, int] = {}
    for key, raw in b_kv.items():
        # keys look like "B1 视觉模式命中" — keep just the leading B-label
        label = (key.split(" ", 1)[0] or key).strip().lower()
        # raw may be "1" / "2" / "0/2" / "1分"; pick first digit
        m = re.search(r"\d", str(raw))
        if m:
            scores[label] = int(m.group(0))
    if scores:
        payload["b_scores"] = scores
        # Compute total if model didn't print one or printed garbage
        if not payload["b_total"] or not str(payload["b_total"]).strip().split("/")[0].isdigit():
            payload["b_total"] = sum(scores.values())

    # Normalize blacklist: empty / "无" / "none" → []
    bl = (payload.get("blacklist_hits") or "").strip()
    if bl in ("", "无", "None", "none", "无。", "—"):
        payload["blacklist_hits"] = []
    else:
        payload["blacklist_hits"] = [s.strip() for s in re.split(r"[,，;；、]", bl) if s.strip()]

    return payload


class InspectVideoTool(ITool):
    def __init__(
        self,
        vision_llm: ILLMProvider,
        prompts: PromptLibrary,
        *,
        vision_model: str | None = None,
        frame_count: int = 2,
    ) -> None:
        self._llm = vision_llm
        self._prompts = prompts
        self._vision_model = vision_model
        # 2 frames (mid + late) is the sweet spot: catches both setup-quality
        # and final-quality without the cost of 3 VLM image tokens.
        self._frame_count = max(1, min(5, frame_count))

    @property
    def name(self) -> str:
        return "inspect_video"

    @property
    def description(self) -> str:
        return (
            "对刚渲染好的 Manim 视频抽 3 帧，送给多模态模型检查布局、重叠、"
            "可读性、节奏等视觉问题。run_manim 成功后调用一次即可；如果"
            "返回 overall_quality='bad'，把 issues 作为 error_hint 传给"
            "下一次 generate_manim_code 修复。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "video_path": {
                    "type": "string",
                    "description": "（可选）要检查的视频路径，缺省使用最近一次 run_manim 的产物",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        video_path = _resolve_video_path(args.get("video_path"), ctx)
        if video_path is None:
            return ToolResult(success=False, summary="找不到视频文件", error="video_not_found")
        if shutil.which("ffmpeg") is None:
            return ToolResult(
                success=False, summary="ffmpeg 未安装，无法抽帧", error="ffmpeg_missing"
            )

        duration = await _ffprobe_duration(video_path) or 6.0
        n = self._frame_count
        if n == 1:
            offsets = [duration / 2]
        else:
            offsets = [duration * (i + 1) / (n + 1) for i in range(n)]

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            frame_paths: list[Path] = []
            for i, offset in enumerate(offsets):
                out = tmp_dir / f"frame_{i:02d}.png"
                if await _extract_frame(video_path, offset, out):
                    frame_paths.append(out)
            if not frame_paths:
                return ToolResult(
                    success=False,
                    summary="抽帧失败（ffmpeg 返回非 0）",
                    error="frame_extraction_failed",
                )

            essence = (
                ctx.state.get("essence_rationale")
                or (ctx.state.get("visual_plan") or {}).get("essence_rationale")
                or ""
            ).strip()
            essence_section = (
                f"> {essence}"
                if essence
                else "（视觉计划未声明 essence_rationale，按通用标准评审本质兑现度）"
            )
            prompt_text = self._prompts.render(
                "inspect_video",
                n=len(frame_paths),
                essence_section=essence_section,
            )
            content_parts: list[dict[str, Any]] = [
                {"type": "text", "text": prompt_text}
            ]
            for fp in frame_paths:
                content_parts.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": _png_to_data_url(fp)},
                    }
                )

            try:
                done = await self._llm.chat_complete(
                    messages=[ChatMessage(role="user", content=content_parts)],
                    model=self._vision_model,
                    temperature=0.2,
                    max_tokens=3072,
                    # Vision evaluation: structured markdown rubric output.
                    # Thinking adds latency without improving accuracy here.
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
            except Exception as exc:
                logger.exception("inspect_video vision call failed")
                return ToolResult(
                    success=False, summary="视觉模型调用失败", error=str(exc)
                )

        payload = _parse_review(done)
        if payload is None:
            return ToolResult(
                success=False,
                summary="视觉模型未返回合法「## 视觉评审」section",
                error="parse_error",
                data={
                    "raw_text": (done.text or "")[:600],
                    "raw_reasoning": (done.reasoning or "")[:600],
                },
            )

        # Derive a final verdict from rubric scores rather than trusting the
        # model's own "整体质量" label, which has been observed to be lenient.
        overall = (payload.get("overall_quality") or "unknown").strip().lower()
        issues = payload.get("issues") or []
        blacklist = payload.get("blacklist_hits") or []
        b_total_raw = payload.get("b_total")
        try:
            b_total = int(str(b_total_raw).split("/")[0]) if b_total_raw not in (None, "") else None
        except (ValueError, TypeError):
            b_total = None

        forced_bad = False
        forced_reason = ""
        b_scores = payload.get("b_scores") or {}
        b6 = b_scores.get("b6")
        if blacklist:
            forced_bad = True
            forced_reason = f"命中黑名单：{', '.join(blacklist[:3])}"
        elif b6 == 0:
            # B6 = 0 means the video didn't deliver on the essence_rationale —
            # this is the master quality gate. Other items don't compensate.
            forced_bad = True
            forced_reason = "B6 = 0：视频未兑现 essence_rationale 声明的'本质'"
        elif b_total is not None and b_total < 7:
            forced_bad = True
            forced_reason = f"B 段总分 {b_total}/12 < 7"
        if forced_bad and overall != "bad":
            payload["overall_quality"] = "bad"
            overall = "bad"
            payload.setdefault("forced_reason", forced_reason)

        # Bump replan counter when verdict is bad — agent loop uses this to
        # decide whether the next iteration should re-plan (change pattern)
        # rather than locally patch the same code again.
        if overall == "bad":
            ctx.state["last_visual_failed"] = True
            ctx.state["visual_fail_count"] = int(ctx.state.get("visual_fail_count", 0)) + 1
            # Also surface the rubric payload so the next generate_manim_code
            # call can route via classify_visual_failure (block vs global).
            ctx.state["last_inspect_payload"] = payload
            ctx.state["last_error_source"] = "inspect"
        else:
            ctx.state["last_visual_failed"] = False
            ctx.state["visual_fail_count"] = 0
            ctx.state.pop("last_inspect_payload", None)

        ctx.state["last_visual_review"] = payload
        if isinstance(issues, list) and issues:
            # Surface fix suggestion + issues so generate_manim_code can pull
            # them as error_hint without extra wiring.
            fix = payload.get("fix_suggestion") or []
            extra_lines = [f"建议：{x}" for x in fix[:1]] if fix else []
            ctx.state["last_visual_issues"] = "；".join(
                [str(x) for x in issues[:5]] + extra_lines
            )
        elif forced_reason:
            ctx.state["last_visual_issues"] = forced_reason

        b_summary = f" B={b_total}/10" if b_total is not None else ""
        bl_summary = f" 黑名单 {len(blacklist)} 条" if blacklist else ""

        return ToolResult(
            success=True,
            summary=(
                f"视觉评审：{overall}{b_summary}{bl_summary}"
                + (f"，问题 {len(issues)} 条" if issues else "")
            ),
            data=payload,
        )
