"""Evidence-producing verification for open-world mathematical solutions.

The verifier chooses a mechanism from the semantics of the current claim:
deterministic constraints are checked in a restricted Python sandbox, while
non-executable claims receive a premise/step/boundary/counterexample audit.
This is a verification-mechanism choice, not a problem-type taxonomy.
"""

from __future__ import annotations

import ast
import json
import logging
import math
import operator
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
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)

_SAFE_LITERAL_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}


def _safe_literal_value(node: ast.AST, *, depth: int = 0) -> Any:
    """Evaluate data literals plus small arithmetic such as ``5/3``."""
    if depth > 10:
        raise ValueError("literal nesting too deep")
    if isinstance(node, ast.Constant) and isinstance(
        node.value, (str, int, float, bool, type(None))
    ):
        return node.value
    if isinstance(node, ast.Dict):
        return {
            _safe_literal_value(key, depth=depth + 1): _safe_literal_value(value, depth=depth + 1)
            for key, value in zip(node.keys, node.values)
            if key is not None
        }
    if isinstance(node, (ast.List, ast.Tuple)):
        values = [_safe_literal_value(item, depth=depth + 1) for item in node.elts]
        return values if isinstance(node, ast.List) else tuple(values)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _safe_literal_value(node.operand, depth=depth + 1)
        if not isinstance(value, (int, float)):
            raise ValueError("unary operator requires a number")
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp) and type(node.op) in _SAFE_LITERAL_BINOPS:
        left = _safe_literal_value(node.left, depth=depth + 1)
        right = _safe_literal_value(node.right, depth=depth + 1)
        if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
            raise ValueError("arithmetic operands must be numbers")
        if isinstance(node.op, ast.Pow) and abs(right) > 12:
            raise ValueError("exponent too large")
        value = _SAFE_LITERAL_BINOPS[type(node.op)](left, right)
        if not isinstance(value, (int, float)) or abs(value) > 1e15:
            raise ValueError("numeric value out of bounds")
        return value
    raise ValueError(f"unsupported literal node: {type(node).__name__}")


def _parse_data_object(candidate: str) -> dict[str, Any] | None:
    try:
        value = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        try:
            value = _safe_literal_value(ast.parse(candidate, mode="eval").body)
        except (SyntaxError, TypeError, ValueError, ZeroDivisionError, OverflowError):
            return None
    return value if isinstance(value, dict) else None


# Restricted builtins for the sandbox. Math word problems need basic
# arithmetic + comparisons; nothing else is legitimate.
_SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs,
    "min": min,
    "max": max,
    "sum": sum,
    "len": len,
    "round": round,
    "int": int,
    "float": float,
    "str": str,
    "bool": bool,
    "isinstance": isinstance,
    "type": type,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "set": set,
    "range": range,
    "enumerate": enumerate,
    "zip": zip,
    "all": all,
    "any": any,
    "sorted": sorted,
    "map": map,
    "filter": filter,
    "AssertionError": AssertionError,
    "ValueError": ValueError,
    "True": True,
    "False": False,
    "None": None,
}


def _extract_python_block(text: str) -> str:
    """Pull Python out of balanced or output-truncated Markdown fences."""
    m_iter = list(re.finditer(r"```python\n(.*?)```", text, re.DOTALL))
    if not m_iter:
        m_iter = list(re.finditer(r"```\n(.*?)```", text, re.DOTALL))
    if not m_iter:
        opener = re.search(r"```(?:python|py)?[ \t]*\r?\n", text, re.IGNORECASE)
        return text[opener.end() :].strip() if opener else ""
    blocks = [m.group(1).strip() for m in m_iter]
    return max(blocks, key=len)


def _parse_json_field(text: str | None) -> dict | None:
    """Parse a JSON object out of a markdown field value, tolerating noise."""
    if not text:
        return None
    s = text.strip()
    # try the whole string first
    if s.startswith("{") and s.endswith("}"):
        try:
            return _parse_data_object(s)
        except Exception:
            pass
    # search for a {...} block anywhere
    matches = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", s)
    for m in matches:
        try:
            obj = _parse_data_object(m)
            if obj is not None:
                return obj
        except Exception:
            continue
    return None


def _find_balanced_json(text: str, start_pos: int = 0) -> dict | None:
    """Find first balanced {...} from start_pos that parses as a dict.

    Walks character by character to track brace depth — handles nested
    JSON, JSON inside ```json``` fences, JSON spanning multiple lines.
    Way more tolerant than regex-based field extraction.
    """
    if not text:
        return None
    i = text.find("{", start_pos)
    while i >= 0 and i < len(text):
        depth = 0
        in_str = False
        escape = False
        end = -1
        for j in range(i, len(text)):
            ch = text[j]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"' and not escape:
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if end < 0:
            return None  # unbalanced; bail
        candidate = text[i:end]
        obj = _parse_data_object(candidate)
        if obj is not None:
            return obj
        # not parseable — skip past this opening brace and try the next one
        i = text.find("{", i + 1)
    return None


def _extract_json_after_label(section: str, *labels: str) -> dict | None:
    """Find the first balanced JSON dict that follows any of the given labels.

    Tolerant of:
      - JSON on the same line as the label (`**题目数值**: {...}`)
      - JSON on the next line(s)
      - JSON wrapped in ```json ... ``` fences
      - Whitespace / multi-line / nested objects
      - Mixed Chinese/English label aliases
    """
    if not section:
        return None
    for label in labels:
        # Case-insensitive label search; allow extra non-alpha chars
        # between label words (e.g. "题目 数值")
        m = re.search(re.escape(label), section, re.IGNORECASE)
        if not m:
            continue
        obj = _find_balanced_json(section, m.end())
        if obj is not None:
            return obj
    return None


def _safe_exec_verify(code: str, data: dict[str, Any]) -> tuple[bool, str]:
    """Execute the verify function in a restricted namespace.

    Returns (passed, message). `passed=True` only when verify(data) returns
    True without raising. Any AssertionError, runtime error, or non-True
    return marks it failed.
    """
    if not code or "def verify" not in code:
        return False, "代码里没有 def verify(...) 函数"

    # Static checks: no arbitrary imports, dunders, eval/exec. A generated
    # verifier may request Python's pure numeric `math` module; remove that
    # import from the AST and inject the already-loaded safe module instead.
    forbidden_patterns = [
        r"\b__\w+__\b",
        r"\beval\s*\(",
        r"\bexec\s*\(",
        r"\bopen\s*\(",
        r"\b__import__\b",
        r"\bcompile\s*\(",
    ]
    for pat in forbidden_patterns:
        m = re.search(pat, code)
        if m:
            return False, f"verify 代码使用了禁止的操作: {m.group(0)}"

    class _SafeImportStripper(ast.NodeTransformer):
        def __init__(self) -> None:
            self.injected: dict[str, Any] = {}
            self.error: str | None = None

        def visit_Import(self, node: ast.Import) -> ast.AST | None:
            for alias in node.names:
                if alias.name != "math":
                    self.error = f"verify 代码使用了禁止的导入: {alias.name}"
                    return node
                self.injected[alias.asname or "math"] = math
            return None

        def visit_ImportFrom(self, node: ast.ImportFrom) -> ast.AST | None:
            if node.module != "math" or node.level:
                self.error = f"verify 代码使用了禁止的导入: {node.module or '?'}"
                return node
            for alias in node.names:
                if alias.name == "*" or alias.name.startswith("_"):
                    self.error = "verify 代码不允许 math 通配符或私有成员导入"
                    return node
                value = getattr(math, alias.name, None)
                if value is None:
                    self.error = f"math 不包含 {alias.name}"
                    return node
                self.injected[alias.asname or alias.name] = value
            return None

    # Parse and transform first to catch syntax/import errors cleanly.
    try:
        tree = ast.parse(code, "<verify>", "exec")
    except SyntaxError as exc:
        return False, f"语法错误 line {exc.lineno}: {exc.msg}"
    stripper = _SafeImportStripper()
    tree = stripper.visit(tree)
    if stripper.error:
        return False, stripper.error
    ast.fix_missing_locations(tree)
    compiled = compile(tree, "<verify>", "exec")

    namespace: dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        **stripper.injected,
    }
    try:
        exec(compiled, namespace)
    except Exception as exc:
        return False, f"verify 函数定义阶段出错: {type(exc).__name__}: {exc}"

    if "verify" not in namespace or not callable(namespace["verify"]):
        return False, "没找到可调用的 verify 函数"

    try:
        result = namespace["verify"](data)
    except AssertionError as exc:
        # AssertionError IS the signal we want — answer doesn't satisfy
        # constraints. Return its message as the failure reason.
        msg = str(exc) or "(assert 失败但没有消息)"
        return False, f"断言失败: {msg}"
    except Exception as exc:
        return False, f"执行错误: {type(exc).__name__}: {exc}"

    if result is True:
        return True, "通过"
    return False, f"verify 返回 {result!r}（应返回 True 或在失败时 assert）"


def _add_safe_data_aliases(code: str, data: dict[str, Any]) -> dict[str, Any]:
    """Repair harmless verifier-schema prefixes before sandbox execution.

    Local models often emit ``answer_volume`` in code while declaring the
    answer payload as ``{"volume": ...}``.  When stripping a conventional
    role prefix yields an exact existing key, aliasing is unambiguous and
    avoids spending a whole verification attempt on a KeyError.  Values are
    never inferred or changed.
    """
    merged = dict(data)
    required = set(re.findall(r"data\[\s*['\"]([^'\"]+)['\"]\s*\]", code))
    prefixes = ("answer_", "expected_", "claimed_", "actual_", "final_", "result_")
    for missing in sorted(required - merged.keys()):
        candidates = {
            missing.removeprefix(prefix)
            for prefix in prefixes
            if missing.startswith(prefix)
        }
        matches = [candidate for candidate in candidates if candidate in merged]
        if len(matches) == 1:
            merged[missing] = merged[matches[0]]
    return merged


def _classify_verification_failure(message: str, *, expected_pass: bool) -> str:
    """Separate a broken verifier program from evidence against the answer.

    A TypeError in model-written checking code says nothing about the math.
    An assertion is potentially useful evidence, but when the verifier itself
    predicted pass we ask a second, logical adjudicator before discarding and
    regenerating a stable solution.
    """
    if message.startswith("verify 返回 False"):
        return "unconfirmed_assertion" if expected_pass else "solution_failure"
    verifier_fault_prefixes = (
        "执行错误:",
        "语法错误",
        "verify 函数定义阶段出错:",
        "代码里没有",
        "没找到可调用",
        "verify 代码使用了禁止",
        "verify 返回",
    )
    if message.startswith(verifier_fault_prefixes):
        return "verifier_fault"
    if message.startswith("断言失败:") and expected_pass:
        return "unconfirmed_assertion"
    return "solution_failure"


def _format_steps_for_prompt(steps: Any) -> str:
    """Render solution steps as a compact markdown list for the prompt."""
    if not isinstance(steps, list) or not steps:
        return "(无解题步骤)"
    lines = []
    for i, s in enumerate(steps, start=1):
        if isinstance(s, dict):
            desc = s.get("description") or ""
            op = s.get("operation") or ""
            res = s.get("result") or ""
            lines.append(f"{i}. {desc} | 运算: {op} | 结果: {res}")
        else:
            lines.append(f"{i}. {s}")
    return "\n".join(lines)


def _parse_logical_audit(section: str) -> tuple[bool, str, dict[str, Any]]:
    """Require explicit evidence for a non-executable verification verdict."""
    verdict = (md.get_field(section, "结论", "verdict") or "").strip().lower()
    premise_checks = md.get_bullets(md.find_section(section, "前提与条件覆盖"))
    step_checks = md.get_bullets(md.find_section(section, "步骤审计"))
    boundary_checks = md.get_bullets(md.find_section(section, "边界与反例"))
    independent_checks = md.get_bullets(md.find_section(section, "独立检查"))
    evidence = {
        "premise_checks": premise_checks,
        "step_checks": step_checks,
        "boundary_checks": boundary_checks,
        "independent_checks": independent_checks,
    }
    passing_word = verdict in {"pass", "passed", "通过", "成立"}
    missing = [name for name, items in evidence.items() if not items]
    if missing:
        return False, "逻辑审计缺少证据区：" + ", ".join(missing), evidence
    if not passing_word:
        return False, f"逻辑审计结论未通过：{verdict or '未声明'}", evidence
    return True, "逻辑审计通过", evidence


def _parse_consistency_audit(text: str) -> tuple[bool, list[str], list[str]] | None:
    payload = md.parse_json_anywhere(text)
    if not isinstance(payload, dict) or not isinstance(payload.get("consistent"), bool):
        return None
    issues = payload.get("issues") or []
    checked = payload.get("checked_claims") or []
    if not isinstance(issues, list) or not isinstance(checked, list):
        return None
    return (
        payload["consistent"],
        [str(item) for item in issues if str(item).strip()],
        [str(item) for item in checked if str(item).strip()],
    )


class VerifySolutionTool(ITool):
    def __init__(self, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "verify_solution"

    @property
    def description(self) -> str:
        return (
            "为当前解答选择可检查的验证机制：可执行约束用沙箱 Python assert，"
            "其余结论做前提、逐步推理、边界/反例和独立路径审计。不是题型分类。"
            "验证通过后才允许进入视觉规划。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文（缺省取会话题目）"},
                "answer": {
                    "type": "string",
                    "description": "已知答案（缺省取 state.solution_answer）",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        answer = args.get("answer") or ctx.state.get("solution_answer") or ""
        steps = ctx.state.get("solution_steps") or []
        if not problem:
            return ToolResult(success=False, summary="缺少题目", error="empty_problem")
        if not answer:
            return ToolResult(success=False, summary="缺少答案", error="empty_answer")

        # If verify failed previously, include that as feedback so the LLM
        # writes a more thorough verification this round.
        prev_failure = (
            ctx.state.get("last_verify_failure")
            or ctx.state.get("last_verify_format_failure")
            or ""
        )
        previous_failure_section = ""
        if prev_failure:
            previous_failure_section = (
                "\n## ⚠️ 上次验证失败原因\n"
                f"{prev_failure[:400]}\n"
                "本轮请重新抽数值并重写 verify 函数（确保覆盖全部题面条件）。\n"
            )
        if ctx.state.get("force_logical_verification"):
            previous_failure_section += (
                "\n本轮必须使用 logical 模式并完整输出四个证据区，不要再输出 executable JSON。\n"
            )

        prompt = self._prompts.render(
            "verify_solution",
            problem=problem,
            answer=answer,
            steps_text=_format_steps_for_prompt(steps),
            previous_failure_section=previous_failure_section,
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.1,
                # Verification is structured + small Python output. 3K
                # plenty even with thinking on.
                max_tokens=3072,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception as exc:
            logger.exception("verify_solution LLM call failed")
            return ToolResult(success=False, summary="校验调用失败", error=str(exc))

        text = (getattr(done, "text", "") or "") or (getattr(done, "reasoning", "") or "")
        section = md.find_section(text, "验证", level=2) or md.find_section(text, "验证")
        if section is None:
            self._record_format_failure(ctx, "无法解析 ## 验证 section")
            return ToolResult(
                success=False,
                summary="无法解析 ## 验证 section",
                error="parse_failed",
                data={"raw": text[:500]},
            )

        mode = (
            (md.get_field(section, "验证模式", "verification_mode", "mode") or "").strip().lower()
        )
        if mode in {"logical", "logic", "逻辑审计", "proof-audit"}:
            passed, message, evidence = _parse_logical_audit(section)
            ctx.state["solution_verified"] = passed
            if passed:
                ctx.state.pop("last_verify_failure", None)
                self._clear_format_failure(ctx)
            else:
                ctx.state["last_verify_failure"] = message
            return ToolResult(
                success=passed,
                summary=message,
                data={"passed": passed, "message": message, "mode": "logical", **evidence},
                error=None if passed else message,
            )

        # Tolerant extraction: search for balanced JSON after each label.
        # Handles same-line / next-line / fenced / multi-line cases the
        # earlier `md.get_field` (which only takes value-to-end-of-line)
        # missed. See user-reported bad_data_fields case.
        problem_data = _extract_json_after_label(
            section, "题目数值", "problem_data", "题目 数值", "题目"
        )
        answer_data = _extract_json_after_label(
            section, "答案数值", "answer_data", "答案 数值", "答案"
        )
        # Last-resort: scan whole section for two distinct JSON blocks
        if problem_data is None or answer_data is None:
            blocks: list[dict] = []
            scan_pos = 0
            while True:
                obj = _find_balanced_json(section, scan_pos)
                if obj is None:
                    break
                blocks.append(obj)
                # Move past this block: find where it was and skip
                idx = section.find("{", scan_pos)
                if idx < 0:
                    break
                # Crude advance: jump past a chunk of text
                scan_pos = idx + len(json.dumps(obj, ensure_ascii=False))
                if scan_pos >= len(section):
                    break
            # Heuristic: first block = problem_data, second = answer_data
            if problem_data is None and len(blocks) >= 1:
                problem_data = blocks[0]
            if answer_data is None and len(blocks) >= 2:
                answer_data = blocks[1]

        if problem_data is None or answer_data is None:
            message = "题目数值 / 答案数值 字段无法解析为 JSON 或安全算术字面量"
            self._record_format_failure(ctx, message)
            return ToolResult(
                success=False,
                summary=message,
                error="bad_data_fields",
                data={
                    "problem_data": problem_data,
                    "answer_data": answer_data,
                    "section_head": section[:600],
                },
            )

        code = _extract_python_block(section)
        if not code:
            self._record_format_failure(ctx, "没找到 Python 验证代码块")
            return ToolResult(
                success=False,
                summary="没找到 ```python``` 代码块",
                error="no_code_block",
            )

        merged_data = {**problem_data, **answer_data}
        # Preserve both the flat schema requested by most verifiers and the
        # nested role schema occasionally emitted by local models. These are
        # aliases of already-declared values, never inferred mathematics.
        merged_data.setdefault("problem", problem_data)
        merged_data.setdefault("answer", answer_data)
        merged_data = _add_safe_data_aliases(code, merged_data)
        passed, message = _safe_exec_verify(code, merged_data)

        consistency_issues: list[str] = []
        checked_claims: list[str] = []
        consistency_audit_warning: str | None = None
        # Executable constraints can pass even when a separate explanatory
        # sentence is wrong. Audit the complete student-facing contract before
        # allowing the visual planner to amplify it.
        if passed:
            audit_prompt = self._prompts.render(
                "audit_solution_consistency",
                problem=problem,
                steps_text=_format_steps_for_prompt(steps),
                answer=answer,
            )
            try:
                audit_done = await self._llm.chat_complete(
                    messages=[ChatMessage(role="user", content=audit_prompt)],
                    temperature=0.0,
                    max_tokens=1536,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
                audit_text = (getattr(audit_done, "text", "") or "") or (
                    getattr(audit_done, "reasoning", "") or ""
                )
                audit = _parse_consistency_audit(audit_text)
            except Exception as exc:
                logger.exception("solution consistency audit failed")
                audit = None
                consistency_audit_warning = f"独立一致性审计调用失败: {exc}"
            if audit is None:
                # A critic transport/format defect is not evidence that a
                # solution is wrong. The executable verifier already checked
                # the answer against independently derived constraints, so
                # keep that result and surface a warning instead of wasting
                # the one solve fallback on another stochastic rewrite.
                consistency_audit_warning = (
                    consistency_audit_warning
                    or "独立一致性审计返回格式无效，已保留可执行验证结论"
                )
            else:
                consistent, consistency_issues, checked_claims = audit
                if not consistent:
                    passed = False
                    message = "解答内部不一致：" + (
                        consistency_issues[0]
                        if consistency_issues
                        else "审计判定失败但未给出具体问题"
                    )

        # Match LLM's "expected" claim against actual outcome — a healthy
        # signal that the model is calibrated about its own answer quality.
        expected = (md.get_field(section, "预期", "expected") or "").lower()
        expected_pass = "通过" in expected or "pass" in expected

        # Persist outcome to state for downstream tools to read. Broken
        # verifier code is retried as verification, never as re-solving.
        # A self-contradictory assertion gets one independent logical audit.
        if passed:
            ctx.state["solution_verified"] = True
            ctx.state.pop("last_verify_failure", None)
            self._clear_format_failure(ctx)
        else:
            ctx.state["solution_verified"] = False
            failure_kind = _classify_verification_failure(message, expected_pass=expected_pass)
            if failure_kind == "verifier_fault":
                ctx.state.pop("last_verify_failure", None)
                self._record_format_failure(ctx, message)
            elif failure_kind == "unconfirmed_assertion":
                ctx.state.pop("last_verify_failure", None)
                ctx.state["last_verify_format_failure"] = (
                    "验证器的 assert 与其自身预期冲突，需要 logical 模式独立裁决：" + message
                )
                ctx.state["force_logical_verification"] = True
            else:
                ctx.state["last_verify_failure"] = message

        return ToolResult(
            success=passed,  # SuccessTrue iff verify actually passes
            summary=(
                f"自校验：{'通过' if passed else '失败'}"
                + (f"（模型预期：{expected}）" if expected and (expected_pass != passed) else "")
                + (f"（{consistency_audit_warning}）" if consistency_audit_warning else "")
                + (f"——{message[:80]}" if not passed else "")
            ),
            data={
                "passed": passed,
                "message": message,
                "mode": "executable",
                "problem_data": problem_data,
                "answer_data": answer_data,
                "expected": expected,
                "expected_matched_actual": expected_pass == passed,
                "verify_code": code,
                "consistency_issues": consistency_issues,
                "checked_claims": checked_claims,
                "consistency_audit_warning": consistency_audit_warning,
            },
            error=None if passed else message,
        )

    @staticmethod
    def _record_format_failure(ctx: ToolContext, message: str) -> None:
        count = int(ctx.state.get("verify_format_failure_count") or 0) + 1
        ctx.state["verify_format_failure_count"] = count
        ctx.state["last_verify_format_failure"] = message
        if count >= 2:
            ctx.state["force_logical_verification"] = True

    @staticmethod
    def _clear_format_failure(ctx: ToolContext) -> None:
        ctx.state.pop("verify_format_failure_count", None)
        ctx.state.pop("last_verify_format_failure", None)
        ctx.state.pop("force_logical_verification", None)
