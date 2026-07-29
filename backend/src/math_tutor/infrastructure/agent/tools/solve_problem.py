"""solve_problem — produce a structured solution before code generation.

Output is markdown with `## 解题`, `**字段**: 值`, and `### 第 N 步` sub-sections.
JSON output is accepted as a fallback.
"""
from __future__ import annotations

import json
import logging
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

_DRAFT_CORRECTION_MARKERS = (
    "重新检查",
    "重新核算",
    "再核算",
    "让我重新",
    "等等",
    "此处需",
    "可能算错",
    "可能错误",
)


_GRADE_GUIDANCE: dict[str, str] = {
    "elementary_lower": (
        "使用该年龄已经掌握的语言和运算；每一步只引入一个新关系，解释所有符号。"
    ),
    "elementary_upper": (
        "选择该年龄能解释且步骤最少的有效推理；先说明关系，再执行运算，避免无解释的符号跳步。"
    ),
    "middle": (
        "允许标准代数和几何语言；明确变量定义、等价变形的依据和适用条件。"
    ),
    "high": (
        "给出关键推理依据、定义域与边界；区分等价推导、充分条件和必要条件。"
    ),
    "advanced": (
        "明确使用的定义、定理、假设和边界情况；优先可验证且逻辑闭合的推导。"
    ),
}


def _parse_solution(done: Any) -> dict[str, Any] | None:
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        if not source:
            continue
        section = md.find_section(source, "解题", level=2) or md.find_section(
            source, "解题"
        )
        if section is not None:
            payload = _md_to_solution(section)
            if payload.get("steps"):
                return payload
        # JSON fallback
        json_payload = md.parse_json_anywhere(source)
        if json_payload and isinstance(json_payload.get("steps"), list):
            return json_payload
    return None


def _md_to_solution(section: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "strategy": md.get_field(section, "策略", "strategy"),
        "answer": md.get_field(section, "最终答案", "answer", "答案"),
        "visualization_hint": "",
    }

    # Steps: every `### 第 N 步` (or `### Step N`) sub-section
    steps: list[dict[str, Any]] = []
    for i, (heading, body) in enumerate(md.find_subsections(section, level=3), start=1):
        h_lower = heading.lower()
        if not (
            "步" in heading
            or h_lower.startswith("step")
            or h_lower.startswith("step ")
        ):
            continue
        kv = md.get_kv_dict(body)
        # Be tolerant of various key spellings
        steps.append({
            "step_number": i,
            "description": _pick(kv, "描述", "description"),
            "operation": _pick(kv, "运算", "operation"),
            "explanation": _pick(kv, "解释", "explanation"),
            "result": _pick(kv, "结果", "result"),
        })
    payload["steps"] = steps

    # Optional sections
    kp_section = md.find_section(section, "教学要点") or md.find_section(
        section, "key_points"
    )
    payload["key_points"] = md.get_bullets(kp_section)

    viz_hint_section = md.find_section(section, "可视化提示") or md.find_section(
        section, "visualization_hint"
    )
    if viz_hint_section:
        payload["visualization_hint"] = viz_hint_section.strip()

    return payload


def _pick(d: dict[str, str], *keys: str) -> str:
    lowered = {k.lower(): v for k, v in d.items()}
    for k in keys:
        v = lowered.get(k.lower())
        if v:
            return v
    return ""


def _solution_contract_issues(payload: dict[str, Any]) -> list[str]:
    """Reject draft-like self-correction before it reaches verification.

    This is content-agnostic: it does not infer a problem type or expected
    answer. It only enforces that the submitted contract is a single settled
    solution rather than a visible scratchpad with mutually competing claims.
    """
    texts = [str(payload.get("answer") or "")]
    for step in payload.get("steps") or []:
        if not isinstance(step, dict):
            continue
        texts.extend(
            str(step.get(field) or "")
            for field in ("description", "operation", "explanation", "result")
        )
    joined = "\n".join(texts)
    return [
        f"解答仍包含草稿式自我纠错标记“{marker}”"
        for marker in _DRAFT_CORRECTION_MARKERS
        if marker in joined
    ][:3]


class SolveProblemTool(ITool):
    def __init__(self, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "solve_problem"

    @property
    def description(self) -> str:
        return (
            "对数学题做结构化解题，返回 strategy/steps/answer/key_points/"
            "visualization_hint。**必须**在 generate_manim_code 之前调用，"
            "否则代码生成的解题逻辑会和题目脱节。可以同时附带 analyze_problem "
            "的分析结果作为辅助。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文"},
                "grade": {"type": "string", "description": "学生年级"},
                "analysis_hint": {
                    "type": "string",
                    "description": "（可选）来自 analyze_problem 的分析结果，会拼到上下文",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        analysis_hint = args.get("analysis_hint") or ""
        if not problem:
            return ToolResult(success=False, summary="缺少题目", error="empty_problem")

        if not analysis_hint:
            saved = ctx.state.get("analysis")
            if saved:
                try:
                    analysis_hint = json.dumps(saved, ensure_ascii=False, indent=2)
                except Exception:
                    analysis_hint = ""

        analysis_section = (
            f"\n## 已有分析（参考）\n{analysis_hint}\n" if analysis_hint else ""
        )
        verify_failure = str(ctx.state.get("last_verify_failure") or "").strip()
        if verify_failure:
            analysis_section += (
                "\n## 上一版解答的验证失败证据\n"
                f"{verify_failure[:600]}\n"
                "必须修正导致该证据的推理或答案，不要原样重复上一版。\n"
            )
        guidance = _GRADE_GUIDANCE.get(grade, _GRADE_GUIDANCE["elementary_upper"])

        prompt = self._prompts.render(
            "solve",
            grade=grade,
            problem=problem,
            grade_guidance=guidance,
            analysis_section=analysis_section,
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.3,
                max_tokens=6144,
                # Structured markdown output (## 解题 + 步骤)。Solve does
                # benefit a bit from thinking, but the markdown template is
                # already itself a "structured chain of thought", so we give
                # the budget to the actual answer instead.
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception as exc:
            logger.exception("solve_problem LLM call failed")
            return ToolResult(success=False, summary="解题调用失败", error=str(exc))

        payload = _parse_solution(done)
        if payload is None:
            logger.warning(
                "solve_problem: no parseable markdown/JSON | finish=%s "
                "text_len=%d reasoning_len=%d text_head=%r reasoning_head=%r",
                getattr(done, "finish_reason", "?"),
                len(getattr(done, "text", "") or ""),
                len(getattr(done, "reasoning", "") or ""),
                (getattr(done, "text", "") or "")[:200],
                (getattr(done, "reasoning", "") or "")[:200],
            )
            return ToolResult(
                success=False,
                summary="无法从模型输出解析「## 解题」section",
                error="parse_failed",
                data={
                    "raw_text": (done.text or "")[:600],
                    "raw_reasoning": (done.reasoning or "")[:600],
                    "finish_reason": getattr(done, "finish_reason", None),
                },
            )

        steps = payload.get("steps") or []
        if not steps:
            return ToolResult(
                success=False,
                summary="解题步骤为空",
                error="empty_steps",
                data=payload,
            )

        contract_issues = _solution_contract_issues(payload)
        if contract_issues:
            ctx.state["last_solve_contract_issues"] = contract_issues
            return ToolResult(
                success=False,
                summary="解答不是可交付的一致版本：" + "；".join(contract_issues),
                error="solution_contract_violation",
                data={"issues": contract_issues},
            )

        ctx.state["solution"] = payload
        ctx.state["solution_steps"] = steps
        ctx.state["solution_answer"] = payload.get("answer", "")
        ctx.state["solution_verified"] = False
        ctx.state.pop("last_solve_contract_issues", None)
        ctx.state.pop("last_verify_failure", None)
        for key in (
            "visual_plan", "visual_thesis", "latest_manim_code",
            "latest_video_path", "latest_video_url", "last_visual_review",
        ):
            ctx.state.pop(key, None)

        n = len(steps)
        ans = payload.get("answer") or "(无答案)"
        return ToolResult(
            success=True,
            summary=f"解题完成：{payload.get('strategy') or '未指定策略'}，{n} 步，答案：{ans}",
            data=payload,
        )
