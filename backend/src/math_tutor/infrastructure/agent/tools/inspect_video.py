"""inspect_video — extract a few frames from the rendered Manim video and
send them to a multimodal LLM for visual feedback.

Output is markdown with `## 视觉评审`, `**整体质量**: ...`, and `### 问题/亮点/帧描述`
sub-sections. JSON fallback is provided.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from .. import markdown_extract as md
from ..prompt_library import PromptLibrary
from .visual_plan import _validate_plan

logger = logging.getLogger(__name__)


def _png_to_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _parse_rate(value: str | None) -> float | None:
    if not value:
        return None
    try:
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            denominator_value = float(denominator)
            return float(numerator) / denominator_value if denominator_value else None
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


async def _ffprobe_metadata(video_path: Path) -> dict[str, Any]:
    if shutil.which("ffprobe") is None:
        return {}
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,width,height,avg_frame_rate",
            "-of",
            "json",
            str(video_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        payload = json.loads(out.decode() or "{}")
        streams = payload.get("streams") or []
        video_stream = next(
            (stream for stream in streams if stream.get("codec_type") == "video"), {}
        )
        format_data = payload.get("format") or {}
        return {
            "duration_s": float(format_data.get("duration") or 0),
            "file_size_bytes": int(format_data.get("size") or 0),
            "width": int(video_stream.get("width") or 0),
            "height": int(video_stream.get("height") or 0),
            "fps": _parse_rate(video_stream.get("avg_frame_rate")) or 0.0,
            "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
        }
    except Exception:
        return {}


def _frame_sequence_metrics(frame_paths: list[Path]) -> dict[str, Any]:
    """Cheap deterministic checks for blank or effectively static videos."""
    try:
        from PIL import Image, ImageChops, ImageStat
    except ImportError:
        return {}

    frames = []
    visible_fractions: list[float] = []
    entropies: list[float] = []
    top_border_occupancy: list[float] = []
    side_border_occupancy: list[float] = []
    caption_zone_occupancy: list[float] = []
    for path in frame_paths:
        with Image.open(path) as image:
            gray = image.convert("L").resize((96, 54))
            frames.append(gray.copy())
            histogram = gray.histogram()
            total = float(sum(histogram)) or 1.0
            visible_fractions.append(sum(histogram[12:]) / total)
            entropies.append(
                -sum((count / total) * math.log2(count / total) for count in histogram if count)
            )
            # Estimate the canvas background as the dominant downsampled
            # colour, then measure non-background content at safety borders.
            rgb = image.convert("RGB").resize((160, 90))
            colors = rgb.getcolors(maxcolors=160 * 90) or []
            background = max(colors, default=(0, (0, 0, 0)))[1]
            pixels = list(rgb.getdata())

            def occupied(pixel: tuple[int, int, int]) -> bool:
                return sum(abs(pixel[i] - background[i]) for i in range(3)) > 45

            mask = [occupied(pixel) for pixel in pixels]

            def region_fraction(indices: list[int]) -> float:
                return sum(mask[index] for index in indices) / max(1, len(indices))

            top_indices = [y * 160 + x for y in range(3) for x in range(160)]
            side_indices = [y * 160 + x for y in range(90) for x in (*range(3), *range(157, 160))]
            caption_indices = [y * 160 + x for y in range(77, 90) for x in range(160)]
            top_border_occupancy.append(region_fraction(top_indices))
            side_border_occupancy.append(region_fraction(side_indices))
            caption_zone_occupancy.append(region_fraction(caption_indices))

    differences: list[float] = []
    for previous, current in zip(frames, frames[1:]):
        differences.append(ImageStat.Stat(ImageChops.difference(previous, current)).mean[0] / 255.0)
    return {
        "visible_fraction_by_frame": [round(value, 4) for value in visible_fractions],
        "entropy_by_frame": [round(value, 3) for value in entropies],
        "adjacent_frame_difference": [round(value, 4) for value in differences],
        "blank_frame_count": sum(value < 0.002 for value in visible_fractions),
        "near_static_transition_count": sum(value < 0.006 for value in differences),
        "top_border_occupancy": [round(value, 4) for value in top_border_occupancy],
        "side_border_occupancy": [round(value, 4) for value in side_border_occupancy],
        "caption_zone_occupancy": [round(value, 4) for value in caption_zone_occupancy],
    }


def _derive_technical_issues(metrics: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Return (critical issues, warnings) without using problem categories."""
    critical: list[str] = []
    warnings: list[str] = []
    width = int(metrics.get("width") or 0)
    height = int(metrics.get("height") or 0)
    fps = float(metrics.get("fps") or 0)
    duration = float(metrics.get("duration_s") or 0)
    planned_duration = float(metrics.get("planned_duration_s") or 0)
    if not width or not height:
        critical.append("无法读取视频分辨率，技术质量不可验证")
    elif width < 960 or height < 540:
        critical.append(f"输出分辨率过低：{width}×{height}")
    if fps <= 0:
        critical.append("无法读取视频帧率，技术质量不可验证")
    elif fps < 24:
        critical.append(f"输出帧率过低：{fps:.1f}fps")
    if duration <= 0:
        critical.append("无法读取视频时长，技术质量不可验证")
    elif duration < 6:
        critical.append(f"视频过短：{duration:.1f}s，无法形成完整解释与验证")
    if duration and planned_duration:
        ratio = duration / planned_duration
        if ratio < 0.65:
            critical.append(f"实际时长仅为计划的 {ratio:.0%}，关键观察或验证可能被截短")
        elif ratio > 1.8:
            warnings.append(f"实际时长为计划的 {ratio:.0%}，可能存在冗长停顿或重复动画")
    blank_count = int(metrics.get("blank_frame_count") or 0)
    sampled = len(metrics.get("visible_fraction_by_frame") or [])
    if sampled and blank_count == sampled:
        critical.append("所有采样帧均近似空白")
    visible = metrics.get("visible_fraction_by_frame") or []
    if visible and float(visible[0]) < 0.008:
        critical.append("首个采样帧近似空白，开场未及时建立问题或视觉语言")
    top_border = metrics.get("top_border_occupancy") or []
    side_border = metrics.get("side_border_occupancy") or []
    caption_zone = metrics.get("caption_zone_occupancy") or []
    if top_border and max(top_border) > 0.35:
        critical.append("主视觉大面积触碰顶部安全边界，疑似越界或裁切")
    if side_border and max(side_border) > 0.35:
        critical.append("主视觉大面积触碰左右安全边界，疑似越界或裁切")
    if caption_zone and max(caption_zone) > 0.25:
        critical.append("底部字幕安全带过密，存在字幕裁切、叠字或图形侵入")
    differences = metrics.get("adjacent_frame_difference") or []
    if differences and max(differences) < 0.006:
        critical.append("采样帧几乎无变化，疑似静态幻灯片")
    if metrics.get("has_audio") is False:
        warnings.append("视频无音轨；当前仍依赖画面和屏幕文字完成教学")
    return critical, warnings


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


def _core_visual_gate_issue(b_scores: dict[str, Any]) -> str | None:
    """Reject symbolic cards masquerading as graphical mathematical change."""
    try:
        text_independence = int(b_scores.get("b3"))
        visible_change = int(b_scores.get("b4"))
    except (TypeError, ValueError):
        return "视觉评审缺少 B3/B4 核心图形评分"
    if text_independence < 2:
        return "B3 < 2：关闭文字后无法看懂核心数学变化"
    if visible_change < 2:
        return "B4 < 2：核心关系或变化没有被图形显式揭示"
    return None


class InspectVideoTool(ITool):
    def __init__(
        self,
        vision_llm: ILLMProvider,
        prompts: PromptLibrary,
        *,
        vision_model: str | None = None,
        frame_count: int = 12,
    ) -> None:
        self._llm = vision_llm
        self._prompts = prompts
        self._vision_model = vision_model
        # Twelve samples catch multi-second mid/late-scene layout defects that
        # sparse reviews miss, while still fitting common local VLM contexts.
        self._frame_count = max(1, min(12, frame_count))

    @property
    def name(self) -> str:
        return "inspect_video"

    @property
    def description(self) -> str:
        return (
            "对刚渲染好的 Manim 视频抽 12 帧，送给多模态模型检查布局、重叠、"
            "数学连续性、可读性和节奏。run_manim 成功后调用一次即可；如果"
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

        technical_metrics = await _ffprobe_metadata(video_path)
        duration = float(technical_metrics.get("duration_s") or 6.0)
        n = self._frame_count
        if n == 1:
            offsets = [duration / 2]
        elif n == 5:
            offsets = [duration * fraction for fraction in (0.05, 0.275, 0.5, 0.725, 0.95)]
        elif n == 7:
            offsets = [
                duration * fraction for fraction in (0.05, 0.22, 0.39, 0.56, 0.73, 0.90, 0.97)
            ]
        else:
            # Keep the first sample inside the mandatory 2.5–4s question-card
            # beat even for longer videos; spread the rest across the full
            # timeline to preserve dense middle/late layout coverage.
            first = min(2.0, max(1.5, duration * 0.08))
            offsets = [first] + [duration * i / (n + 1) for i in range(2, n + 1)]

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            frame_paths: list[Path] = []
            frame_offsets: list[float] = []
            for i, offset in enumerate(offsets):
                out = tmp_dir / f"frame_{i:02d}.png"
                if await _extract_frame(video_path, offset, out):
                    frame_paths.append(out)
                    frame_offsets.append(offset)
            if not frame_paths:
                return ToolResult(
                    success=False,
                    summary="抽帧失败（ffmpeg 返回非 0）",
                    error="frame_extraction_failed",
                )

            technical_metrics.update(_frame_sequence_metrics(frame_paths))
            plan = ctx.state.get("visual_plan") or {}
            planned_duration = sum(
                float(scene.get("duration_s") or 0)
                for scene in (plan.get("scenes") or [])
                if isinstance(scene, dict)
            )
            if planned_duration:
                technical_metrics["planned_duration_s"] = planned_duration
                technical_metrics["duration_ratio"] = round(duration / planned_duration, 3)
            technical_critical, technical_warnings = _derive_technical_issues(technical_metrics)
            plan_contract_issues = (
                _validate_plan(plan, ctx.grade) if isinstance(plan, dict) else ["视觉计划缺失"]
            )
            if plan_contract_issues:
                technical_critical.append(
                    "视觉动作因果契约失效：" + "；".join(plan_contract_issues[:3])
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
            thesis = str(plan.get("visual_thesis") or "").strip()
            ledger = plan.get("symbol_ledger") or []
            scenes = plan.get("scenes") or []
            beat_lines = []
            for index, scene in enumerate(scenes[:8], start=1):
                if not isinstance(scene, dict):
                    continue
                beat_lines.append(
                    f"- beat {index} [{scene.get('role', '?')}]: "
                    f"action={str(scene.get('action') or '')[:100]}; "
                    f"invariant={str(scene.get('invariant') or '')[:80]}; "
                    f"attention={str(scene.get('attention_target') or '')[:60]}; "
                    f"teaching_line={str(scene.get('teaching_line') or '')[:80]}; "
                    f"duration_s={scene.get('duration_s') or '?'}"
                )
            visual_contract_section = (
                f"visual_thesis: {thesis or '未声明'}\n"
                + "symbol_ledger: "
                + ("; ".join(str(item) for item in ledger[:12]) or "未声明")
                + "\n"
                + "\n".join(beat_lines)
            )
            solution_steps = ctx.state.get("solution_steps") or []
            step_lines = []
            for index, step in enumerate(solution_steps[:12], start=1):
                if isinstance(step, dict):
                    step_lines.append(
                        f"{index}. {str(step.get('description') or '')[:90]} | "
                        f"{str(step.get('operation') or '')[:90]} | "
                        f"result={str(step.get('result') or '')[:60]}"
                    )
            math_contract_section = (
                f"original_problem: {ctx.problem or '未声明'}\n"
                f"verified_answer: {ctx.state.get('solution_answer') or '未声明'}\n"
                + "verified_steps:\n"
                + "\n".join(step_lines)
            )
            technical_section = json.dumps(
                {
                    **technical_metrics,
                    "critical_issues": technical_critical,
                    "warnings": technical_warnings,
                },
                ensure_ascii=False,
                indent=2,
            )
            prompt_text = self._prompts.render(
                "inspect_video",
                n=len(frame_paths),
                essence_section=essence_section,
                visual_contract_section=visual_contract_section,
                math_contract_section=math_contract_section,
                technical_section=technical_section,
            )
            content_parts: list[dict[str, Any]] = [{"type": "text", "text": prompt_text}]
            for index, (fp, offset) in enumerate(zip(frame_paths, frame_offsets), start=1):
                content_parts.append(
                    {"type": "text", "text": f"采样帧 {index}，时间 {offset:.2f}s"}
                )
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
                    temperature=0.0,
                    max_tokens=3072,
                    # Vision evaluation: structured markdown rubric output.
                    # Thinking adds latency without improving accuracy here.
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
            except Exception as exc:
                logger.exception("inspect_video vision call failed")
                return ToolResult(success=False, summary="视觉模型调用失败", error=str(exc))

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

        payload["technical_metrics"] = technical_metrics
        payload["technical_critical_issues"] = technical_critical
        payload["technical_warnings"] = technical_warnings

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
        if all(key in b_scores for key in ("b1", "b2", "b3", "b4", "b5", "b6")):
            computed_total = sum(int(b_scores[key]) for key in (
                "b1", "b2", "b3", "b4", "b5", "b6",
            ))
            if b_total != computed_total:
                payload["reported_b_total"] = payload.get("b_total")
                payload["b_total"] = f"{computed_total}/12"
                b_total = computed_total
        b3 = b_scores.get("b3")
        b4 = b_scores.get("b4")
        b5 = b_scores.get("b5")
        b6 = b_scores.get("b6")
        core_visual_issue = _core_visual_gate_issue(b_scores)
        fatal_layout_terms = (
            "遮挡",
            "不可读",
            "裁切",
            "越界",
            "重叠",
            "拥挤",
            "过密",
            "压在",
            "挤在",
            "超出画面",
            "笔误",
            "乱码",
            "不符",
            "错误",
            "矛盾",
            "off-screen",
            "clipped",
            "overlap",
            "unreadable",
            "incorrect",
        )
        fatal_layout_issues = [
            str(issue)
            for issue in issues
            if any(term in str(issue).lower() for term in fatal_layout_terms)
        ]

        # Keep an elite candidate across local fixes and full replans.  A
        # candidate is eligible only when its rendered math and declared
        # visual proof are both complete and there is no objective technical
        # or layout failure.  This prevents a later stochastic rewrite from
        # discarding a substantially better, usable video.
        candidate_eligible = (
            b_total is not None
            and int(b3 or 0) == 2
            and int(b4 or 0) == 2
            and int(b5 or 0) == 2
            and int(b6 or 0) == 2
            and not technical_critical
            and not fatal_layout_issues
        )
        previous_best = ctx.state.get("best_visual_candidate") or {}
        previous_best_score = int(previous_best.get("score") or -1)
        if candidate_eligible and b_total is not None and b_total > previous_best_score:
            ctx.state["best_visual_candidate"] = {
                "score": b_total,
                "code": ctx.state.get("latest_manim_code") or "",
                "video_path": ctx.state.get("latest_video_path") or video_path,
                "video_url": ctx.state.get("latest_video_url") or "",
                "review": json.loads(json.dumps(payload, ensure_ascii=False)),
            }
        if technical_critical:
            forced_bad = True
            forced_reason = "；".join(technical_critical[:3])
        elif fatal_layout_issues:
            forced_bad = True
            forced_reason = "A 段布局失败：" + "；".join(fatal_layout_issues[:2])
        elif b_total is None or b3 is None or b4 is None or b5 is None or b6 is None:
            forced_bad = True
            forced_reason = "视觉评审缺少完整 B 段评分"
        elif blacklist:
            forced_bad = True
            forced_reason = f"命中黑名单：{', '.join(blacklist[:3])}"
        elif core_visual_issue:
            # A bordered formula or labeled value is still text dependence.
            # Manim is useful only when the non-text geometry carries enough
            # structure for a student to follow the central change.
            forced_bad = True
            forced_reason = core_visual_issue
        elif b5 is not None and b5 < 2:
            forced_bad = True
            forced_reason = "B5 < 2：成片没有提供可核对的完整数学一致性证据"
        elif b6 is not None and b6 < 2:
            # Production-quality cold starts must fully deliver the declared
            # essence; partial delivery is useful feedback, not a pass.
            forced_bad = True
            forced_reason = "B6 < 2：视频仅部分兑现 essence_rationale 声明的本质"
        elif b_total is not None and b_total < 7:
            forced_bad = True
            forced_reason = f"B 段总分 {b_total}/12 < 7"
        elif b_total is not None and b_total >= 9:
            # When proof/essence are complete and all objective gates passed,
            # derive delivery quality from the rubric instead of a stochastic
            # adjective. Minor aesthetic suggestions remain in ``issues`` but
            # must not make a correct, readable video disappear from the UI.
            if overall != "good":
                payload["reported_overall_quality"] = overall
                payload["overall_quality"] = "good"
                overall = "good"
        elif overall != "good":
            forced_bad = True
            forced_reason = f"整体质量仅为 {overall or 'unknown'}；生产门禁要求 good"
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
            b_scores = payload.get("b_scores") or {}
            proof_failure = int(b_scores.get("b5") or 0) < 2 or int(b_scores.get("b6") or 0) < 2
            # Preserve a runnable source for one focused visual repair when
            # the proof is sound and the failure is layout/pace/transition.
            # Replan immediately for broken evidence, or after that one local
            # repair fails to reach production quality.
            if proof_failure or ctx.state.get("visual_local_fix_attempted"):
                ctx.state["force_visual_replan"] = True
            else:
                ctx.state.pop("force_visual_replan", None)
        else:
            ctx.state["last_visual_failed"] = False
            ctx.state["visual_fail_count"] = 0
            ctx.state.pop("last_inspect_payload", None)
            ctx.state.pop("visual_local_fix_attempted", None)
            ctx.state.pop("force_visual_replan", None)

        ctx.state["last_visual_review"] = payload
        if isinstance(issues, list) and issues:
            # Surface fix suggestion + issues so generate_manim_code can pull
            # them as error_hint without extra wiring.
            fix = payload.get("fix_suggestion") or []
            extra_lines = [f"建议：{x}" for x in fix[:1]] if fix else []
            ctx.state["last_visual_issues"] = "；".join(
                [str(x) for x in technical_critical[:3]]
                + [str(x) for x in issues[:5]]
                + extra_lines
            )
        elif technical_critical:
            ctx.state["last_visual_issues"] = "；".join(technical_critical[:5])
        elif forced_reason:
            ctx.state["last_visual_issues"] = forced_reason

        b_summary = f" B={b_total}/12" if b_total is not None else ""
        bl_summary = f" 黑名单 {len(blacklist)} 条" if blacklist else ""

        return ToolResult(
            success=True,
            summary=(
                f"视觉评审：{overall}{b_summary}{bl_summary}"
                + (f"，问题 {len(issues)} 条" if issues else "")
            ),
            data=payload,
            artifacts=[
                ArtifactSpec(
                    kind="quality_report",
                    filename=f"quality-turn{ctx.turn_index:02d}.json",
                    content=json.dumps(payload, ensure_ascii=False, indent=2),
                    meta={
                        "overall_quality": overall,
                        "b_total": b_total,
                        "math_consistency": b5,
                        "essence_delivery": b6,
                        "technical_pass": not technical_critical,
                        "width": technical_metrics.get("width"),
                        "height": technical_metrics.get("height"),
                        "fps": technical_metrics.get("fps"),
                        "duration_s": technical_metrics.get("duration_s"),
                        "has_audio": technical_metrics.get("has_audio"),
                    },
                )
            ],
        )
