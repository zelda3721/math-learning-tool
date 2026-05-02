"""validate_manim_code — pure-static syntax + quality checks."""
from __future__ import annotations

import logging
import re
from typing import Any

from ....application.interfaces import ITool, ToolContext, ToolResult
from .. import occupancy_table as occ

logger = logging.getLogger(__name__)


# Banned Manim objects (from infrastructure/agents/nodes/debug.py).
_BANNED_OBJECTS = (
    "Sector",
    "AnnularSector",
    "Annulus",
    "ThreeDScene",
    "Surface",
)


def _extract_zone_map(scenes: list[dict]) -> dict[str, "occ.Zone"]:
    """Heuristic: scan scene's key_objects text for variable-like names
    (e.g. 'title', 'main_group', 'answer_box') and bind each to the scene's
    zone. Empty if we can't infer any var names — better to skip the check
    than emit false positives.
    """
    out: dict[str, "occ.Zone"] = {}
    var_re = re.compile(r"\b([a-z][a-z0-9_]{2,})\b")
    for s in scenes:
        zone_label = (s.get("anchor_zone") or "").strip()
        zone = occ.parse_zone(zone_label) if zone_label else None
        if zone is None:
            continue
        text = (s.get("key_objects") or "").lower()
        # Common pedagogical names
        for token in var_re.findall(text):
            if token in {"the", "and", "with", "for", "from", "this", "that"}:
                continue
            out.setdefault(token, zone)
    return out

_QUALITY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"arrange|arrange_in_grid", "缺少布局函数 (arrange)"),
    (r"scale\s*\(\s*0\.[4-7]", "缺少合适的缩放 (scale 0.4-0.7)"),
    (r"LaggedStart", "缺少逐个出现 (LaggedStart)"),
    (r"self\.wait\s*\(", "缺少等待时间 (self.wait)"),
    (r"VGroup", "缺少 VGroup 组织"),
)

_LAYOUT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"to_edge\s*\(\s*UP", "标题未 to_edge(UP)"),
    (r"to_edge\s*\(\s*DOWN", "答案未 to_edge(DOWN)"),
    (r"move_to\s*\(\s*ORIGIN|move_to\s*\(\s*DOWN|move_to\s*\(\s*UP", "图形未明确 move_to"),
    (r"next_to\s*\(", "缺少相对定位 next_to"),
)


def _check_syntax(code: str) -> tuple[bool, str | None]:
    try:
        compile(code, "<manim_code>", "exec")
        return True, None
    except SyntaxError as exc:
        return False, f"Line {exc.lineno}: {exc.msg}"


def _check_structure(code: str, *, use_latex: bool) -> list[str]:
    issues: list[str] = []
    if len(code) > 8000:
        issues.append(f"代码过长 ({len(code)} 字符 > 8000)")
    found_banned = [obj for obj in _BANNED_OBJECTS if obj in code]
    if found_banned:
        issues.append("使用了禁用对象: " + ", ".join(found_banned))
    if "class SolutionScene" not in code and "class MathVisualization" not in code:
        issues.append("缺少 SolutionScene（或 MathVisualization）类")
    if not use_latex and ("MathTex(" in code or "Tex(" in code or "Matrix(" in code):
        issues.append("LaTeX 未启用但代码包含 MathTex/Tex/Matrix")
    if "from manim" not in code:
        issues.append("缺少 from manim import *")
    return issues


def _check_patterns(code: str, patterns: tuple[tuple[str, str], ...]) -> list[str]:
    return [desc for pattern, desc in patterns if not re.search(pattern, code)]


_ORIGIN_POS_RE = re.compile(
    r"\.move_to\s*\(\s*(?:ORIGIN|np\.array\(\s*\[\s*0\s*,\s*0\s*,?\s*0?\s*\]\s*\)|\[\s*0\s*,\s*0\s*,?\s*0?\s*\])\s*\)"
)
_PLAY_RE = re.compile(r"\bself\.play\s*\(")
_WAIT_RE = re.compile(r"\bself\.wait\s*\(")
_TEXT_CTOR_RE = re.compile(r"\bText\s*\(")
_TO_EDGE_RE = re.compile(r"\.to_edge\s*\(")
_WRITE_RE = re.compile(r"\b(?:Write|FadeIn|AddTextLetterByLetter)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)")
_FADEOUT_RE = re.compile(r"\bFadeOut\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[\),]")


def _check_overlap_risk(code: str) -> list[str]:
    """Heuristics that catch the most common 'visually broken' patterns."""
    issues: list[str] = []

    # 1) Multiple things move_to(ORIGIN) without arrange/next_to nearby ↓
    origin_moves = len(_ORIGIN_POS_RE.findall(code))
    arrange_count = len(re.findall(r"\barrange|\barrange_in_grid\b", code))
    next_to_count = len(re.findall(r"\bnext_to\b", code))
    if origin_moves >= 2 and (arrange_count + next_to_count) == 0:
        issues.append(
            f"重叠风险：{origin_moves} 个对象 move_to(ORIGIN) 且无 arrange/next_to"
        )

    # 2) Animation density: 3+ consecutive self.play without a self.wait
    play_positions = [m.start() for m in _PLAY_RE.finditer(code)]
    wait_positions = [m.start() for m in _WAIT_RE.finditer(code)]
    if play_positions:
        consecutive = 0
        max_consecutive = 0
        wi = 0
        for p in play_positions:
            # advance wait pointer until wait > previous play
            while wi < len(wait_positions) and wait_positions[wi] < p:
                wi += 1
            if wi >= len(wait_positions):
                consecutive += 1
            else:
                # there is a wait somewhere later, but is it before next play?
                next_play = play_positions[play_positions.index(p) + 1] if play_positions.index(p) + 1 < len(play_positions) else None
                if next_play is not None and wait_positions[wi] < next_play:
                    consecutive = 0
                else:
                    consecutive += 1
            max_consecutive = max(max_consecutive, consecutive)
        if max_consecutive >= 4:
            issues.append(
                f"动画过密：连续 {max_consecutive} 个 self.play 之间没有 self.wait"
            )

    # 3) Many Text objects but no to_edge calls — likely overlap with graphics
    text_count = len(_TEXT_CTOR_RE.findall(code))
    to_edge_count = len(_TO_EDGE_RE.findall(code))
    if text_count >= 4 and to_edge_count == 0:
        issues.append(
            f"布局风险：{text_count} 个 Text 对象但完全没有 to_edge 分区，"
            "文字很可能与图形堆叠"
        )

    # 4) wait(0) or extremely short waits
    if re.search(r"self\.wait\s*\(\s*0(?:\.0)?\s*\)", code):
        issues.append("等待时间为 0：题目/答案展示时间不足")

    # 5) Multiple Write/FadeIn of different vars without FadeOut in between
    #    — classic stacked-text-overlap signature (the user has hit this)
    written = _WRITE_RE.findall(code)
    faded = set(_FADEOUT_RE.findall(code))
    if len(written) >= 3:
        unfaded = [v for v in written if v not in faded]
        if len(unfaded) >= 3:
            issues.append(
                f"文字堆叠风险：{len(unfaded)} 个对象 Write/FadeIn 后从未 FadeOut "
                f"（{', '.join(unfaded[:3])}...），它们会在屏幕上一直累积"
            )

    return issues


class ValidateManimCodeTool(ITool):
    @property
    def name(self) -> str:
        return "validate_manim_code"

    @property
    def description(self) -> str:
        return (
            "对 Manim 代码做静态校验：Python 语法、必要类、禁用对象、长度、"
            "布局规则、动画质量模式。不调用 LLM。校验失败时返回详细问题列表，"
            "你应将这些问题作为 error_hint 传给下一次 generate_manim_code。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "完整的 Manim Python 代码",
                },
                "use_latex": {
                    "type": "boolean",
                    "description": "环境是否启用 LaTeX（缺省按系统设置）",
                },
            },
            "required": ["code"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        code = args.get("code") or ctx.state.get("latest_manim_code") or ""
        if not code.strip():
            return ToolResult(
                success=False,
                summary="没有代码可校验",
                error="empty_code",
            )

        use_latex = bool(
            args.get("use_latex")
            if args.get("use_latex") is not None
            else ctx.state.get("use_latex", False)
        )

        syntax_ok, syntax_error = _check_syntax(code)
        structure_issues = _check_structure(code, use_latex=use_latex)
        missing_quality = _check_patterns(code, _QUALITY_PATTERNS)
        missing_layout = _check_patterns(code, _LAYOUT_PATTERNS)
        overlap_issues = _check_overlap_risk(code)

        # Occupancy table — extract placements + check against visual_plan zones.
        placements = occ.parse_placements_from_code(code)
        occupancy_overlap = occ.detect_overlap(placements)
        zone_violations: list[str] = []
        visual_plan = ctx.state.get("visual_plan") or {}
        scenes = visual_plan.get("scenes") or []
        if scenes:
            # Build {var_pattern: Zone} from key_objects (use scene index as
            # the var prefix is unrealistic; fall back to "all elements in
            # any zone"). Conservative: just check no cell has 3+ vars and
            # log a summary.
            declared = _extract_zone_map(scenes)
            if declared:
                zone_violations = occ.detect_zone_violation(
                    placements, declared_zones=declared
                )

        ctx.state["occupancy_report"] = occ.build_occupancy_report(placements)

        valid = syntax_ok and not structure_issues
        # Quality + layout + overlap heuristics are warnings, not hard failures.

        data = {
            "valid": valid,
            "syntax_ok": syntax_ok,
            "syntax_error": syntax_error,
            "structure_issues": structure_issues,
            "missing_quality_patterns": missing_quality,
            "missing_layout_patterns": missing_layout,
            "overlap_risk_issues": overlap_issues,
            "occupancy_overlap_issues": occupancy_overlap,
            "zone_violations": zone_violations,
            "code_length": len(code),
        }

        if valid:
            ctx.state["last_validation_passed"] = True
            warn_count = (
                len(missing_quality)
                + len(missing_layout)
                + len(overlap_issues)
                + len(occupancy_overlap)
                + len(zone_violations)
            )
            summary = "校验通过"
            if warn_count:
                summary += f"，但有 {warn_count} 条质量警告"
                priority_warns = (
                    occupancy_overlap[:1] + zone_violations[:1] + overlap_issues[:1]
                )
                if priority_warns:
                    summary += "（含布局问题：" + "；".join(priority_warns[:2]) + "）"
            return ToolResult(success=True, summary=summary, data=data)

        ctx.state["last_validation_passed"] = False
        problems: list[str] = []
        if syntax_error:
            problems.append(f"语法错误: {syntax_error}")
        problems.extend(structure_issues)
        return ToolResult(
            success=False,
            summary="校验未通过：" + "；".join(problems[:3]),
            data=data,
            error="validation_failed",
        )
