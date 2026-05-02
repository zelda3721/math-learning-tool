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

logger = logging.getLogger(__name__)


_LATEX_OFF = (
    "系统未安装 LaTeX，**严禁使用 MathTex / Tex / Matrix**，"
    "所有公式用 Text 表示。"
)
_LATEX_ON = "已安装 LaTeX。可使用 MathTex 显示英文公式；中文仍推荐 Text。"


_GRADE_HINT: dict[str, str] = {
    "elementary_lower": "小学低年级：用苹果、小动物等具象单位；禁止方程；动画风格生动",
    "elementary_upper": "小学高年级：优先假设法/列表法/画图分析；鸡兔同笼必须用假设法",
    "middle": "初中：可用代数方程、函数图像、几何证明",
    "high": "高中：以初等数学为主，可用坐标系、向量、分类讨论",
    "advanced": "大学及以上：可用微积分、线性代数、动态图",
}


def _format_steps(steps: list[dict[str, Any]] | None) -> str:
    if not steps:
        return "（未提供）"
    lines = []
    for i, s in enumerate(steps):
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


def _format_bad_notes(items: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for it in items:
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
            },
            "required": ["problem", "grade", "solution_steps", "answer"],
        }

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
            if recent_good:
                good = recent_good[0].get("manim_code")

        if bad is None:
            recent_bad = ctx.state.get("recent_bad_examples") or []
            if recent_bad:
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
        is_fix_mode = bool(previous_code and error_hint)

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
        if pattern_codes:
            chunks = ["## 可复用的可视化模式（已匹配，可直接调用其中的辅助函数）"]
            for p in pattern_codes:
                pname = p.get("name") or ""
                pdesc = p.get("description") or ""
                pcode = (p.get("core_code") or "").strip()
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
                max_tokens=8192,
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
