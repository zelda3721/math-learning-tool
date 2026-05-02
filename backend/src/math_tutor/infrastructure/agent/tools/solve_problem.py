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


# 通用原则适用所有年级：用数形结合 + 第一性原理揭示数学本质，让学生看到
# "为什么成立"。方程/积分等抽象工具允许使用，但策略选择应优先考虑哪个
# 解法最能"揭示原理"，而不仅是"得到答案"。下面只是各年级的 *视觉细节*
# 偏好——硬规则在通用原则。
_GRADE_GUIDANCE: dict[str, str] = {
    "elementary_lower": (
        "小学低年级（1-3）：用具象单位（苹果、糖果、小动物）和颜色明亮的图形；"
        "推荐画图法、实物演示、凑十法、逐步数数；语言简单。"
        "代数方程不必出现在解题策略里，但天平/等量代换的图形思想是欢迎的。"
    ),
    "elementary_upper": (
        "小学高年级（4-6）：典型工具是线段图、列表法、画图分析、假设法；"
        "鸡兔同笼用假设法（抬腿动画）。代数方程允许出现，"
        "但要选'最能揭示原理'的解法——通常假设法/线段图比方程更直观。"
    ),
    "middle": (
        "初中：代数方程、函数思想、几何证明都可放心用；"
        "首选数形结合（坐标图 / 函数图象 / 几何变换）让代数与图形同步演化。"
    ),
    "high": (
        "高中：函数与方程、坐标几何、向量；可用参数扫描、覆盖、极限逼近"
        "等手法揭示函数性态；推荐双面板（左几何 + 右图象）。"
    ),
    "advanced": (
        "大学及以上：微积分极限可视、矩阵=空间扭曲、3D 投影、高维降维。"
        "这一段最容易掉进纯符号陷阱——必须强制几何同步。"
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

        ctx.state["solution"] = payload
        ctx.state["solution_steps"] = steps
        ctx.state["solution_answer"] = payload.get("answer", "")

        n = len(steps)
        ans = payload.get("answer") or "(无答案)"
        return ToolResult(
            success=True,
            summary=f"解题完成：{payload.get('strategy') or '未指定策略'}，{n} 步，答案：{ans}",
            data=payload,
        )
