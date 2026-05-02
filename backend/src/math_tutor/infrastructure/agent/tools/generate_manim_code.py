"""
generate_manim_code — produce / fix Manim code with full visualization rules.

Static rules live in `prompt_templates/generate_manim.md`. Per-call we
assemble the conditional sections (skill / pattern / examples / fix mode)
in Python and inject them into the template's `{slot}` placeholders.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ISkillRepository,
    ITool,
    ToolContext,
    ToolResult,
)
from ...storage import ExamplesStore
from ..learned_memory import LearnedMemory
from ..prompt_library import PromptLibrary
from .. import scope_refine as sref

logger = logging.getLogger(__name__)


_LATEX_OFF = (
    "系统未安装 LaTeX，**严禁使用 MathTex / Tex / Matrix**，"
    "所有公式用 Text 表示。"
)
_LATEX_ON = "已安装 LaTeX。可使用 MathTex 显示英文公式；中文仍推荐 Text。"


# 通用原则（适用所有年级）：用数形结合 + 第一性原理揭示数学本质。
# 抽象工具（方程/积分/向量）允许使用，但必须配几何锚点（天平/面积/数轴/坐标系）。
# 下面只是各年级的 *视觉细节* 偏好。
_GRADE_HINT: dict[str, str] = {
    "elementary_lower": (
        "小学低年级：用具象单位（苹果/动物/糖果），颜色明亮可爱；"
        "图形数量 ≥ 文字数量；演示一定要慢、可数"
    ),
    "elementary_upper": (
        "小学高年级：线段图、列表、面积模型、阵列；"
        "鸡兔同笼用假设法抬腿动画；用图形揭示数量关系比纯代数推导更直观"
    ),
    "middle": (
        "初中：双面板（几何+代数同步）、坐标图象、几何变换；"
        "解方程时配天平/面积模型；不要让屏幕只有公式行"
    ),
    "high": (
        "高中：函数图象、参数扫描、覆盖逼近、向量箭头、坐标变换；"
        "三角函数用单位圆 + 旋转角度同步图象；导数用切线斜率随点移动"
    ),
    "advanced": (
        "大学及以上：矩阵=空间扭曲、积分=矩形条求和的极限、复数=旋转；"
        "**最容易掉进纯符号陷阱**——每一步代数都要配几何同步"
    ),
}


def _format_steps(steps: list[dict[str, Any]] | Any) -> str:
    if not steps:
        return "（未提供）"
    # Defensive: solve_problem normally writes list[dict], but bad parsing or
    # a malformed JSON fallback could leave us with list[str] / str / dict.
    # Coerce gracefully so we never crash here.
    if isinstance(steps, str):
        return steps[:1000]  # take it as a single pre-formatted block
    if isinstance(steps, dict):
        steps = [steps]
    if not isinstance(steps, list):
        return "（步骤格式异常，无法解析）"
    lines = []
    for i, s in enumerate(steps):
        if isinstance(s, str):
            lines.append(f"{i + 1}. {s}")
            continue
        if not isinstance(s, dict):
            lines.append(f"{i + 1}. {s!r}")
            continue
        n = s.get("step_number", i + 1)
        desc = s.get("description") or ""
        op = s.get("operation") or ""
        res = s.get("result") or ""
        line = f"{n}. {desc} | 运算: {op} | 结果: {res}".rstrip(" |")
        lines.append(line)
    return "\n".join(lines)


def _extract_code(content: str) -> str:
    match = re.search(r"```python\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    match = re.search(r"```\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    return content.strip()


def _sanitize_code(code: str) -> str:
    code = re.sub(r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)", "", code)
    for color in (
        "ORANGE_E",
        "BLUE_D",
        "BLUE_E",
        "RED_A",
        "GREEN_E",
        "GREEN_D",
        "YELLOW_E",
    ):
        code = re.sub(rf"\b{color}\b", "BLUE", code)
    return code


def _extract_manim_code_with_fallback(done: Any) -> tuple[str, str]:
    """Try done.text first; if no `from manim` showing up, also scan
    done.reasoning. Returns (code, source_label)."""
    candidates: list[tuple[str, str]] = []
    if getattr(done, "text", ""):
        candidates.append(("text", done.text))
    if getattr(done, "reasoning", ""):
        candidates.append(("reasoning", done.reasoning))
    for label, content in candidates:
        code = _sanitize_code(_extract_code(content))
        if code and "from manim" in code:
            return code, label
    return "", "none"


def _format_bad_notes(items: Any) -> str:
    if not isinstance(items, list):
        return ""
    lines: list[str] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        problem = (it.get("problem") or "")
        problem = problem.strip() if isinstance(problem, str) else ""
        notes = (it.get("notes") or "")
        notes = notes.strip() if isinstance(notes, str) else ""
        tags = it.get("tags") or []
        tag_str = ",".join(tags) if isinstance(tags, list) else ""
        line = f"- 题目「{problem[:40]}」"
        if tag_str:
            line += f"（标签：{tag_str}）"
        if notes:
            line += f"：{notes[:200]}"
        lines.append(line)
    return "\n".join(lines)


class GenerateManimCodeTool(ITool):
    def __init__(
        self,
        *,
        llm: ILLMProvider,
        skill_repo: ISkillRepository,
        prompts: PromptLibrary,
        use_latex: bool,
        examples_store: ExamplesStore | None = None,
        learned_memory: LearnedMemory | None = None,
    ) -> None:
        self._llm = llm
        self._skill_repo = skill_repo
        self._prompts = prompts
        self._use_latex = use_latex
        self._examples_store = examples_store
        self._learned_memory = learned_memory

    @property
    def name(self) -> str:
        return "generate_manim_code"

    @property
    def description(self) -> str:
        return (
            "生成或修复 Manim 可视化代码。如果传入 previous_code + error_hint，"
            "则按修复模式工作（最小改动消除错误并保持教学逻辑）。否则按生成模式。"
            "调用前请确保已得到 solution_steps 和 answer（或先调用 solve_problem）。"
            "可以传入 skill_template 或 good_example_code 作为参考。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文"},
                "grade": {"type": "string", "description": "学生年级"},
                "solution_steps": {
                    "type": "array",
                    "description": "解题步骤数组，每项含 description / operation / result",
                    "items": {"type": "object"},
                },
                "answer": {"type": "string", "description": "最终答案"},
                "skill_template": {"type": "string"},
                "skill_code_template": {"type": "string"},
                "good_example_code": {"type": "string"},
                "bad_example_note": {"type": "string"},
                "previous_code": {"type": "string"},
                "error_hint": {"type": "string"},
                "extra_instructions": {"type": "string"},
                "fix_scope": {
                    "type": "string",
                    "enum": ["line", "block", "global"],
                    "description": "（可选）显式覆盖修复 scope；缺省自动从 error_hint 分类。"
                                   "line=只改 ±1 行，block=改一个 Phase/method 段，global=整文件重写",
                },
            },
            "required": ["problem", "grade", "solution_steps", "answer"],
        }

    async def _do_scoped_fix(
        self,
        *,
        fix_scope: sref.Scope,
        previous_code: str,
        error_hint: str,
        ctx: ToolContext,
    ) -> str | None:
        """Surgically fix a region of the code without re-prompting from
        scratch. Returns the patched full code, or None if the fix didn't
        produce something usable (caller should fall back to global)."""
        line_no = sref.extract_error_line(error_hint)
        if line_no is None:
            # Without a clear line number, line-scope fix is impossible;
            # block-scope falls back to the file center as a worst case.
            if fix_scope == "line":
                return None
            line_no = max(1, len(previous_code.split("\n")) // 2)

        if fix_scope == "line":
            snippet, lo, hi = sref.extract_line_context(
                previous_code, line_no=line_no, radius=1
            )
            instr = (
                "你是 Manim 代码修复器。下面是出错代码的 `±1 行片段`，"
                "**只修复其中的语法/调用错误**，不要重写其它内容。\n\n"
                f"### 错误信息\n{error_hint.strip()[:1000]}\n\n"
                f"### 出错片段（行 {lo}-{hi}）\n```python\n{snippet}\n```\n\n"
                "**直接输出修复后的同一段 Python 代码块**（行数尽量保持不变；"
                "如果必须增减一行，可以接受），用 ```python``` 包起来。"
                "不要解释、不要输出整文件。"
            )
            max_tokens = 512
        else:  # block
            block_text, lo, hi = sref.extract_enclosing_block(
                previous_code, line_no=line_no
            )
            instr = (
                "你是 Manim 代码修复器。下面是出错代码的 `一个 Phase/method 块`，"
                "**只在这个块内修改**，让它满足下面的错误提示。块外代码已经"
                "正常，请不要重写。\n\n"
                f"### 错误信息\n{error_hint.strip()[:1500]}\n\n"
                f"### 出错块（行 {lo}-{hi}）\n```python\n{block_text}\n```\n\n"
                "**直接输出修复后的整段块代码**（保持开头/结尾的 Phase 注释或"
                "缩进风格不变），用 ```python``` 包起来。不要输出整文件。"
            )
            max_tokens = 1536

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=instr)],
                temperature=0.2,
                max_tokens=max_tokens,
            )
        except Exception:
            logger.exception("scope_refine LLM call failed")
            return None

        snippet_out = _extract_code(getattr(done, "text", "") or "")
        if not snippet_out:
            snippet_out = _extract_code(getattr(done, "reasoning", "") or "")
        if not snippet_out.strip():
            return None

        snippet_out = _sanitize_code(snippet_out)
        patched = sref.splice_lines(
            previous_code, start_line=lo, end_line=hi, replacement=snippet_out
        )

        # Sanity: must still be valid Python; otherwise fall back
        try:
            compile(patched, "<scoped_fix>", "exec")
        except SyntaxError as exc:
            logger.info(
                "scope_refine: patched code still has syntax error %s; falling back",
                exc,
            )
            return None

        return patched

    async def _resolve_examples(
        self,
        ctx: ToolContext,
        explicit_good: str | None,
        explicit_bad: str | None,
    ) -> tuple[str | None, str | None]:
        good = explicit_good
        bad = explicit_bad

        if good is None:
            recent_good = ctx.state.get("recent_good_examples") or []
            if isinstance(recent_good, list) and recent_good:
                first = recent_good[0]
                if isinstance(first, dict):
                    good = first.get("manim_code")

        if bad is None:
            recent_bad = ctx.state.get("recent_bad_examples") or []
            if isinstance(recent_bad, list) and recent_bad:
                bad = _format_bad_notes(recent_bad)

        if (good is None or bad is None) and self._examples_store is not None:
            try:
                if good is None:
                    hits = await self._examples_store.search_by_keywords(
                        ctx.problem, label="good", grade=ctx.grade, top_k=1
                    )
                    if hits:
                        good = hits[0].manim_code
                if bad is None:
                    hits = await self._examples_store.search_by_keywords(
                        ctx.problem, label="bad", grade=ctx.grade, top_k=2
                    )
                    if hits:
                        bad_state = [
                            {
                                "id": h.id,
                                "problem": h.problem,
                                "manim_code": h.manim_code,
                                "tags": h.tags,
                                "notes": h.notes,
                            }
                            for h in hits
                        ]
                        bad = _format_bad_notes(bad_state)
            except Exception:
                logger.exception("auto-fetch examples failed (session=%s)", ctx.session_id)
        return good, bad

    def _build_user_message(
        self,
        *,
        problem: str,
        grade: str,
        solution_steps: list[dict[str, Any]] | None,
        answer: str,
        previous_code: str | None,
        error_hint: str | None,
        extra: str | None,
    ) -> str:
        parts = [
            "### 题目",
            problem.strip() or "（缺失）",
            f"\n年级: {grade}",
            "\n### 解题步骤",
            _format_steps(solution_steps),
            f"\n### 最终答案\n{answer.strip() or '（缺失）'}",
        ]
        if previous_code:
            parts.append(
                "\n### 上一次生成的代码（修复其中的错误）\n"
                f"```python\n{previous_code.strip()[:5000]}\n```"
            )
        if error_hint:
            parts.append(f"\n### 上一次的错误信息\n{error_hint.strip()[:2000]}")
        if extra:
            parts.append(f"\n### 额外指引\n{extra.strip()}")
        return "\n".join(parts)

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        solution_steps = (
            args.get("solution_steps")
            or ctx.state.get("solution_steps")
            or []
        )
        answer = args.get("answer") or ctx.state.get("solution_answer") or ""

        if not solution_steps:
            return ToolResult(
                success=False,
                summary="缺少解题步骤——请先调用 solve_problem 工具",
                error="missing_solution_steps",
            )

        previous_code = (
            args.get("previous_code") or ctx.state.get("latest_manim_code") or ""
        )
        # Pull error hints from multiple state sources in priority order:
        # explicit args → run_manim error → inspect_video visual issues
        error_hint = (
            args.get("error_hint")
            or ctx.state.get("last_run_error")
            or ctx.state.get("last_visual_issues")
            or ""
        )
        # Defensive: state values can occasionally be non-strings (e.g. dict
        # serialized from an earlier crash payload). Coerce to str so the
        # later .strip()/[:N] calls don't AttributeError.
        if not isinstance(previous_code, str):
            previous_code = str(previous_code) if previous_code else ""
        if not isinstance(error_hint, str):
            error_hint = str(error_hint) if error_hint else ""
        is_fix_mode = bool(previous_code and error_hint)

        # ---- ScopeRefine: decide if we should attempt a small-scope fix ----
        # Three tiers: line / block / global. Smaller is faster & cheaper but
        # risks getting stuck on hard errors. We auto-classify the error and
        # honor an explicit `fix_scope` arg override. Attempts are tracked in
        # state so we can escalate after K failures at one tier.
        fix_scope: sref.Scope = "global"
        if is_fix_mode:
            attempts = dict(ctx.state.get("fix_attempt_count") or {})
            requested = (args.get("fix_scope") or "").strip().lower()
            if requested in {"line", "block", "global"}:
                fix_scope = requested  # type: ignore[assignment]
            else:
                err_source = ctx.state.get("last_error_source") or "run"
                inferred = sref.classify_error_scope(
                    error_hint, source=err_source if err_source in ("validate", "run", "inspect") else "run"
                )
                # Escalate if we've already used up budget at the inferred tier
                escalated = sref.next_scope(inferred, attempts_so_far=attempts)
                if escalated is None:
                    # Budget exhausted → tell caller to replan visually
                    return ToolResult(
                        success=False,
                        summary="所有修复 scope 预算耗尽，需要重走 visual_plan",
                        error="fix_budget_exhausted",
                        data={"attempts": attempts, "last_error": error_hint[:300]},
                    )
                fix_scope = escalated
            attempts[fix_scope] = attempts.get(fix_scope, 0) + 1
            ctx.state["fix_attempt_count"] = attempts
            ctx.state["last_fix_scope"] = fix_scope

        # Fast path: line/block scope — surgically replace a small region
        # without re-rendering the whole prompt. ~3-5× cheaper, finishes in
        # 5-15s on a 35B local model instead of 30-60s.
        if is_fix_mode and fix_scope in ("line", "block"):
            patched = await self._do_scoped_fix(
                fix_scope=fix_scope,
                previous_code=previous_code,
                error_hint=error_hint,
                ctx=ctx,
            )
            if patched is not None:
                ctx.state["latest_manim_code"] = patched
                logger.info(
                    "scope_refine: %s-fix succeeded for session %s",
                    fix_scope, ctx.session_id,
                )
                return ToolResult(
                    success=True,
                    summary=f"已通过 {fix_scope}-scope 局部修复",
                    data={"code": patched, "fix_scope": fix_scope},
                    artifacts=[
                        ArtifactSpec(
                            kind="manim_code",
                            content=patched,
                            meta={"fix_scope": fix_scope},
                        ),
                    ],
                )
            # Falls through to global path if the scoped fix returned None
            logger.info(
                "scope_refine: %s-fix failed, falling through to global",
                fix_scope,
            )
            ctx.state["last_fix_scope"] = "global"

        skill_template = (
            args.get("skill_template") or ctx.state.get("matched_skill_prompt")
        )
        skill_code_template = (
            args.get("skill_code_template") or ctx.state.get("matched_skill_code_template")
        )
        good_example_code, bad_example_note = await self._resolve_examples(
            ctx,
            explicit_good=args.get("good_example_code"),
            explicit_bad=args.get("bad_example_note"),
        )
        pattern_codes = ctx.state.get("matched_patterns") or None
        visual_plan = ctx.state.get("visual_plan") or None
        extra = args.get("extra_instructions")

        # ---- assemble template slot strings ---------------------------------
        latex_section = _LATEX_ON if self._use_latex else _LATEX_OFF
        grade_section = _GRADE_HINT.get(grade, _GRADE_HINT["elementary_upper"])

        learned_rules_section = ""
        if self._learned_memory is not None:
            rules = self._learned_memory.read().strip()
            if rules:
                learned_rules_section = (
                    "## 沉淀规则（基于历史反馈，必须遵守）\n" + rules
                )

        # Visual plan dominates: it's the explicit director's intent. Codes
        # ignoring it = degeneration. We always emit it when present. We also
        # type-guard each scene because a JSON-fallback parse can leave us
        # with list[str] instead of list[dict].
        visual_plan_section = ""
        if isinstance(visual_plan, dict):
            scenes_raw = visual_plan.get("scenes") or []
            scene_lines = []
            for i, s in enumerate(scenes_raw, start=1):
                if not isinstance(s, dict):
                    scene_lines.append(f"  场景 {i}: {s!r}")
                    continue
                scene_lines.append(
                    f"  场景 {i} ({s.get('role', '?')}, zone {s.get('anchor_zone', '?')}) — "
                    f"key_objects: {(s.get('key_objects') or '')[:80]}; "
                    f"action: {(s.get('action') or '')[:80]}; "
                    f"invariant: {(s.get('invariant') or '')[:60]}"
                )
            forbidden = visual_plan.get("forbidden") or []
            forbidden = forbidden if isinstance(forbidden, list) else []
            forbidden_lines = "\n".join(
                f"  - {x}" for x in forbidden[:6]
            )
            secondary = visual_plan.get("secondary_pattern") or ""
            essence = (visual_plan.get("essence_rationale") or "")
            essence = essence.strip() if isinstance(essence, str) else ""

            # essence_rationale comes FIRST in the section: it's the
            # north-star. Every animation choice must serve this.
            visual_plan_section = (
                "## 视觉计划（来自 visual_plan，**严格遵照**）\n"
                + (
                    "### ⭐ 本质（essence_rationale，所有动画必须服务于这条）\n"
                    f"> {essence}\n\n"
                    "**写代码时反复回看这条**：每一个 self.play(...) / Transform / "
                    "动画的目的都应该是让观众看到上述的不变量/对应/守恒/变换。"
                    "如果某段动画与这条 rationale 无关，就删掉。\n\n"
                    if essence
                    else ""
                )
                + f"primary_pattern: **{visual_plan.get('primary_pattern', '?')}**"
                + (f" + {secondary}" if secondary else "")
                + "\n\n场景脚本：\n"
                + "\n".join(scene_lines)
                + "\n\n禁用反模式：\n"
                + forbidden_lines
                + "\n\n**这份计划是硬约束**：必须有 role=transform 场景；"
                "anchor_zone 必须遵守（每个场景的元素只能落在该 zone 内）；"
                "不允许把 action 退化成纯 Text 切换；key_objects 必须真的出现在画面里。"
            )

        skill_section = ""
        if skill_code_template:
            skill_section = (
                "## 已匹配的技能代码模板（首选骨架，复制其结构、只改数值与文字）\n"
                f"```python\n{skill_code_template.strip()}\n```"
            )
        elif skill_template:
            skill_section = (
                "## 已匹配的技能 prompt 模板（请按此可视化逻辑实现）\n"
                + skill_template.strip()
            )

        pattern_section = ""
        if isinstance(pattern_codes, list) and pattern_codes:
            chunks = ["## 可复用的可视化模式（已匹配，可直接调用其中的辅助函数）"]
            for p in pattern_codes:
                if not isinstance(p, dict):
                    continue
                pname = p.get("name") or ""
                pdesc = p.get("description") or ""
                pcode = p.get("core_code") or ""
                pcode = pcode.strip() if isinstance(pcode, str) else ""
                if not pcode:
                    continue
                chunks.append(
                    f"\n### {pname}：{pdesc}\n```python\n{pcode[:2200]}\n```"
                )
            if len(chunks) > 1:
                pattern_section = "\n".join(chunks)

        good_example_section = ""
        if good_example_code:
            good_example_section = (
                "## 历史 good 样本代码（仅作参考，不要照抄场景细节）\n"
                f"```python\n{good_example_code.strip()[:1800]}\n```"
            )

        bad_example_section = ""
        if bad_example_note:
            bad_example_section = (
                "## 警示：避免下列失败模式（来自标记为 bad 的样本）\n"
                + bad_example_note.strip()
            )

        fix_mode_section = ""
        if is_fix_mode:
            fix_mode_section = (
                "## 当前是修复模式\n"
                "保留原有教学逻辑，只针对错误信息做最小修改。"
                "若错误是禁用对象（Sector 等），用 Arc + Line 重写。"
                "若错误是 LaTeX，将所有 MathTex/Tex 替换为 Text。"
            )

        user_message = self._build_user_message(
            problem=problem,
            grade=grade,
            solution_steps=solution_steps,
            answer=answer,
            previous_code=previous_code,
            error_hint=error_hint,
            extra=extra,
        )

        prompt = self._prompts.render(
            "generate_manim",
            latex_section=latex_section,
            grade_section=grade_section,
            learned_rules_section=learned_rules_section,
            visual_plan_section=visual_plan_section,
            skill_section=skill_section,
            pattern_section=pattern_section,
            good_example_section=good_example_section,
            bad_example_section=bad_example_section,
            fix_mode_section=fix_mode_section,
            user_message=user_message,
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.4,
                # 3K 已足够：教学动画 200-600 行代码就够，更大只会让模型凑长度。
                # 真的需要更大可以在 fix 模式时单独放宽（见下）。
                max_tokens=4096 if is_fix_mode else 3072,
            )
        except Exception as exc:
            logger.exception("generate_manim_code LLM call failed")
            return ToolResult(success=False, summary="代码生成失败", error=str(exc))

        code, code_source = _extract_manim_code_with_fallback(done)
        if not code:
            logger.warning(
                "generate_manim_code: no code found | finish=%s text_len=%d "
                "reasoning_len=%d text_head=%r reasoning_head=%r",
                getattr(done, "finish_reason", "?"),
                len(getattr(done, "text", "") or ""),
                len(getattr(done, "reasoning", "") or ""),
                (getattr(done, "text", "") or "")[:300],
                (getattr(done, "reasoning", "") or "")[:300],
            )
            return ToolResult(
                success=False,
                summary="模型返回内容中找不到合法的 Manim 代码",
                error="no_code",
                data={
                    "raw_text": (done.text or "")[:800],
                    "raw_reasoning": (done.reasoning or "")[:800],
                    "finish_reason": getattr(done, "finish_reason", None),
                },
            )
        if code_source == "reasoning":
            logger.warning("generate_manim_code fell back to reasoning channel")

        ctx.state["latest_manim_code"] = code
        ctx.state["last_validation_passed"] = False  # validate must be re-run

        filename = f"code-turn{ctx.turn_index:02d}.py"
        artifacts = [
            ArtifactSpec(
                kind="manim_code",
                filename=filename,
                content=code,
                meta={
                    "mode": "fix" if is_fix_mode else "generate",
                    "turn_index": ctx.turn_index,
                    "code_source": code_source,
                },
            )
        ]

        return ToolResult(
            success=True,
            summary=(
                f"已{'修复' if is_fix_mode else '生成'}代码 {len(code)} 字符，"
                "请下一步调用 validate_manim_code"
            ),
            data={
                "code": code,
                "length": len(code),
                "mode": "fix" if is_fix_mode else "generate",
                "filename": filename,
                "code_source": code_source,
            },
            artifacts=artifacts,
        )
