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
        "解题步骤必须用算术推理（画一画、分组、逐个数），禁止引入未知数、方程和"
        "任何字母符号；「确定性计算」的机器验算不受此限制，但解题叙述面向学生。"
    ),
    "elementary_upper": (
        "选择该年龄能解释且步骤最少的有效推理；先说明关系，再执行运算，避免无解释的符号跳步。"
        "应用题用算术推理讲解（画图、分组、假设调整、凑整），解题步骤不出现未知数与"
        "方程记号——那是初中内容；「确定性计算」的机器验算可以用方程，但解题叙述不能。"
    ),
    "middle": (
        "允许标准代数和几何语言；明确变量定义、等价变形的依据和适用条件。"
        "方程变形应按「天平两侧同步操作」的等量思想叙述，方便后续用图形表达。"
    ),
    "high": (
        "给出关键推理依据、定义域与边界；区分等价推导、充分条件和必要条件。"
        "涉及函数与变化的推理优先用图像语言（交点、斜率、面积）组织，再给代数细节。"
    ),
    "advanced": (
        "明确使用的定义、定理、假设和边界情况；优先可验证且逻辑闭合的推导。"
        "有几何意义的对象（矩阵、变换、内积、特征向量等）先给几何解释，再做代数计算。"
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


_SOLUTION_HEADING_SYNONYMS = ("解题", "解题定稿", "解答", "解题过程", "解题步骤")


def _parse_solution(done: Any) -> dict[str, Any] | None:
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        if not source:
            continue
        section = None
        for title in _SOLUTION_HEADING_SYNONYMS:
            section = md.find_section(source, title, level=2) or md.find_section(
                source, title
            )
            if section is not None:
                break
        if section is not None:
            payload = _md_to_solution(section)
            if payload.get("steps"):
                return payload
        # JSON fallback
        json_payload = md.parse_json_anywhere(source)
        if json_payload and isinstance(json_payload.get("steps"), list):
            return json_payload
    return None


_QUANTITY_STORY_RELATIONS = {"take_away", "add_to", "compare_more", "compare_fewer"}


def _parse_quantity_story(done: Any) -> dict[str, Any] | None:
    """Parse the optional 数量故事 section into a raw (LLM-trusted) story.

    The story's relation kind is the model's semantic judgment; its numbers
    are cross-checked against executed Math IR evidence by the visual-plan
    builder before any deterministic plan is generated from it.
    """
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        section = md.find_section(source, "数量故事", level=2) or md.find_section(
            source, "数量故事"
        )
        if section is None:
            continue
        fields = md.get_kv_dict(section)
        if not fields:
            continue
        applicable = str(
            fields.get("适用") or fields.get("applicable") or ""
        ).strip().lower()
        if applicable not in {"是", "yes", "true"}:
            return None
        relation = str(fields.get("关系") or fields.get("relation") or "").strip().lower()
        if relation not in _QUANTITY_STORY_RELATIONS:
            return None

        def integer_field(*names: str) -> int | None:
            for name in names:
                raw = fields.get(name)
                if raw is None:
                    continue
                match = re.search(r"-?\d+", str(raw))
                if match:
                    return int(match.group(0))
            return None

        first = integer_field("量1", "量一")
        second = integer_field("量2", "量二")
        result = integer_field("结果量", "结果")
        if first is None or second is None or result is None:
            return None
        return {
            "relation": relation,
            "entity": str(fields.get("实体") or fields.get("entity") or "").strip()[:12],
            "first": first,
            "second": second,
            "result": result,
        }
    return None


def _execute_declared_math(done: Any) -> tuple[dict[str, Any] | None, MathExecutionResult]:
    section_found = False
    for source in (
        getattr(done, "text", "") or "",
        getattr(done, "reasoning", "") or "",
    ):
        section = md.find_section(source, "确定性计算", level=2) or md.find_section(
            source, "确定性计算"
        )
        if section is None:
            continue
        section_found = True
        request = md.parse_json_anywhere(section)
        if isinstance(request, dict):
            return request, execute_math_request(request)
    if section_found:
        # A malformed block needs actionable repair feedback, not a
        # missing-section complaint: the dominant failure is unquoted
        # algebraic expressions, which are invalid JSON.
        return None, MathExecutionResult(
            False,
            errors=[
                "确定性计算 section 存在但 JSON 无法解析。常见原因：expression 写成了"
                "未加引号的代数式。所有 expression 必须是 JSON 字符串；方程组用字符串"
                '数组，如 ["x + y - 35", "2*x + 4*y - 94"] 并配 "variables": ["x", "y"]'
            ],
        )
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

    # Steps: every `### 第 N 步` (or `### Step N`) sub-section.  Local models
    # also emit level-4 headings or bold inline markers; harvest those shapes
    # too — tolerance is about heading form only, content is untouched.
    def harvest(pairs: Any) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for i, (heading, body) in enumerate(pairs, start=1):
            h_lower = str(heading).lower()
            if not ("步" in str(heading) or h_lower.startswith("step")):
                continue
            kv = md.get_kv_dict(body)
            found.append({
                "step_number": i,
                "description": _pick(kv, "描述", "description"),
                "operation": _pick(kv, "运算", "operation"),
                "explanation": _pick(kv, "解释", "explanation"),
                "result": _pick(kv, "结果", "result"),
            })
        return found

    steps = harvest(md.find_subsections(section, level=3))
    if not steps:
        steps = harvest(md.find_subsections(section, level=4))
    if not steps:
        bold_marker = re.compile(r"\*\*\s*(第\s*\d+\s*步|Step\s*\d+)\s*\*\*[:：]?")
        chunks = bold_marker.split(section)
        if len(chunks) >= 3:
            steps = harvest(
                (chunks[i], chunks[i + 1]) for i in range(1, len(chunks) - 1, 2)
            )
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


_ADVISORY_PREFIX = "建议："


def _numeric_values(value: Any) -> list[Fraction]:
    """Numeric tokens as exact values: '0.5' == '1/2', '50%' == 0.5."""
    text = str(value or "")
    values: list[Fraction] = []
    for match in re.finditer(
        r"(?<![A-Za-z_0-9])(-?\d+(?:\.\d+)?)(?:\s*/\s*(\d+(?:\.\d+)?))?(%?)",
        text,
    ):
        try:
            number = Fraction(match.group(1))
            if match.group(2):
                denominator = Fraction(match.group(2))
                if denominator == 0:
                    continue
                values.append(number / denominator)
                # The components are also visible numbers on their own.
                values.append(number)
                values.append(denominator)
                continue
            if match.group(3):
                values.append(number / 100)
            values.append(number)
        except (ValueError, ZeroDivisionError):
            continue
    return values


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
    issues: list[str] = []
    for marker in _DRAFT_CORRECTION_MARKERS:
        if marker == "等等":
            # "等等" as etc. after an enumeration is legitimate prose; only
            # the self-interruption form ("……等等，不对") signals a draft.
            if not re.search(r"(?:^|[。！？；：\n，,])\s*等等\s*[，,！!]", joined):
                continue
        elif marker == "此处需":
            if not re.search(r"此处需(?:重新|补充|修改|核对|再)", joined):
                continue
        elif marker not in joined:
            continue
        issues.append(f"{_ADVISORY_PREFIX}解答仍包含草稿式自我纠错标记“{marker}”")
    steps = [step for step in (payload.get("steps") or []) if isinstance(step, dict)]
    signatures: set[str] = set()
    for step in steps:
        signature = "|".join(
            re.sub(r"\s+", "", str(step.get(field) or ""))
            for field in ("description", "operation", "result")
        )
        if signature and signature in signatures:
            issues.append(f"{_ADVISORY_PREFIX}解答包含内容完全重复的步骤，仍像未清理的草稿")
            break
        signatures.add(signature)

    answer_values = _numeric_values(payload.get("answer"))
    result_values = [
        value for step in steps for value in _numeric_values(step.get("result"))
    ]
    missing_answer_values = [
        value
        for value in dict.fromkeys(answer_values)
        if all(value != known for known in result_values)
    ]
    if answer_values and result_values and missing_answer_values:
        # Derivation mismatch is a quality signal, not proof of wrong math:
        # unit conversions, ratios and restated givens legitimately introduce
        # numbers. Independent verification owns correctness.
        issues.append(
            f"{_ADVISORY_PREFIX}最终答案数值没有被任何步骤结果推导出来："
            + ",".join(str(value) for value in missing_answer_values[:4])
        )

    for step_index, step in enumerate(steps, start=1):
        for equality in _invalid_literal_equalities(step.get("operation")):
            issues.append(f"第{step_index}步包含算术矛盾：{equality}")
    blocking = [issue for issue in issues if not issue.startswith(_ADVISORY_PREFIX)]
    advisory = [issue for issue in issues if issue.startswith(_ADVISORY_PREFIX)]
    return (blocking + advisory)[:4]


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
        raw_format_artifacts = [_raw_solution_artifact(done, ctx, "initial")]
        steps = (payload or {}).get("steps") or []
        if payload is None or not steps:
            # A format failure has a knowable cause; one bounded retry with
            # the concrete error beats dying on an arbitrary new problem.
            failure_reason = (
                "缺少可解析的「## 解题」section" if payload is None else "未解析到任何解题步骤"
            )
            format_feedback = (
                "\n\n## 上次输出格式无法解析\n"
                f"- 问题：{failure_reason}\n"
                "- 必须包含精确标题 '## 解题'；每一步用 '### 第 N 步' 三级子标题，"
                "内含 **描述/运算/解释/结果** 字段。\n"
            )
            if str(getattr(done, "finish_reason", "")) == "length":
                format_feedback += (
                    "- 上次输出在完成前被截断：请压缩 ## 分析 篇幅，确保 ## 解题 完整输出。\n"
                )
            try:
                retry_done = await self._llm.chat_complete(
                    messages=[ChatMessage(role="user", content=prompt + format_feedback)],
                    temperature=0.1,
                    max_tokens=6144,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
                raw_format_artifacts.append(
                    _raw_solution_artifact(retry_done, ctx, "format-retry")
                )
                retry_payload = _parse_solution(retry_done)
                if retry_payload and retry_payload.get("steps"):
                    done = retry_done
                    payload = retry_payload
                    steps = payload.get("steps") or []
            except Exception:
                logger.exception("solve_problem format retry failed")
        if payload is None or not steps:
            logger.warning(
                "solve_problem: no parseable solution after retry | finish=%s "
                "text_len=%d reasoning_len=%d",
                getattr(done, "finish_reason", "?"),
                len(getattr(done, "text", "") or ""),
                len(getattr(done, "reasoning", "") or ""),
            )
            return ToolResult(
                success=False,
                summary=(
                    "无法从模型输出解析「## 解题」section（含一次格式重试）"
                    if payload is None
                    else "解题步骤为空（含一次格式重试）"
                ),
                error="parse_failed" if payload is None else "empty_steps",
                data={
                    "raw_text": (getattr(done, "text", "") or "")[:600],
                    "raw_reasoning": (getattr(done, "reasoning", "") or "")[:600],
                    "finish_reason": getattr(done, "finish_reason", None),
                },
                artifacts=raw_format_artifacts,
            )

        math_request, math_execution = _execute_declared_math(done)
        all_contract_issues = [
            *_solution_contract_issues(payload),
            *_math_execution_issues(math_execution),
        ][:4]
        # Advisory issues (style/derivation hints) never justify a repair
        # round on their own — record them and proceed; blocking issues are
        # machine-verified contradictions and get the bounded repair.
        contract_issues = [
            issue for issue in all_contract_issues if not issue.startswith(_ADVISORY_PREFIX)
        ]
        advisory_issues = [
            issue for issue in all_contract_issues if issue.startswith(_ADVISORY_PREFIX)
        ]
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
                + "\n重新输出完整的 ## 分析 和 ## 解题（标题必须精确为 '## 解题'）。"
                "只修正上述矛盾，再次逐项核对最终答案与最后一步结果。"
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
                repaired_all = [
                    *_solution_contract_issues(repaired_payload),
                    *_math_execution_issues(repaired_execution),
                ][:4]
                repaired_issues = [
                    issue
                    for issue in repaired_all
                    if not issue.startswith(_ADVISORY_PREFIX)
                ]
                advisory_issues = [
                    issue for issue in repaired_all if issue.startswith(_ADVISORY_PREFIX)
                ]
            else:
                repaired_request = None
                repaired_execution = MathExecutionResult(
                    False, errors=["修复输出无法解析"]
                )
                repaired_issues = ["修复输出无法解析"]
            if repaired_payload and repaired_done is not None:
                # Adopt the repaired draft whenever it PARSED — even when
                # issues remain, they describe the repaired artifact, and the
                # downgrade logic below must judge that artifact, not the
                # stale original (which may still carry already-fixed
                # narrative issues and wrongly block the math downgrade).
                done = repaired_done
                payload = repaired_payload
                steps = payload.get("steps") or []
                math_request = repaired_request
                math_execution = repaired_execution
                internal_repair_count = 1
                contract_issues = repaired_issues
            else:
                contract_issues = repaired_issues
        math_downgrade_artifacts: list[ArtifactSpec] = []
        if advisory_issues:
            ctx.state["solve_contract_advisories"] = advisory_issues
        else:
            ctx.state.pop("solve_contract_advisories", None)
        if contract_issues:
            solution_issues_now = [
                issue
                for issue in _solution_contract_issues(payload)
                if not issue.startswith(_ADVISORY_PREFIX)
            ]
            if not solution_issues_now:
                # Every remaining issue concerns the deterministic-computation
                # artifact, not the solution itself.  The documented principle
                # is to abstain rather than fabricate: keep the solution, mark
                # the math evidence inapplicable, and let the independent
                # verify stage own correctness.  This is IR-format resilience,
                # not a problem-type branch.
                downgrade_reason = "；".join(str(item) for item in contract_issues)[:300]
                logger.warning(
                    "solve math evidence downgraded to logical verification: %s",
                    downgrade_reason,
                )
                math_request = math_request or {}
                math_execution = MathExecutionResult(
                    True,
                    applicable=False,
                    reason="确定性计算未能执行，已降级为逻辑验证：" + downgrade_reason,
                )
                ctx.state["math_evidence_downgraded"] = downgrade_reason
                math_downgrade_artifacts = [_raw_solution_artifact(done, ctx, "initial")]
                if repaired_done is not None and repaired_done is not done:
                    math_downgrade_artifacts.append(
                        _raw_solution_artifact(repaired_done, ctx, "repair")
                    )
                contract_issues = []
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
        if not math_downgrade_artifacts:
            ctx.state.pop("math_evidence_downgraded", None)
        quantity_story = _parse_quantity_story(done)
        if quantity_story is not None:
            ctx.state["quantity_story"] = quantity_story
        else:
            ctx.state.pop("quantity_story", None)
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
            ),
            *math_downgrade_artifacts,
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
