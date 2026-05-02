"""visual_plan — choose how to *visually* tell the story before writing code.

This is the explicit "Visual Director" step that fixes the most common
failure mode in code-driven math video pipelines: when LLMs lack an
explicit visual mode, they default to throwing chain-of-thought text on
the screen ("PPT 翻页"). By forcing a structured plan up front (with
`role: transform` mandatory), we make "must have a real animation" a
hard contract instead of a soft hint.

Output is markdown:
  ## 视觉计划
  **primary_pattern**: <one of 14 enum values>
  **secondary_pattern**: <optional>
  ### 场景 N
  - role: setup|transform|reveal|verify
  - key_objects: ...
  - action: ...
  - invariant: ...
  ### 反模式禁用清单
  - ...
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ....application.interfaces import (
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from .. import markdown_extract as md
from ..occupancy_table import Zone, parse_zone
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


_VALID_PATTERNS = {
    "transformation_invariant",
    "area_model",
    "dissection_proof",
    "limit_exhaustion",
    "number_line",
    "dimension_lift",
    "symmetry_rotation",
    "covariation_pair",
    "bar_model",
    "discrete_grouping",
    "partition_whole",
    "isomorphism_metaphor",
    "extremes_sweep",
    "real_world_anchor",
}

_VALID_ROLES = {"setup", "transform", "reveal", "verify"}

# "Why-style" signal words. essence_rationale must contain at least one to
# pass — this is a forcing function: if the LLM can't articulate WHY in any
# of these terms, it's writing fluff and will produce fluff code.
_WHY_SIGNAL_WORDS = (
    "为什么",
    "因为",
    "揭示",
    "本质",
    "看到",
    "看见",
    "对应",
    "守恒",
    "等量",
    "不变",
    "原理",
    "让学生",
    "让人",
    "意味着",
    "保持",
    "对称",
    "变换",
    "变化",
    "等价",
    "同步",
    "互相",
)


def _zones_overlap(a: Zone, b: Zone) -> bool:
    """Return True if anchor rectangles overlap (any shared cell)."""
    a_anchors = {x.label for x in a.anchors()}
    b_anchors = {x.label for x in b.anchors()}
    return bool(a_anchors & b_anchors)


def _validate_essence_rationale(text: str, primary: str) -> list[str]:
    """essence_rationale must (a) be non-trivial, (b) say something more
    than just the pattern name, (c) actually explain a "why"."""
    errs: list[str] = []
    t = (text or "").strip()
    if not t:
        errs.append(
            "缺少 essence_rationale 字段：必须 30-200 字说明'为什么这种讲法揭示本质'"
        )
        return errs

    # Strip trivial padding
    if len(t) < 20:
        errs.append(
            f"essence_rationale 太短（{len(t)} 字）：至少 30 字，需要解释'为什么'"
        )
    if len(t) > 400:
        errs.append(
            f"essence_rationale 过长（{len(t)} 字）：控制在 200 字内，重点突出"
        )

    # Trivial rephrasing of the pattern name
    if primary and t.lower().count(primary.lower()) >= 1 and len(t) < 60:
        errs.append(
            "essence_rationale 只是在重复 primary_pattern 名，没有解释'为什么揭示本质'"
        )

    # Must contain a why-style signal word
    if not any(w in t for w in _WHY_SIGNAL_WORDS):
        errs.append(
            "essence_rationale 没有'为什么类'信号词（揭示/本质/对应/守恒/等量/不变/为什么/让...看到 等）；"
            "光说'用图形展示'不算，要说清楚学生通过这个画面看到了什么不变量/等量/对应"
        )

    return errs


_SECTION_ALIASES = ("视觉计划", "视觉规划", "Visual Plan", "visual_plan", "计划")


# ----- Lenient post-parse cleanup --------------------------------------------
# LLMs frequently emit 80%-correct output with formatting noise (markdown
# backticks around values, multiple zones in one field, smart quotes, etc.).
# Rather than rejecting these and looping forever, we clean them up here so
# the validator only sees structurally meaningful violations.

_BACKTICKS = "`'\"‘’“”"


def _strip_decorations(s: str) -> str:
    """Remove markdown / quote / smart-quote decorations a value-string."""
    if not s:
        return ""
    t = s.strip()
    # Strip outer pairs of backticks/quotes (markdown code-formatting)
    while len(t) >= 2 and t[0] in _BACKTICKS and t[-1] in _BACKTICKS:
        t = t[1:-1].strip()
    return t


def _fuzzy_match_pattern(value: str) -> str:
    """Map a noisy primary_pattern to one of the 14 valid enums.

    Tries:
      1. exact (case-insensitive) match
      2. substring match against any enum
      3. enum-contains-value
    Returns "" if no plausible match.
    """
    if not value:
        return ""
    cleaned = _strip_decorations(value).lower().strip("` '\"")
    for p in _VALID_PATTERNS:
        if p == cleaned:
            return p
    for p in _VALID_PATTERNS:
        if p.lower() == cleaned:
            return p
    # Substring either way
    for p in _VALID_PATTERNS:
        if p.lower() in cleaned or cleaned in p.lower():
            return p
    return ""


_ZONE_LIKE_RE = re.compile(r"[A-Fa-f][1-6]\s*[-–—~～to至]\s*[A-Fa-f][1-6]")
_SINGLE_ANCHOR_RE = re.compile(r"\b([A-Fa-f][1-6])\b")


def _clean_zone(value: str) -> str:
    """Pick the first valid zone-like substring out of a noisy field.

    LLMs sometimes emit 'A1-F1, B2-E5' or '`B2-E5`' or 'B2 to E5 (top)'.
    """
    if not value:
        return ""
    t = _strip_decorations(value)
    m = _ZONE_LIKE_RE.search(t)
    if m:
        return m.group(0).replace(" ", "")
    # Fall back to single anchor if present
    m2 = _SINGLE_ANCHOR_RE.search(t)
    if m2:
        return m2.group(1).upper()
    return t.strip()


def _normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Apply lenient cleanup across the whole plan dict in place."""
    if not isinstance(plan, dict):
        return plan

    # Primary / secondary pattern names — fuzzy-match to valid enum
    raw_primary = plan.get("primary_pattern") or ""
    matched = _fuzzy_match_pattern(raw_primary)
    if matched:
        plan["primary_pattern"] = matched
    else:
        plan["primary_pattern"] = _strip_decorations(raw_primary).lower()

    raw_secondary = plan.get("secondary_pattern") or ""
    if raw_secondary:
        matched_s = _fuzzy_match_pattern(raw_secondary)
        plan["secondary_pattern"] = matched_s if matched_s else _strip_decorations(raw_secondary)

    # essence_rationale — strip wrapping decorations only, leave content alone
    plan["essence_rationale"] = _strip_decorations(plan.get("essence_rationale") or "")

    # Scene-level cleanup
    scenes = plan.get("scenes") or []
    if isinstance(scenes, list):
        for s in scenes:
            if not isinstance(s, dict):
                continue
            s["role"] = _strip_decorations(s.get("role") or "").lower()
            s["anchor_zone"] = _clean_zone(s.get("anchor_zone") or "")
            s["key_objects"] = _strip_decorations(s.get("key_objects") or "")
            s["action"] = _strip_decorations(s.get("action") or "")
            s["invariant"] = _strip_decorations(s.get("invariant") or "")

    # forbidden — strip per-bullet decorations
    forbidden = plan.get("forbidden") or []
    if isinstance(forbidden, list):
        plan["forbidden"] = [_strip_decorations(x) for x in forbidden if x]

    return plan


def _parse_plan(done: Any) -> dict[str, Any] | None:
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        if not source:
            continue
        section: str | None = None
        for alias in _SECTION_ALIASES:
            section = md.find_section(source, alias, level=2) or md.find_section(source, alias)
            if section is not None:
                break
        if section is not None:
            payload = _md_to_plan(section)
            payload = _normalize_plan(payload)
            if payload.get("primary_pattern") and payload.get("scenes"):
                return payload
        json_payload = md.parse_json_anywhere(source)
        if json_payload and json_payload.get("primary_pattern"):
            return _normalize_plan(json_payload)
    return None


def _md_to_plan(section: str) -> dict[str, Any]:
    primary = md.get_field(section, "primary_pattern", "primary pattern", "主模式")
    secondary_raw = md.get_field(section, "secondary_pattern", "secondary pattern", "副模式")
    secondary = "" if secondary_raw.strip() in ("无", "none", "None", "—", "") else secondary_raw
    essence_rationale = md.get_field(
        section, "essence_rationale", "本质", "rationale", "为什么", "原理"
    )

    scenes: list[dict[str, Any]] = []
    for heading, body in md.find_subsections(section, level=3):
        h_lower = heading.lower()
        if "场景" not in heading and not h_lower.startswith("scene"):
            continue
        kv = md.get_kv_dict(body)
        # Lower-case keys for case-insensitive lookup.
        lowered = {k.lower(): v for k, v in kv.items()}
        scenes.append(
            {
                "role": (lowered.get("role") or "").strip().lower(),
                "anchor_zone": (lowered.get("anchor_zone") or lowered.get("zone") or "").strip(),
                "key_objects": lowered.get("key_objects") or lowered.get("objects") or "",
                "action": lowered.get("action") or "",
                "invariant": lowered.get("invariant") or "",
            }
        )

    forbidden_section = md.find_section(section, "反模式禁用清单") or md.find_section(
        section, "forbidden"
    )
    forbidden = md.get_bullets(forbidden_section)

    return {
        "primary_pattern": primary.strip(),
        "secondary_pattern": secondary.strip(),
        "essence_rationale": essence_rationale.strip(),
        "scenes": scenes,
        "forbidden": forbidden,
    }


def _validate_plan(
    plan: dict[str, Any],
    grade: str,
    *,
    previous_pattern: str = "",
    is_replan: bool = False,
) -> list[str]:
    """Return a list of contract violations. Empty = plan is valid."""
    errs: list[str] = []
    primary = (plan.get("primary_pattern") or "").strip()
    if primary not in _VALID_PATTERNS:
        errs.append(
            f"primary_pattern '{primary}' 不在 14 个允许枚举内"
        )

    # essence_rationale: the single most important quality check
    errs.extend(_validate_essence_rationale(plan.get("essence_rationale") or "", primary))

    scenes = plan.get("scenes") or []
    if len(scenes) < 3:
        errs.append(f"场景数 {len(scenes)} < 3")
    roles = [s.get("role", "") for s in scenes]
    if "transform" not in roles:
        errs.append("缺少 role=transform 场景（核心动画必须存在）")
    parsed_zones: list[tuple[int, Zone]] = []
    for i, s in enumerate(scenes, start=1):
        r = s.get("role", "")
        if r and r not in _VALID_ROLES:
            errs.append(f"场景 {i} role='{r}' 不在允许集合 {sorted(_VALID_ROLES)}")
        if not (s.get("key_objects") or "").strip():
            errs.append(f"场景 {i} key_objects 为空（屏幕上必须有图形）")
        zone_label = (s.get("anchor_zone") or "").strip()
        if not zone_label:
            errs.append(f"场景 {i} anchor_zone 为空（必须用 6×6 网格声明位置，如 'A1-F1'）")
        else:
            zone = parse_zone(zone_label)
            if zone is None:
                errs.append(f"场景 {i} anchor_zone='{zone_label}' 不符合 6×6 网格格式（如 'B3-E5'）")
            else:
                parsed_zones.append((i, zone))

    # Same-time scenes must not collide on the same anchor cell.
    # Heuristic: setup/transform/reveal that do NOT explicitly say "after
    # FadeOut" (we can't tell from the plan) are assumed to share screen.
    # Conservative rule: two scenes with the same role can't overlap zones.
    by_role: dict[str, list[tuple[int, Zone]]] = {}
    for i, z in parsed_zones:
        role = scenes[i - 1].get("role", "")
        by_role.setdefault(role, []).append((i, z))
    for role, zlist in by_role.items():
        if len(zlist) <= 1:
            continue
        for a_i, a_z in zlist:
            for b_i, b_z in zlist:
                if a_i >= b_i:
                    continue
                if _zones_overlap(a_z, b_z):
                    errs.append(
                        f"场景 {a_i} ({a_z.label}) 与场景 {b_i} ({b_z.label}) "
                        f"同为 role={role} 但 anchor 重叠"
                    )

    forbidden = plan.get("forbidden") or []
    if len(forbidden) < 2:
        errs.append("反模式清单至少 2 条")

    # Elementary problems: discourage overly abstract archetypes. For elementary
    # math, non-algebraic methods (假设法 / 线段图 / 比例 / 列表) ARE the principle-
    # revealing solutions — they're Chinese-elementary-math classics for a reason.
    # Pushing a kid through dimensional lifts, covariation pairs, or isomorphism
    # metaphors hides the visual intuition. Recommended primary patterns for
    # elementary: bar_model / transformation_invariant / discrete_grouping /
    # partition_whole / area_model / number_line / real_world_anchor.
    _ELEMENTARY_TOO_ABSTRACT = {
        "isomorphism_metaphor",
        "covariation_pair",
        "dimension_lift",
        "extremes_sweep",
    }
    if grade and grade.startswith("elementary"):
        if primary in _ELEMENTARY_TOO_ABSTRACT:
            errs.append(
                f"小学题不该用 {primary}（过于抽象）——改 bar_model / "
                f"transformation_invariant / discrete_grouping / partition_whole / "
                f"area_model / number_line / real_world_anchor 中之一"
            )

    # Replan must change primary_pattern — patching the same pattern is what
    # we're trying to escape from.
    if is_replan and previous_pattern and primary == previous_pattern:
        errs.append(
            f"重新规划必须换 primary_pattern，不能继续用 '{primary}'"
        )

    return errs


class VisualPlanTool(ITool):
    """Step between solve_problem and generate_manim_code: pick a visual
    pattern and outline scenes with hard contracts (must have a transform
    scene, must use a known pattern). Defends against PPT-flip degradation."""

    def __init__(self, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "visual_plan"

    @property
    def description(self) -> str:
        return (
            "在 generate_manim_code 之前调用一次。基于 solve_problem 的步骤，"
            "决定用 14 种视觉模式中的哪一种讲这道题，并产出 3+ 场景脚本（必须"
            "包含 role=transform）。这是防止视频退化为'PPT 翻页'的关键步骤——"
            "如果跳过，generate_manim_code 会默认把推理链打成 Text。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文（缺省取会话题目）"},
                "grade": {"type": "string", "description": "学生年级"},
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        if not problem:
            return ToolResult(success=False, summary="缺少题目", error="empty_problem")

        analysis = ctx.state.get("analysis")
        analysis_section = ""
        if analysis:
            try:
                analysis_section = (
                    "## 题目分析（来自 analyze_problem）\n"
                    f"```json\n{json.dumps(analysis, ensure_ascii=False, indent=2)}\n```"
                )
            except Exception:
                pass

        steps = ctx.state.get("solution_steps") or []
        ans = ctx.state.get("solution_answer") or ""
        solution_section = ""
        if steps:
            step_lines = []
            for i, s in enumerate(steps, start=1):
                desc = s.get("description") or ""
                op = s.get("operation") or ""
                step_lines.append(f"{i}. {desc}（运算：{op}）")
            solution_section = (
                "## 解题步骤（来自 solve_problem）\n"
                + "\n".join(step_lines)
                + (f"\n\n最终答案：{ans}" if ans else "")
            )

        patterns = ctx.state.get("matched_patterns") or []
        patterns_section = ""
        if patterns:
            names = [
                f"- {p.get('name')}：{p.get('description', '')[:60]}"
                for p in patterns[:3]
            ]
            patterns_section = (
                "## 已匹配模式（来自 match_skill）\n"
                + "\n".join(names)
                + "\n\n*这些是初步候选，最终 primary_pattern 可以不一样。*"
            )

        # If a previous visual plan was rejected by inspect_video, push the
        # reason to the prompt as a forced replan signal.
        replan_hint = ""
        if ctx.state.get("last_visual_failed") and ctx.state.get("visual_fail_count", 0) >= 1:
            prev_plan = ctx.state.get("visual_plan") or {}
            prev_pattern = prev_plan.get("primary_pattern", "?")
            issues = ctx.state.get("last_visual_issues") or ""
            replan_hint = (
                f"\n\n## ⚠️ 重新规划（上一份视觉计划失败）\n"
                f"上次 primary_pattern={prev_pattern} 被评审判 bad，问题：{issues[:200]}\n"
                f"**这次必须换一个 primary_pattern**，不能重复上次。"
            )

        # If validator rejected the *previous* visual_plan call (within this
        # same agent loop, so structured retry), include the violation list +
        # last attempt so the LLM can fix the specific issues instead of
        # blindly re-emitting from scratch.
        validator_retry_hint = ""
        last_violations = ctx.state.get("visual_plan_last_violations") or []
        last_attempt_text = ctx.state.get("visual_plan_last_attempt") or ""
        if last_violations:
            violations_md = "\n".join(f"  - {v}" for v in last_violations[:8])
            attempt_excerpt = (last_attempt_text or "")[:1200]
            validator_retry_hint = (
                "\n\n## ⚠️ 上一次输出被校验拒绝（请精确修复，别重写整份计划）\n"
                f"### 违规清单\n{violations_md}\n\n"
                "### 上次输出片段（请基于这个 80% 的版本只修复违规）\n"
                f"```\n{attempt_excerpt}\n```\n\n"
                "**修复要点**：保留有效字段；只针对违规清单逐条改；"
                "primary_pattern 必须是 14 个枚举里的纯名称（不要反引号、不要引号）；"
                "anchor_zone 一个场景写一个值（如 'B3-E5'，不要写多个）；"
                "两个 transform 场景要分时显示 → 用不同 anchor_zone。"
            )

        prompt = self._prompts.render(
            "visual_plan",
            grade=grade,
            problem=problem,
            analysis_section=analysis_section,
            solution_section=solution_section,
            patterns_section=patterns_section + replan_hint + validator_retry_hint,
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.4,
                # 6144: even with thinking off, retry attempts include
                # the previous attempt + violation list, which extends the
                # input. Output also pads up when the model writes the
                # essence_rationale paragraph carefully. 6K leaves comfort.
                max_tokens=6144,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception as exc:
            logger.exception("visual_plan LLM call failed")
            return ToolResult(success=False, summary="视觉规划失败", error=str(exc))

        plan = _parse_plan(done)
        if plan is None:
            text = getattr(done, "text", "") or ""
            reasoning = getattr(done, "reasoning", "") or ""
            finish = getattr(done, "finish_reason", "?")
            logger.warning(
                "visual_plan: parse failed | finish=%s text_len=%d "
                "reasoning_len=%d text_head=%r reasoning_head=%r",
                finish, len(text), len(reasoning),
                text[:200], reasoning[:200],
            )
            # finish_reason='length' = max_tokens hit before model could emit
            # the final structured answer. Surface a clearer summary so the
            # agent loop can either retry with a tighter prompt or give up
            # gracefully (and so the user can see in the timeline what went
            # wrong).
            if str(finish).lower() == "length":
                summary = "视觉规划被 max_tokens 截断，重试或简化输入"
            else:
                summary = "无法从模型输出解析「## 视觉计划」section"
            return ToolResult(
                success=False,
                summary=summary,
                error="parse_failed",
                data={
                    "finish_reason": finish,
                    "text_head": text[:600],
                    "reasoning_head": reasoning[:600],
                },
            )

        prev_plan = ctx.state.get("visual_plan") or {}
        prev_pattern = prev_plan.get("primary_pattern", "")
        is_replan = bool(ctx.state.get("last_visual_failed")) and bool(prev_pattern)

        violations = _validate_plan(
            plan, grade, previous_pattern=prev_pattern, is_replan=is_replan
        )
        if violations:
            # Persist what failed + raw text so the *next* visual_plan call
            # can include them in the prompt (rather than re-prompting from
            # scratch, which leads to the same failure mode again and again).
            ctx.state["visual_plan_last_violations"] = violations
            ctx.state["visual_plan_last_attempt"] = (
                getattr(done, "text", "") or getattr(done, "reasoning", "") or ""
            )[:2000]
            retry_count = int(ctx.state.get("visual_plan_retry_count", 0)) + 1
            ctx.state["visual_plan_retry_count"] = retry_count

            # Budget control: after N attempts, give up and let the agent
            # proceed without a visual_plan (degraded mode handled by the
            # caller / prompt_composer workflow).
            BUDGET = 3
            if retry_count >= BUDGET:
                logger.warning(
                    "visual_plan: %d failed attempts, giving up. last violations: %s",
                    retry_count, violations,
                )
                return ToolResult(
                    success=False,
                    summary=(
                        f"视觉计划连续 {retry_count} 次违反硬约束，已放弃。"
                        f"agent 应直接调 generate_manim_code（无 visual_plan）继续。"
                        f"最后违规：{'；'.join(violations[:2])}"
                    ),
                    data={"plan": plan, "violations": violations, "exhausted": True},
                    error="visual_plan_budget_exhausted",
                )

            return ToolResult(
                success=False,
                summary=(
                    f"视觉计划违反硬约束（第 {retry_count}/{BUDGET} 次）："
                    + "；".join(violations[:3])
                ),
                data={"plan": plan, "violations": violations, "retry_count": retry_count},
                error="contract_violation",
            )

        # Reset retry counter on success
        ctx.state["visual_plan_retry_count"] = 0
        ctx.state["visual_plan_last_violations"] = []
        ctx.state["visual_plan_last_attempt"] = ""

        # Persist for downstream tools.
        ctx.state["visual_plan"] = plan
        ctx.state["visual_pattern"] = plan["primary_pattern"]
        ctx.state["essence_rationale"] = plan.get("essence_rationale") or ""
        ctx.state["last_visual_failed"] = False  # reset so generate sees a clean slate

        scenes_summary = ", ".join(
            f"{s['role']}({(s.get('key_objects') or '')[:12]})" for s in plan["scenes"]
        )
        rationale_preview = (plan.get("essence_rationale") or "")[:50]
        return ToolResult(
            success=True,
            summary=(
                f"视觉计划：{plan['primary_pattern']}"
                + (f" + {plan['secondary_pattern']}" if plan["secondary_pattern"] else "")
                + f"，{len(plan['scenes'])} 场景"
                + (f"；本质：{rationale_preview}…" if rationale_preview else "")
            ),
            data=plan,
        )
