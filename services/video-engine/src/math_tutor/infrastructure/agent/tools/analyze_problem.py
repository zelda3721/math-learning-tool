"""analyze_problem — open-world semantic decomposition.

Output is markdown structured as `## 分析` + `**字段**: 值` + `### Section` + `- item` lists.
Parsed leniently with `markdown_extract`. JSON output is also accepted as a fallback.
"""
from __future__ import annotations

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


def _coerce_number(text: str) -> Any:
    text = text.strip()
    try:
        if "." in text:
            return float(text)
        return int(text)
    except ValueError:
        return text


def _parse_analysis(done: Any) -> dict[str, Any] | None:
    """Try `done.text`, then `done.reasoning` (Qwen3 thinking sometimes leaks
    structured answer there). Markdown is the primary path; JSON fallback
    covers models that ignore the format spec."""
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        if not source:
            continue
        section = md.find_section(source, "分析", level=2) or md.find_section(
            source, "分析"
        )
        if section is not None:
            payload = _md_to_dict(section)
            if payload.get("question") or payload.get("known_conditions"):
                return payload
        # JSON fallback
        json_payload = md.parse_json_anywhere(source)
        if json_payload and (
            json_payload.get("question") or json_payload.get("known_conditions")
        ):
            return json_payload
    return None


def _md_to_dict(section: str) -> dict[str, Any]:
    return {
        "difficulty": md.get_field(section, "难度", "difficulty"),
        "question": md.get_field(section, "求解目标", "question", "目标"),
        "objects": md.get_bullets(md.find_section(section, "数学对象")),
        "relations": md.get_bullets(md.find_section(section, "关系")),
        "known_conditions": md.get_bullets(md.find_section(section, "已知条件")),
        "constraints": md.get_bullets(md.find_section(section, "约束与假设")),
        "prerequisites": md.get_bullets(md.find_section(section, "受众前置知识")),
        "key_values": {
            k: _coerce_number(v)
            for k, v in md.get_kv_dict(md.find_section(section, "关键数值")).items()
        },
    }


class AnalyzeProblemTool(ITool):
    def __init__(self, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "analyze_problem"

    @property
    def description(self) -> str:
        return (
            "对当前数学问题做开放式语义分解。返回数学对象、关系、约束、已知条件、"
            "求解目标、关键数值和受众前置知识；不判断题型、不匹配模板。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {
                    "type": "string",
                    "description": "题目原文（缺省使用当前会话的题目）",
                },
                "grade": {"type": "string", "description": "学生年级"},
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        if not problem:
            return ToolResult(success=False, summary="缺少题目文本", error="empty_problem")

        prompt = self._prompts.render("analyze", grade=grade, problem=problem)

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.2,
                max_tokens=4096,
                # Structured markdown output — thinking is wasted budget.
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception as exc:
            logger.exception("analyze_problem LLM call failed")
            return ToolResult(success=False, summary="分析失败", error=str(exc))

        payload = _parse_analysis(done)
        if payload is None:
            logger.warning(
                "analyze_problem: no parseable markdown/JSON | finish=%s text_len=%d "
                "reasoning_len=%d text_head=%r reasoning_head=%r",
                getattr(done, "finish_reason", "?"),
                len(getattr(done, "text", "") or ""),
                len(getattr(done, "reasoning", "") or ""),
                (getattr(done, "text", "") or "")[:200],
                (getattr(done, "reasoning", "") or "")[:200],
            )
            return ToolResult(
                success=False,
                summary="无法从模型输出解析「## 分析」section",
                error="parse_failed",
                data={
                    "raw_text": (done.text or "")[:600],
                    "raw_reasoning": (done.reasoning or "")[:600],
                    "finish_reason": getattr(done, "finish_reason", None),
                },
            )

        ctx.state["analysis"] = payload
        return ToolResult(
            success=True,
            summary=(
                f"语义分析完成：目标 {payload.get('question') or '?'} / "
                f"{len(payload.get('relations') or [])} 个关系 / "
                f"难度 {payload.get('difficulty') or '?'}"
            ),
            data=payload,
        )
