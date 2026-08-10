"""generate_web_explanation — 让模型直接写 Web 讲解页面，由门禁把住真实性。

与 Manim 通道的 model_codegen 同构：模型写码、门禁判定、不过就带着违规清单重写。
差别在于这条路的门禁**更严**——生成物是标记语言，可以直接数元素，
不必像成片审查那样在 JPEG 里做连通域计数。

不重试到天荒地老：每一轮都把违规清单原样喂回去，超过上限就诚实失败。
一份画着假数字的讲解比没有讲解糟糕得多。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from ..prompt_library import PromptLibrary
from ..web_explanation_contract import GateReport, verify_web_explanation

logger = logging.getLogger(__name__)

#: 契约不过时最多重写几次（含首稿共 1 + MAX_REWRITES 次生成）
MAX_REWRITES = 2

_FENCE = re.compile(r"```(?:html)?\s*(.*?)```", re.S | re.I)
_ARTICLE = re.compile(r"<article\b.*?</article\s*>", re.S | re.I)


def extract_html(text: str) -> str:
    """从模型回复里取出 HTML 片段。

    本地模型常见三种包法：裸片段、markdown 围栏、片段前后带一段说明。
    一律先找 `<article>…</article>`——契约要求根节点就是它，这比剥围栏更可靠。
    """
    if not text:
        return ""
    article = _ARTICLE.search(text)
    if article:
        return article.group(0).strip()
    fenced = _FENCE.search(text)
    if fenced:
        inner = fenced.group(1).strip()
        nested = _ARTICLE.search(inner)
        return (nested.group(0) if nested else inner).strip()
    return text.strip()


def _steps_text(steps: Any) -> str:
    if isinstance(steps, list):
        lines = [f"{i + 1}. {str(s).strip()}" for i, s in enumerate(steps) if str(s).strip()]
        return "\n".join(lines) if lines else "（无）"
    return str(steps or "（无）")


def _evidence_text(evidence: Any) -> str:
    if not isinstance(evidence, dict):
        return "（无）"
    trimmed = {
        key: evidence.get(key)
        for key in ("operations", "claims", "all_claims_passed")
        if evidence.get(key) is not None
    }
    try:
        return json.dumps(trimmed, ensure_ascii=False, indent=1)[:2500]
    except (TypeError, ValueError):  # pragma: no cover
        return "（无）"


def build_rewrite_note(report: GateReport, attempt: int) -> str:
    """把门禁的判定原样喂回去——模型改不动它看不见的东西。"""
    lines = [
        f"# 第 {attempt} 稿没有通过契约门禁，请修改后重新输出完整 HTML",
        "",
        "**必须修掉（否则继续打回）**：",
    ]
    lines.extend(f"- {item}" for item in report.errors)
    if report.warnings:
        lines.append("")
        lines.append("**建议一并处理**：")
        lines.extend(f"- {item}" for item in report.warnings)
    lines.extend(
        [
            "",
            "注意：`data-claim=\"名字=数值\"` 的子树里必须真的写出那么多 `data-unit` 元素；",
            "用 CSS 重复、伪元素或「× 35」这样的文字代替，都会被判为没画出来。",
            "只输出 HTML，不要解释。",
        ]
    )
    return "\n".join(lines)


class GenerateWebExplanationTool(ITool):
    def __init__(self, *, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "generate_web_explanation"

    @property
    def description(self) -> str:
        return (
            "让模型直接写一页自足的 Web 动态讲解（HTML+内联 CSS/JS），"
            "由可核查契约门禁把住真实性：宣称的数量必须真的画出来，答案不许画错。"
            "调用前必须已有已验证的 solution_steps / answer。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "extra_directives": {
                    "type": "string",
                    "description": "本次讲解的额外导向（知识点、易错点）",
                },
                "max_rewrites": {
                    "type": "integer",
                    "description": f"契约不过时的重写上限，缺省 {MAX_REWRITES}",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        state = ctx.state
        steps = state.get("solution_steps") or state.get("verified_steps") or []
        answer = state.get("solution_answer") or state.get("answer") or ""
        if not steps and not answer:
            return ToolResult(
                success=False,
                summary="还没有已验证的解，不能写讲解",
                error="missing_verified_solution",
            )

        evidence = state.get("verify_math_evidence") or state.get("solve_math_evidence")
        request = state.get("verify_math_request") or state.get("solve_math_request")

        base_prompt = self._prompts.render(
            "web_explanation",
            problem=ctx.problem,
            grade=ctx.grade,
            solution_steps=_steps_text(steps),
            answer=str(answer),
            math_evidence=_evidence_text(evidence),
            extra_directives=str(args.get("extra_directives") or ""),
        )

        limit = int(args.get("max_rewrites") or MAX_REWRITES)
        messages = [ChatMessage(role="user", content=base_prompt)]
        artifacts: list[ArtifactSpec] = []
        attempts: list[dict[str, Any]] = []
        best: tuple[str, GateReport] | None = None

        for attempt in range(1, limit + 2):
            reply = await self._llm.chat_complete(messages=messages)
            markup = extract_html(getattr(reply, "text", "") or "")
            report = verify_web_explanation(markup, evidence, request)
            attempts.append(
                {
                    "attempt": attempt,
                    "chars": len(markup),
                    "gate": report.as_dict(),
                }
            )
            artifacts.append(
                ArtifactSpec(
                    kind="web_explanation",
                    filename=f"web-explanation-attempt{attempt:02d}.html",
                    content=markup,
                    meta={"attempt": attempt, "gate_ok": report.ok},
                )
            )
            # 留最好的一稿：错误更少者胜，用于诚实降级（绝不交付有错误的那份）
            if best is None or len(report.errors) < len(best[1].errors):
                best = (markup, report)
            if report.ok:
                state["web_explanation_html"] = markup
                state["web_explanation_gate"] = report.as_dict()
                return ToolResult(
                    success=True,
                    summary=(
                        f"Web 讲解已通过契约门禁（第 {attempt} 稿）"
                        + (f"；{len(report.warnings)} 条建议未处理" if report.warnings else "")
                    ),
                    data={
                        "html": markup,
                        "gate": report.as_dict(),
                        "attempts": attempts,
                    },
                    artifacts=artifacts,
                )
            if attempt > limit:
                break
            logger.info(
                "web 讲解第 %d 稿未过门禁，打回重写：%s", attempt, report.errors[:3]
            )
            messages = [
                ChatMessage(role="user", content=base_prompt),
                ChatMessage(role="assistant", content=markup),
                ChatMessage(role="user", content=build_rewrite_note(report, attempt)),
            ]

        markup, report = best if best else ("", GateReport(errors=["未产出任何内容"]))
        state["web_explanation_gate"] = report.as_dict()
        return ToolResult(
            success=False,
            summary="Web 讲解连续未通过契约门禁：" + "；".join(report.errors[:3]),
            data={"html": markup, "gate": report.as_dict(), "attempts": attempts},
            artifacts=artifacts,
            error="web_explanation_contract_violation",
        )
