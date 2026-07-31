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
    changed_fractions: list[float] = []
    for previous, current in zip(frames, frames[1:]):
        delta = ImageChops.difference(previous, current)
        differences.append(ImageStat.Stat(delta).mean[0] / 255.0)
        # Mean intensity misses THIN moving objects (a scan line sweeping a
        # curve barely moves the mean). Fraction of meaningfully-changed
        # pixels sees them.
        histogram = delta.histogram()
        total_pixels = float(sum(histogram)) or 1.0
        changed_fractions.append(sum(histogram[12:]) / total_pixels)
    return {
        "visible_fraction_by_frame": [round(value, 4) for value in visible_fractions],
        "entropy_by_frame": [round(value, 3) for value in entropies],
        "adjacent_frame_difference": [round(value, 4) for value in differences],
        "changed_pixel_fraction": [round(value, 4) for value in changed_fractions],
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
        # A legitimate two-line final answer can occupy this much of the
        # bottom band. Density alone cannot prove overlap; lifecycle/static
        # checks and the vision reviewer decide whether glyphs collide.
        warnings.append("底部安全带内容较密，需由成片审查确认是否叠字或图形侵入")
    differences = metrics.get("adjacent_frame_difference") or []
    changed_fractions = metrics.get("changed_pixel_fraction") or []

    def interval_active(index: int) -> bool:
        # Either signal counts: mean intensity (broad motion) OR fraction of
        # changed pixels (thin objects like scan lines and sliding dots).
        by_mean = float(differences[index]) >= 0.006
        by_pixels = (
            index < len(changed_fractions)
            and float(changed_fractions[index]) >= 0.02
        )
        return by_mean or by_pixels

    if differences and not any(interval_active(i) for i in range(len(differences))):
        critical.append("采样帧几乎无变化，疑似静态幻灯片")
    elif len(differences) >= 6:
        active_fraction = sum(
            interval_active(i) for i in range(len(differences))
        ) / len(differences)
        metrics["active_transition_fraction"] = round(active_fraction, 3)
        if duration >= 12 and active_fraction < 0.25:
            critical.append(
                "有效画面变化覆盖不足：少于 25% 的相邻采样区间出现可辨认变化，"
                "疑似长时间静止或只更新文字"
            )
        elif duration >= 12 and active_fraction < 0.4:
            warnings.append("有效画面变化偏少：少于 40% 的相邻采样区间出现可辨认变化")
    if metrics.get("has_audio") is False:
        warnings.append("视频无音轨；当前仍依赖画面和屏幕文字完成教学")
    return critical, warnings


def _deterministic_visual_math_integrity(plan: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Recheck machine-verifiable geometry independently of the vision model."""
    issues: list[str] = []
    checked_claims: list[str] = []
    objects = {
        str(item.get("id")): item
        for item in plan.get("visual_objects") or []
        if isinstance(item, dict) and item.get("id")
    }

    def finite_number(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None

    def polygon_area(vertices: Any) -> float | None:
        if (
            not isinstance(vertices, list)
            or len(vertices) < 3
            or not all(isinstance(point, list) and len(point) >= 2 for point in vertices)
        ):
            return None
        points: list[tuple[float, float]] = []
        for point in vertices:
            x = finite_number(point[0])
            y = finite_number(point[1])
            if x is None or y is None:
                return None
            points.append((x, y))
        double_area = sum(
            x * points[(index + 1) % len(points)][1] - points[(index + 1) % len(points)][0] * y
            for index, (x, y) in enumerate(points)
        )
        return abs(double_area) / 2

    def vertices_match(expected: list[list[float]], actual: Any) -> bool:
        if not isinstance(actual, list) or len(expected) != len(actual):
            return False
        for expected_point, actual_point in zip(expected, actual):
            if not isinstance(actual_point, list) or len(actual_point) < 2:
                return False
            actual_x = finite_number(actual_point[0])
            actual_y = finite_number(actual_point[1])
            if actual_x is None or actual_y is None:
                return False
            if not (
                math.isclose(expected_point[0], actual_x, rel_tol=1e-9, abs_tol=1e-9)
                and math.isclose(expected_point[1], actual_y, rel_tol=1e-9, abs_tol=1e-9)
            ):
                return False
        return True

    for object_id, item in objects.items():
        if item.get("primitive") != "polygon":
            continue
        params = item.get("params") or {}
        expected_measure = finite_number(params.get("verified_measure"))
        if expected_measure is None:
            continue
        actual_measure = polygon_area(params.get("vertices"))
        if actual_measure is None:
            issues.append(f"{object_id} 声明了 verified_measure，但顶点不可计算")
        elif not math.isclose(actual_measure, abs(expected_measure), rel_tol=1e-9, abs_tol=1e-9):
            issues.append(
                f"{object_id} 的坐标面积 {actual_measure:g} 与已验证测量 "
                f"{abs(expected_measure):g} 不一致"
            )
        else:
            checked_claims.append(f"{object_id} 的坐标面积 = {actual_measure:g}")

    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    matrix: list[list[float]] | None = None
    if isinstance(request, dict):
        candidates = []
        for operation in request.get("operations") or []:
            if not isinstance(operation, dict):
                continue
            expression = operation.get("expression")
            if (
                str(operation.get("op") or "").lower() == "determinant"
                and isinstance(expression, list)
                and len(expression) == 2
                and all(isinstance(row, list) and len(row) == 2 for row in expression)
            ):
                values = [finite_number(value) for row in expression for value in row]
                if all(value is not None for value in values):
                    a, b, c, d = (float(value) for value in values if value is not None)
                    candidates.append([[a, b], [c, d]])
        if len(candidates) == 1:
            matrix = candidates[0]

    if matrix is not None:
        for scene in plan.get("scenes") or []:
            if not isinstance(scene, dict):
                continue
            for action in scene.get("actions") or []:
                if not isinstance(action, dict) or action.get("op") != "transform":
                    continue
                source_id = next(
                    (
                        str(item)
                        for item in action.get("targets") or []
                        if (objects.get(str(item)) or {}).get("primitive") == "polygon"
                    ),
                    "",
                )
                result_id = str(action.get("result") or "")
                source = objects.get(source_id) or {}
                result = objects.get(result_id) or {}
                if result.get("primitive") != "polygon":
                    continue
                source_vertices = (source.get("params") or {}).get("vertices")
                result_vertices = (result.get("params") or {}).get("vertices")
                if not isinstance(source_vertices, list):
                    continue
                expected_vertices = []
                for point in source_vertices:
                    if not isinstance(point, list) or len(point) < 2:
                        expected_vertices = []
                        break
                    x = finite_number(point[0])
                    y = finite_number(point[1])
                    if x is None or y is None:
                        expected_vertices = []
                        break
                    expected_vertices.append(
                        [
                            matrix[0][0] * x + matrix[0][1] * y,
                            matrix[1][0] * x + matrix[1][1] * y,
                        ]
                    )
                if not vertices_match(expected_vertices, result_vertices):
                    issues.append(f"{source_id} → {result_id} 的顶点不符合已验证线性映射")
                else:
                    checked_claims.append(f"{source_id} → {result_id} 的全部顶点符合已验证线性映射")

    return {
        "passed": not issues,
        "checked_claims": checked_claims,
        "issues": issues,
        "grounding_adjustments": plan.get("math_grounding_adjustments") or [],
    }


def _hex_to_rgb(value: str) -> tuple[int, int, int] | None:
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return None


def _count_units_in_image(
    image: Any, bbox_px: tuple[int, int, int, int], color_hex: str
) -> int | None:
    """Connected components of one unit color inside a zone crop.

    Pure PIL + flood fill on a bounded crop; area-band filtering drops slashes
    and digits. Returns None when the color is unknown so callers can skip
    instead of mis-counting.
    """
    rgb = _hex_to_rgb(color_hex)
    if rgb is None:
        return None
    left, top, right, bottom = bbox_px
    margin = 6
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(image.width, right + margin)
    bottom = min(image.height, bottom + margin)
    if right - left < 4 or bottom - top < 4:
        return None
    crop = image.convert("RGB").crop((left, top, right, bottom))
    width, height = crop.size
    pixels = list(crop.getdata())
    mask = [
        sum(abs(pixel[i] - rgb[i]) for i in range(3)) < 130 for pixel in pixels
    ]
    visited = [False] * len(mask)
    areas: list[int] = []
    for start in range(len(mask)):
        if not mask[start] or visited[start]:
            continue
        stack = [start]
        visited[start] = True
        area = 0
        while stack:
            position = stack.pop()
            area += 1
            x, y = position % width, position // width
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    neighbor = ny * width + nx
                    if mask[neighbor] and not visited[neighbor]:
                        visited[neighbor] = True
                        stack.append(neighbor)
        areas.append(area)
    if not areas:
        return 0
    # Units in one group share a size; drop fragments below a fifth of the
    # largest component (anti-aliased slivers, cross marks, digits).
    threshold = max(20, max(areas) / 5)
    return sum(1 for area in areas if area >= threshold)


def _manifest_pixel_bbox(
    scene_bbox: list[float],
    frame_width: float,
    frame_height: float,
    image_width: int,
    image_height: int,
) -> tuple[int, int, int, int]:
    x_min, y_min, x_max, y_max = (float(v) for v in scene_bbox)
    to_px_x = lambda x: int((x + frame_width / 2) / frame_width * image_width)  # noqa: E731
    to_px_y = lambda y: int((frame_height / 2 - y) / frame_height * image_height)  # noqa: E731
    return (to_px_x(x_min), to_px_y(y_max), to_px_x(x_max), to_px_y(y_min))


async def _manifest_count_check(
    video_path: Path, manifest: dict[str, Any], tmp_dir: Path
) -> tuple[list[str], list[dict[str, Any]]]:
    """Deterministic per-zone count verification (calibration: warnings only).

    Returns (warnings, expectations); expectations feed the reviewer's
    targeted count questions for subitizable groups.
    """
    warnings: list[str] = []
    expectations: list[dict[str, Any]] = []
    try:
        from PIL import Image
    except ImportError:
        return warnings, expectations
    frame_width = float(manifest.get("frame_width") or 0)
    frame_height = float(manifest.get("frame_height") or 0)
    beats = [beat for beat in manifest.get("beats") or [] if isinstance(beat, dict)]
    if frame_width <= 0 or frame_height <= 0 or not beats:
        return warnings, expectations
    for beat in beats[:8]:
        groups = beat.get("groups") or {}
        if not groups:
            continue
        sample_time = max(0.2, float(beat.get("end_time") or 0) - 0.15)
        frame_file = tmp_dir / f"manifest_beat_{beat.get('beat_index')}.png"
        if not await _extract_frame(video_path, sample_time, frame_file):
            continue
        try:
            with Image.open(frame_file) as image:
                for group_id, info in list(groups.items())[:6]:
                    expected = int(info.get("count") or 0)
                    bbox = info.get("bbox")
                    if not isinstance(bbox, list) or len(bbox) != 4 or expected <= 0:
                        continue
                    dimmed = float(info.get("opacity") or 1.0) < 0.9
                    label = str(info.get("label") or "").strip()
                    if dimmed:
                        # Dimmed (crossed-out) units defeat the color mask;
                        # the reviewer's targeted count question covers them.
                        expectations.append(
                            {
                                "beat_index": beat.get("beat_index"),
                                "time_s": sample_time,
                                "group": str(group_id),
                                "expected": expected,
                                "label": label,
                                "dimmed": True,
                            }
                        )
                        continue
                    expectations.append(
                        {
                            "beat_index": beat.get("beat_index"),
                            "time_s": sample_time,
                            "group": str(group_id),
                            "expected": expected,
                            "label": label,
                            "dimmed": False,
                        }
                    )
                    measured = _count_units_in_image(
                        image,
                        _manifest_pixel_bbox(
                            bbox, frame_width, frame_height, image.width, image.height
                        ),
                        str(info.get("color") or ""),
                    )
                    if measured is not None and measured != expected:
                        warnings.append(
                            f"数量核验（校准期）：beat {beat.get('beat_index')} "
                            f"t≈{sample_time:.1f}s 组 {group_id} 期望 {expected} 个单位，"
                            f"按颜色连通域实测 {measured} 个"
                        )
        except Exception:
            logger.exception("manifest count check failed")
    return warnings, expectations


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
        "layout_fatal": md.get_field(section, "布局硬伤", "layout_fatal"),
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

    payload["blacklist_hits"] = _split_field(payload.get("blacklist_hits"))
    payload["layout_fatal"] = _split_field(payload.get("layout_fatal"))

    counts_section = md.find_section(section, "核数")
    reported_counts: list[dict[str, Any]] = []
    for bullet in md.get_bullets(counts_section) if counts_section else []:
        numbers = re.findall(r"\d+", str(bullet))
        if numbers:
            reported_counts.append({"raw": str(bullet), "value": int(numbers[-1])})
    if reported_counts:
        payload["reported_counts"] = reported_counts

    return payload


_FRAME_CHANGE_FLAG_RE = re.compile(r"变化[:：]\s*(是|否|仅文字)")


def _frame_change_flags(frame_descriptions: list[Any]) -> list[str]:
    """Per-frame structured change flags from the reviewer's descriptions."""
    flags: list[str] = []
    for item in frame_descriptions:
        match = _FRAME_CHANGE_FLAG_RE.search(str(item))
        flags.append(match.group(1) if match else "")
    return flags


_NEGATION_ITEM_RE = re.compile(
    r"^(无|没有|未发现|暂无|不存在|none|n/?a|no)(布局)?(硬伤|问题|异常)?[。.!！]?$",
    re.IGNORECASE,
)


def _split_field(raw: Any) -> list[str]:
    """Normalize a possibly-string list field; negation phrases mean empty."""
    if isinstance(raw, list):
        items = [str(item).strip() for item in raw]
    else:
        text = str(raw or "").strip()
        if not text:
            return []
        items = [s.strip() for s in re.split(r"[,，;；、]", text)]
    return [
        item
        for item in items
        if item and item != "—" and not _NEGATION_ITEM_RE.fullmatch(item)
    ]


def _coerce_payload_shapes(payload: dict[str, Any]) -> None:
    """Defend against the JSON-fallback parse path and stub payloads.

    A raw JSON review may carry ``blacklist_hits``/``layout_fatal`` as plain
    strings (iterating a string yields characters, so "无" would become a
    fake blacklist hit) and b_scores as strings.  Coerce everything to the
    shapes the verdict cascade assumes; unparseable scores are dropped so the
    missing-score gate handles them explicitly.
    """
    for key in ("blacklist_hits", "layout_fatal"):
        payload[key] = _split_field(payload.get(key))
    for key in ("issues", "highlights", "fix_suggestion", "frame_descriptions"):
        value = payload.get(key)
        if isinstance(value, str):
            payload[key] = [value.strip()] if value.strip() else []
        elif not isinstance(value, list):
            payload[key] = []
    scores = payload.get("b_scores")
    coerced: dict[str, int] = {}
    if isinstance(scores, dict):
        for name, raw in scores.items():
            match = re.search(r"\d", str(raw))
            if match:
                coerced[str(name).strip().lower()] = int(match.group(0))
    payload["b_scores"] = coerced


def _no_visual_argument(b_scores: dict[str, Any]) -> str | None:
    """Detect a video that carries no graphical reasoning at all.

    This is the only pedagogical condition that forces a hard failure on its
    own: pure computation with zero visual explanation contradicts the
    product's teaching contract regardless of problem type.
    """
    try:
        text_independence = int(b_scores.get("b3"))
        visible_change = int(b_scores.get("b4"))
        essence = int(b_scores.get("b6"))
    except (TypeError, ValueError):
        return "视觉评审缺少 B3/B4/B6 核心图形评分"
    if essence == 0:
        return "B6 = 0：画面完全没有揭示答案为什么成立，属于纯计算展示"
    if text_independence == 0 and visible_change == 0:
        return "B3 = 0 且 B4 = 0：关闭文字后画面无信息，核心关系未被图形揭示"
    return None


def _repair_scope(payload: dict[str, Any]) -> str:
    """Choose the smallest safe repair unit from rendered evidence.

    Layout, readability and pacing defects can be patched in the existing
    source; only a video with no visual argument at all needs a new SceneSpec.
    Routing almost everything to a replan discards working footage and, with a
    deterministic compiler, tends to regenerate the same video.
    """
    scores = payload.get("b_scores") or {}

    def score(name: str) -> int:
        try:
            return int(scores.get(name))
        except (TypeError, ValueError):
            return 0

    replan_blacklist = {"文字搬运", "纯文字", "PPT 翻页"}
    hits = {str(item).strip() for item in payload.get("blacklist_hits") or []}
    integrity = payload.get("deterministic_math_integrity") or {}
    if hits & replan_blacklist or integrity.get("passed") is False:
        return "plan"
    if not any(key in scores for key in ("b1", "b2", "b3", "b4", "b5", "b6")):
        # A review without scores is a formatting hiccup, not evidence of a
        # broken visual argument; do not throw away the SceneSpec over it.
        return "code"
    if score("b6") == 0 or (score("b4") == 0 and score("b3") <= 1):
        return "plan"
    return "code"


def _build_repair_directive(payload: dict[str, Any], frame_offsets: list[float]) -> dict[str, Any]:
    """Normalize stochastic review prose into a controller-ready brief."""
    issues = [str(item).strip() for item in payload.get("issues") or [] if str(item).strip()]
    suggestions = [
        str(item).strip() for item in payload.get("fix_suggestion") or [] if str(item).strip()
    ]
    highlights = [
        str(item).strip() for item in payload.get("highlights") or [] if str(item).strip()
    ]
    explicit_times: list[float] = []
    for text in [*issues, *suggestions]:
        explicit_times.extend(
            float(value) for value in re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*(?:s|秒)", text)
        )
    if explicit_times:
        time_range = [
            round(max(0.0, min(explicit_times) - 1.0), 2),
            round(max(explicit_times) + 1.0, 2),
        ]
    elif frame_offsets:
        time_range = [round(frame_offsets[0], 2), round(frame_offsets[-1], 2)]
    else:
        time_range = []
    return {
        "scope": _repair_scope(payload),
        "time_range_s": time_range,
        "change": suggestions[0] if suggestions else (issues[0] if issues else ""),
        "evidence": issues[:5],
        "preserve": highlights[:3],
    }


def _finalize_review(
    payload: dict[str, Any],
    technical_metrics: dict[str, Any],
    technical_critical: list[str],
    state: dict[str, Any],
    video_path: str,
    frame_offsets: list[float],
) -> tuple[str, int | None]:
    """Derive the final verdict from rubric scores and update session state.

    The gate is graduated instead of binary: only objective failures
    (technical criticals, unreadable layout, evidence-backed blacklist hits,
    an on-screen math contradiction, a video with no visual argument at all,
    or a very low rubric total) force "bad"; the 6-8 band delivers
    "acceptable" with its issues recorded.  Mutates ``payload`` and ``state``;
    returns ``(overall, b_total)``.
    """
    _coerce_payload_shapes(payload)
    overall = str(payload.get("overall_quality") or "unknown").strip().lower()
    issues = payload.get("issues") or []
    blacklist = [str(item).strip() for item in payload.get("blacklist_hits") or []]
    b_total_raw = payload.get("b_total")
    try:
        b_total = int(str(b_total_raw).split("/")[0]) if b_total_raw not in (None, "") else None
    except (ValueError, TypeError):
        b_total = None

    forced_bad = False
    forced_reason = ""
    b_scores = payload.get("b_scores") or {}
    if all(key in b_scores for key in ("b1", "b2", "b3", "b4", "b5", "b6")):
        computed_total = sum(int(b_scores[key]) for key in ("b1", "b2", "b3", "b4", "b5", "b6"))
        if b_total != computed_total:
            payload["reported_b_total"] = payload.get("b_total")
            payload["b_total"] = f"{computed_total}/12"
            b_total = computed_total
    b3 = b_scores.get("b3")
    b4 = b_scores.get("b4")
    b5 = b_scores.get("b5")
    b6 = b_scores.get("b6")

    # Hard layout failures come from the dedicated 布局硬伤 field.  When
    # the reviewer model ignores that field, fall back to issues that
    # report unreadability explicitly; ordinary wording like "重叠" or
    # "错误" inside a minor note must not sink a deliverable video.
    layout_fatal = [str(item).strip() for item in payload.get("layout_fatal") or []]
    if not layout_fatal:
        fallback_terms = (
            "无法辨认",
            "难以辨认",
            "不可读",
            "严重重叠",
            "严重遮挡",
            "完全遮挡",
            "裁切",
            "超出画面",
            "乱码",
            "unreadable",
            "clipped",
            "off-screen",
        )
        layout_fatal = [
            str(issue)
            for issue in issues
            if any(term in str(issue) for term in fallback_terms)
        ]
        if layout_fatal:
            payload["layout_fatal"] = layout_fatal
            payload["layout_fatal_derived"] = True

    # The reviewer sees stills: motion/coverage claims need measured
    # support, and "no graphics" claims must agree with its own rubric.
    # Unrecognized fragments (comma-split parentheticals and other parser
    # artifacts) are NOT hits — only known blacklist names can confirm.
    active_fraction = technical_metrics.get("active_transition_fraction")
    confirmed_hits: list[str] = []
    downgraded_hits: list[str] = []
    for hit in blacklist:
        if "静态" in hit or "动画时长" in hit:
            confirmed = active_fraction is not None and float(active_fraction) < 0.4
        elif "翻页" in hit or "搬运" in hit or "纯文字" in hit:
            confirmed = int(b3 or 0) <= 1 and int(b4 or 0) <= 1
        elif "公式墙" in hit or "悬空" in hit:
            confirmed = True
        else:
            confirmed = False
        (confirmed_hits if confirmed else downgraded_hits).append(hit)
    if downgraded_hits:
        payload["blacklist_downgraded"] = downgraded_hits
        payload["issues"] = issues = list(issues) + [
            f"黑名单声明缺少确定性证据支持，降级为一般问题：{hit}"
            for hit in downgraded_hits
        ]
    payload["blacklist_hits"] = blacklist = confirmed_hits

    no_visual_argument = _no_visual_argument(b_scores)

    # Keep an elite candidate across local fixes and full replans so a
    # later stochastic rewrite can never discard a deliverable video.
    # Eligibility means "deliverable": no objective failure, no visible
    # math contradiction, some essence on screen, acceptable band or up.
    candidate_eligible = (
        b_total is not None
        and b_total >= 6
        and int(b5 or 0) >= 1
        and int(b6 or 0) >= 1
        and no_visual_argument is None
        and not technical_critical
        and not layout_fatal
        and not blacklist
    )
    previous_best = state.get("best_visual_candidate") or {}
    previous_best_score = int(previous_best.get("score") or -1)
    if candidate_eligible and b_total is not None and b_total > previous_best_score:
        state["best_visual_candidate"] = {
            "score": b_total,
            "code": state.get("latest_manim_code") or "",
            "video_path": str(state.get("latest_video_path") or video_path),
            "video_url": state.get("latest_video_url") or "",
            "review": json.loads(json.dumps(payload, ensure_ascii=False)),
        }
    if technical_critical:
        forced_bad = True
        forced_reason = "；".join(technical_critical[:3])
    elif layout_fatal:
        forced_bad = True
        forced_reason = "布局硬伤：" + "；".join(layout_fatal[:2])
    elif b_total is None or b3 is None or b4 is None or b5 is None or b6 is None:
        forced_bad = True
        forced_reason = "视觉评审缺少完整 B 段评分"
    elif blacklist:
        forced_bad = True
        forced_reason = f"命中黑名单：{', '.join(blacklist[:3])}"
    elif int(b5) == 0:
        forced_bad = True
        forced_reason = "B5 = 0：画面与已验证数学证据存在矛盾"
    elif no_visual_argument:
        forced_bad = True
        forced_reason = no_visual_argument
    elif b_total < 6:
        forced_bad = True
        forced_reason = f"B 段总分 {b_total}/12 < 6"
    elif b_total >= 9 and int(b5) == 2:
        # Strong rubric with fully verifiable math: derive delivery
        # quality from the rubric instead of a stochastic adjective.
        if overall != "good":
            payload["reported_overall_quality"] = overall
            payload["overall_quality"] = "good"
            overall = "good"
    elif overall != "acceptable":
        # 6-8 band (or 9+ with only partially verifiable math on screen):
        # deliverable with recorded issues.
        payload["reported_overall_quality"] = overall
        payload["overall_quality"] = "acceptable"
        overall = "acceptable"
    if forced_bad and overall != "bad":
        payload.setdefault("reported_overall_quality", overall)
        payload["overall_quality"] = "bad"
        overall = "bad"
        payload.setdefault("forced_reason", forced_reason)

    # Score/observation consistency: when the reviewer itself marks frames as
    # unchanged, the pixels agree, and the manifest says a quantity change was
    # due in those windows, a "good" verdict is self-contradictory. Cap at
    # acceptable with a recorded inconsistency — never a solo bad-flip.
    if overall == "good":
        change_flags = _frame_change_flags(payload.get("frame_descriptions") or [])
        expected_flags = technical_metrics.get("manifest_change_expected_flags") or []
        differences = technical_metrics.get("adjacent_frame_difference") or []
        static_denials = 0
        for frame_index in range(1, len(change_flags)):
            interval = frame_index - 1
            if (
                change_flags[frame_index] in {"否", "仅文字"}
                and interval < len(differences)
                and float(differences[interval]) < 0.006
                and interval < len(expected_flags)
                and expected_flags[interval]
            ):
                static_denials += 1
        if static_denials >= 3:
            payload["score_inconsistency"] = (
                f"{static_denials} 个应发生数量变化的采样区间被评审自己标记为无变化"
                "且像素静止，与高分评分矛盾"
            )
            payload["reported_overall_quality"] = "good"
            payload["overall_quality"] = "acceptable"
            overall = "acceptable"
    payload["repair_directive"] = _build_repair_directive(payload, frame_offsets)

    # Bump replan counter when verdict is bad — agent loop uses this to
    # decide whether the next iteration should re-plan (change pattern)
    # rather than locally patch the same code again.
    if overall == "bad":
        state["last_visual_failed"] = True
        state["visual_fail_count"] = int(state.get("visual_fail_count", 0)) + 1
        # Also surface the rubric payload so the next generate_manim_code
        # call can route via classify_visual_failure (block vs global).
        state["last_inspect_payload"] = payload
        state["last_error_source"] = "inspect"
        # Replan only when the video carries no usable visual argument;
        # layout/pacing failures keep the SceneSpec and repair the source.
        directive_scope = str((payload.get("repair_directive") or {}).get("scope") or "code")
        if directive_scope == "plan" or state.get("visual_local_fix_attempted"):
            state["force_visual_replan"] = True
        else:
            state.pop("force_visual_replan", None)
    else:
        state["last_visual_failed"] = False
        state["visual_fail_count"] = 0
        state.pop("last_inspect_payload", None)
        state.pop("visual_local_fix_attempted", None)
        state.pop("force_visual_replan", None)

    state["last_visual_review"] = payload
    if isinstance(issues, list) and issues:
        # Surface fix suggestion + issues so generate_manim_code can pull
        # them as error_hint without extra wiring.
        fix = payload.get("fix_suggestion") or []
        extra_lines = [f"建议：{x}" for x in fix[:1]] if fix else []
        repair = payload.get("repair_directive") or {}
        repair_prefix = (
            f"修复层级={repair.get('scope')}; "
            f"时间={repair.get('time_range_s')}; "
            f"必须修改={repair.get('change')}"
        )
        state["last_visual_issues"] = "；".join(
            [repair_prefix]
            + (
                [str(x) for x in technical_critical[:3]]
                + [str(x) for x in issues[:5]]
                + extra_lines
            )
        )
    elif technical_critical:
        state["last_visual_issues"] = "；".join(technical_critical[:5])
    elif forced_reason:
        state["last_visual_issues"] = forced_reason
    return overall, b_total


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
            soft_pass_issues = ctx.state.get("contract_soft_pass_issues") or []
            if soft_pass_issues:
                technical_warnings.append(
                    "代码契约校验软放行，请重点核对图形论证是否真实兑现："
                    + "；".join(str(item) for item in soft_pass_issues[:3])
                )

            # Render-time beat manifest: deterministic per-zone count check
            # (calibration phase: warnings only) plus targeted subitizable
            # count questions for the reviewer.
            manifest = ctx.state.get("beat_manifest")
            manifest_expectations: list[dict[str, Any]] = []
            if isinstance(manifest, dict):
                manifest_warnings, manifest_expectations = await _manifest_count_check(
                    video_path, manifest, tmp_dir
                )
                technical_warnings.extend(manifest_warnings[:4])
                change_times: list[float] = []
                previous_counts: dict[str, Any] = {}
                for beat in manifest.get("beats") or []:
                    if not isinstance(beat, dict):
                        continue
                    counts = {
                        key: (value or {}).get("count")
                        for key, value in (beat.get("groups") or {}).items()
                    }
                    if previous_counts and counts and counts != previous_counts:
                        change_times.append(float(beat.get("end_time") or 0))
                    if counts:
                        previous_counts = counts
                expected_flags = [
                    any(
                        frame_offsets[i - 1] <= t <= frame_offsets[i]
                        for t in change_times
                    )
                    for i in range(1, len(frame_offsets))
                ]
                technical_metrics["manifest_change_expected_flags"] = expected_flags
            askable = [item for item in manifest_expectations if item["expected"] <= 6]

            def question_phrase(item: dict[str, Any]) -> str:
                # The reviewer cannot see internal group ids: describe the
                # group by its on-screen label and visual state.
                described = f"「{item['label']}」" if item.get("label") else ""
                state = "被划掉（变灰）的" if item.get("dimmed") else "完好（未被划掉）的"
                return (
                    f"- t≈{item['time_s']:.1f}s：{described}{state}单位应有 "
                    f"{item['expected']} 个（内部组名 {item['group']}）——请只数"
                    f"{state}单位并报告实际数量"
                )

            manifest_section = (
                "\n".join(question_phrase(item) for item in askable[:6])
                or "（无定点核数任务）"
            )
            # Plan-contract defects belong to the planning stage.  The rendered
            # video in front of us is the ground truth now; re-failing it for a
            # schema problem in the *plan* makes some sessions unwinnable (a
            # plan accepted for model codegen with lowering violations would
            # re-fail here on every review).  Surface them as warnings only.
            plan_contract_issues = (
                _validate_plan(plan, ctx.grade) if isinstance(plan, dict) else ["视觉计划缺失"]
            )
            if plan_contract_issues:
                technical_warnings.append(
                    "视觉计划契约警告（不判定成片失败）：" + "；".join(plan_contract_issues[:3])
                )
            math_integrity = (
                _deterministic_visual_math_integrity(plan, ctx)
                if isinstance(plan, dict)
                else {
                    "passed": False,
                    "checked_claims": [],
                    "issues": ["视觉计划缺失"],
                    "grounding_adjustments": [],
                }
            )
            if not math_integrity["passed"]:
                technical_critical.append(
                    "确定性视觉数学一致性失败：" + "；".join(math_integrity["issues"][:3])
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
                manifest_section=manifest_section,
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
        payload["sample_timestamps_s"] = [round(value, 2) for value in frame_offsets]
        payload["deterministic_math_integrity"] = math_integrity

        # Targeted count answers: a VLM count answer alone never hard-fails
        # (VLMs miscount); a mismatch caps B5 at "insufficient evidence" and
        # is recorded for diagnosis. The deterministic check owns hard calls.
        if askable:
            reported_counts = payload.get("reported_counts") or []
            mismatches: list[str] = []
            for expectation in askable:
                for reported in reported_counts:
                    if str(expectation["group"]) in str(reported.get("raw") or ""):
                        value = reported.get("value")
                        if isinstance(value, int) and value != expectation["expected"]:
                            mismatches.append(
                                f"组 {expectation['group']} 期望 {expectation['expected']}，"
                                f"评审数到 {value}"
                            )
                        break
            if mismatches:
                payload["manifest_mismatch"] = mismatches
                payload.setdefault("issues", []).append(
                    "定点核数不一致（B5 降为证据不足）：" + "；".join(mismatches[:2])
                )
                scores = payload.get("b_scores") or {}
                try:
                    if int(scores.get("b5") or 0) > 1:
                        scores["b5"] = 1
                except (TypeError, ValueError):
                    pass

        overall, b_total = _finalize_review(
            payload,
            technical_metrics,
            technical_critical,
            ctx.state,
            str(video_path),
            frame_offsets,
        )
        issues = payload.get("issues") or []
        blacklist = payload.get("blacklist_hits") or []
        b_scores = payload.get("b_scores") or {}

        b_summary = f" B={b_total}/12" if b_total is not None else ""
        bl_summary = f" 黑名单 {len(blacklist)} 条" if blacklist else ""
        review_index = int(ctx.state.get("watch_review_index") or 0) + 1
        ctx.state["watch_review_index"] = review_index

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
                    filename=(f"quality-turn{ctx.turn_index:02d}-pass{review_index:02d}.json"),
                    content=json.dumps(payload, ensure_ascii=False, indent=2),
                    meta={
                        "overall_quality": overall,
                        "b_total": b_total,
                        "math_consistency": b_scores.get("b5"),
                        "deterministic_math_pass": bool(math_integrity.get("passed")),
                        "essence_delivery": b_scores.get("b6"),
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
