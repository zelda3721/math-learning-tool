"""solve_problem — produce a structured solution before code generation.

Output is markdown with `## 解题`, `**字段**: 值`, and `### 第 N 步` sub-sections.
JSON output is accepted as a fallback.
"""
from __future__ import annotations

import ast
import json
import logging
import re
from fractions import Fraction
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
from ..math_runtime import MathExecutionResult, execute_math_request
from ..prompt_library import PromptLibrary
from .analyze_problem import _parse_analysis

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


def _raw_solution_artifact(done: Any, ctx: ToolContext, label: str) -> ArtifactSpec:
    text = getattr(done, "text", "") or ""
    reasoning = getattr(done, "reasoning", "") or ""
    content = text
    if reasoning and reasoning != text:
        content = f"## visible\n{text}\n\n## reasoning\n{reasoning}"
    return ArtifactSpec(
        kind="solver_raw",
        filename=f"solve-raw-{label}-turn{ctx.turn_index:02d}.txt",
        content=content,
        meta={
            "finish_reason": getattr(done, "finish_reason", ""),
            "visible_chars": len(text),
            "reasoning_chars": len(reasoning),
        },
    )


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


def _execute_declared_math(done: Any) -> tuple[dict[str, Any] | None, MathExecutionResult]:
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        section = md.find_section(source, "确定性计算", level=2) or md.find_section(
            source, "确定性计算"
        )
        if section is None:
            continue
        request = md.parse_json_anywhere(section)
        if isinstance(request, dict):
            return request, execute_math_request(request)
    return None, MathExecutionResult(False, errors=["缺少 ## 确定性计算 JSON 请求"])


def _math_execution_issues(result: MathExecutionResult) -> list[str]:
    if not result.success:
        return ["确定性计算失败：" + "；".join(result.errors[:2])]
    if result.applicable and not result.all_claims_passed:
        failed = [item for item in result.claims if item.get("passed") is not True]
        detail = str(failed[0])[:300] if failed else "没有声明可核对最终答案的 claim"
        return ["确定性计算没有证明最终答案：" + detail]
    return []


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
    issues = [
        f"解答仍包含草稿式自我纠错标记“{marker}”"
        for marker in _DRAFT_CORRECTION_MARKERS
        if marker in joined
    ]
    steps = [step for step in (payload.get("steps") or []) if isinstance(step, dict)]
    signatures: set[str] = set()
    for step in steps:
        signature = "|".join(
            re.sub(r"\s+", "", str(step.get(field) or ""))
            for field in ("description", "operation", "result")
        )
        if signature and signature in signatures:
            issues.append("解答包含内容完全重复的步骤，仍像未清理的草稿")
            break
        signatures.add(signature)

    def numeric_tokens(value: Any) -> list[str]:
        return re.findall(r"(?<![A-Za-z_])-?\d+(?:\.\d+)?", str(value or ""))

    answer_numbers = numeric_tokens(payload.get("answer"))
    result_numbers = {
        number
        for step in steps
        for number in numeric_tokens(step.get("result"))
    }
    missing_answer_numbers = sorted(set(answer_numbers) - result_numbers)
    if answer_numbers and result_numbers and missing_answer_numbers:
        issues.append(
            "最终答案数值没有被任何步骤结果推导出来："
            + ",".join(missing_answer_numbers)
        )

    last_result_numbers = numeric_tokens(steps[-1].get("result")) if steps else []
    if (
        len(answer_numbers) == 1
        and last_result_numbers
        and answer_numbers[0] not in last_result_numbers
    ):
        issues.append(
            "最终答案中的唯一数值未出现在最后一步结果中："
            f"answer={answer_numbers[0]}, last_result={','.join(last_result_numbers)}"
        )

    for step_index, step in enumerate(steps, start=1):
        for equality in _invalid_literal_equalities(step.get("operation")):
            issues.append(f"第{step_index}步包含算术矛盾：{equality}")
    return issues[:3]


def _literal_arithmetic_value(expression: str) -> Fraction:
    """Evaluate only a literal arithmetic expression, never names or calls."""
    binary = {
        ast.Add: lambda left, right: left + right,
        ast.Sub: lambda left, right: left - right,
        ast.Mult: lambda left, right: left * right,
        ast.Div: lambda left, right: left / right,
        ast.Pow: lambda left, right: left**right,
    }

    def visit(node: ast.AST) -> Fraction:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return Fraction(str(node.value))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and type(node.op) in binary:
            return binary[type(node.op)](visit(node.left), visit(node.right))
        raise ValueError("non-literal arithmetic")

    return visit(ast.parse(expression, mode="eval"))


def _invalid_literal_equalities(value: Any) -> list[str]:
    """Find false numeric equalities without making any problem-type assumptions."""
    text = str(value or "")
    normalized = (
        text.replace(r"\times", "*")
        .replace(r"\div", "/")
        .replace(r"\cdot", "*")
        .replace("×", "*")
        .replace("÷", "/")
        .replace("−", "-")
        .replace("^", "**")
        .replace("$", "")
    )
    issues: list[str] = []
    equality_pattern = re.compile(
        r"(?P<left>[+\-*/().\d\s]+?)\s*=\s*(?P<right>[+\-*/().\d\s]+)"
    )
    for match in equality_pattern.finditer(normalized):
        raw_left = match.group("left")
        left = raw_left.strip()
        right = match.group("right").strip()
        if not left or not right:
            continue
        left_start = match.start("left") + len(raw_left) - len(raw_left.lstrip())
        prefix = normalized[max(0, left_start - 16) : left_start].rstrip()
        # The regex intentionally sees digits only. Do not let it carve a
        # parenthesized argument or a subscript out of a symbolic expression
        # such as f(0), a_0 or x→0 and then misread the outer relation as the
        # literal arithmetic claim ``(0) = ...``.
        if prefix and (re.search(r"[A-Za-z_\\}]$", prefix) or prefix.endswith("→")):
            continue
        try:
            left_value = _literal_arithmetic_value(left)
            right_value = _literal_arithmetic_value(right)
        except (SyntaxError, ValueError, ZeroDivisionError):
            continue
        if left_value != right_value:
            issues.append(f"{left} = {right}")
    return issues


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
            "在同一次调用中对当前数学问题做开放式事实分解和结构化解题，返回 analysis、"
            "strategy、steps、answer、key_points。不得判断题型或套相似题模板。"
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
                    "description": "（兼容旧调用，可选）已有事实提示；正常生产流程无需传入",
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
                artifacts=[_raw_solution_artifact(done, ctx, "initial")],
            )

        steps = payload.get("steps") or []
        if not steps:
            return ToolResult(
                success=False,
                summary="解题步骤为空",
                error="empty_steps",
                data=payload,
            )

        math_request, math_execution = _execute_declared_math(done)
        contract_issues = [
            *_solution_contract_issues(payload),
            *_math_execution_issues(math_execution),
        ][:4]
        internal_repair_count = 0
        repaired_done = None
        if contract_issues:
            # This is a bounded self-repair inside Solve, driven only by
            # machine-observed contradictions in the submitted artifact. It
            # avoids spending a visible Verify round on an obviously stale
            # final answer or duplicated draft step.
            repair_prompt = (
                prompt
                + "\n\n## 提交前契约检查未通过\n"
                + "\n".join(f"- {issue}" for issue in contract_issues)
                + "\n重新输出完整的 ## 分析 和 ## 解题定稿。只修正上述矛盾，"
                "再次逐项核对最终答案与最后一步结果。"
            )
            try:
                repaired_done = await self._llm.chat_complete(
                    messages=[ChatMessage(role="user", content=repair_prompt)],
                    temperature=0.1,
                    max_tokens=6144,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
            except Exception:
                logger.exception("solve_problem bounded consistency repair failed")
                repaired_done = None
            repaired_payload = _parse_solution(repaired_done) if repaired_done else None
            if repaired_payload and repaired_done:
                repaired_request, repaired_execution = _execute_declared_math(repaired_done)
                repaired_issues = [
                    *_solution_contract_issues(repaired_payload),
                    *_math_execution_issues(repaired_execution),
                ][:4]
            else:
                repaired_request = None
                repaired_execution = MathExecutionResult(
                    False, errors=["修复输出无法解析"]
                )
                repaired_issues = ["修复输出无法解析"]
            if repaired_payload and not repaired_issues:
                done = repaired_done
                payload = repaired_payload
                steps = payload.get("steps") or []
                math_request = repaired_request
                math_execution = repaired_execution
                contract_issues = []
                internal_repair_count = 1
            else:
                contract_issues = repaired_issues
        if contract_issues:
            ctx.state["last_solve_contract_issues"] = contract_issues
            raw_artifacts = [_raw_solution_artifact(done, ctx, "initial")]
            if repaired_done is not None and repaired_done is not done:
                raw_artifacts.append(
                    _raw_solution_artifact(repaired_done, ctx, "repair")
                )
            return ToolResult(
                success=False,
                summary="解答不是可交付的一致版本：" + "；".join(contract_issues),
                error="solution_contract_violation",
                data={"issues": contract_issues},
                artifacts=raw_artifacts,
            )

        # Solve owns semantic decomposition as well as the settled derivation.
        # Keeping both contracts in one model response removes an entire LLM
        # boundary and prevents a separately generated analysis from drifting
        # away from the actual solution.  Older/less compliant models may omit
        # the brief; the verified solution remains usable and supplies a safe
        # content-derived fallback rather than triggering another model call.
        analysis = _parse_analysis(done)
        if analysis is None:
            analysis = {
                "difficulty": "unknown",
                "question": problem,
                "objects": [],
                "relations": [],
                "known_conditions": [],
                "constraints": ["仅使用题目明示条件"],
                "prerequisites": payload.get("key_points") or [],
                "key_values": {},
                "source": "solution_fallback",
            }

        ctx.state["analysis"] = analysis
        ctx.state["solution"] = payload
        ctx.state["solution_steps"] = steps
        ctx.state["solution_answer"] = payload.get("answer", "")
        ctx.state["solve_math_request"] = math_request or {}
        ctx.state["solve_math_evidence"] = math_execution.to_dict()
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
        execution_report = {
            "stage": self.name,
            "source": "solve",
            "request": math_request,
            "evidence": math_execution.to_dict(),
        }
        artifacts = [
            ArtifactSpec(
                kind="math_execution",
                filename=f"solve-math-turn{ctx.turn_index:02d}.json",
                content=json.dumps(execution_report, ensure_ascii=False, indent=2),
                meta={
                    "source": "solve",
                    "success": math_execution.success,
                    "applicable": math_execution.applicable,
                    "all_claims_passed": math_execution.all_claims_passed,
                },
            )
        ]
        if internal_repair_count:
            report = {
                "stage": self.name,
                "internal_repair_count": internal_repair_count,
                "reason": "solution_contract_violation",
            }
            artifacts.append(
                ArtifactSpec(
                    kind="pipeline_report",
                    filename=f"solve-turn{ctx.turn_index:02d}.json",
                    content=json.dumps(report, ensure_ascii=False, indent=2),
                    meta=report,
                )
            )
        return ToolResult(
            success=True,
            summary=(
                f"问题简报与解题完成：{payload.get('strategy') or '未指定策略'}，"
                f"{n} 步，答案：{ans}"
            ),
            data={
                **payload,
                "analysis": analysis,
                "math_execution": math_execution.to_dict(),
                "internal_repair_count": internal_repair_count,
            },
            artifacts=artifacts,
        )
