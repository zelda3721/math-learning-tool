"""verify_solution — self-verification of math solutions.

After solve_problem produces an answer, this tool asks the LLM to write a
Python verify(data) function that checks the answer against the problem's
numeric constraints, then executes it in a restricted sandbox.

Why this matters: LLMs can produce plausible-looking answers that don't
actually satisfy the problem. For chicken-rabbit, the LLM might say
"chickens=20, rabbits=15" with full reasoning, but 20+15=35 ✓ and
20×2+15×4=100 ≠ 94 ✗ — the answer is wrong. Self-verification via code
catches these silently-wrong answers before we waste 60s rendering a video
that teaches the wrong answer.

This is the "self-debugging via test cases" pattern (Chen et al. 2023,
arxiv 2304.05128) applied to math word problems.

Output is markdown:
  ## 验证
  **题目数值** (JSON)
  **答案数值** (JSON)
  **预期**: 通过 / 失败
  **预期理由**: ...
  ### 验证函数
  ```python
  def verify(data): ...
  ```
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
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


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
    """Pull the largest ```python ... ``` block out of model output."""
    m_iter = list(re.finditer(r"```python\n(.*?)```", text, re.DOTALL))
    if not m_iter:
        m_iter = list(re.finditer(r"```\n(.*?)```", text, re.DOTALL))
    if not m_iter:
        return ""
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
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else None
        except Exception:
            pass
    # search for a {...} block anywhere
    matches = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", s)
    for m in matches:
        try:
            obj = json.loads(m)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


def _safe_exec_verify(
    code: str, data: dict[str, Any]
) -> tuple[bool, str]:
    """Execute the verify function in a restricted namespace.

    Returns (passed, message). `passed=True` only when verify(data) returns
    True without raising. Any AssertionError, runtime error, or non-True
    return marks it failed.
    """
    if not code or "def verify" not in code:
        return False, "代码里没有 def verify(...) 函数"

    # Static checks: no imports, no dunders, no eval/exec
    forbidden_patterns = [
        r"\bimport\s+\w+",
        r"\bfrom\s+\w+\s+import",
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

    # Compile first to catch syntax errors with nice line numbers
    try:
        compiled = compile(code, "<verify>", "exec")
    except SyntaxError as exc:
        return False, f"语法错误 line {exc.lineno}: {exc.msg}"

    namespace: dict[str, Any] = {"__builtins__": _SAFE_BUILTINS}
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
            "数值化验证答案：让 LLM 写 Python verify(data) 函数把题目条件"
            "用 assert 检查一遍，沙箱执行。在 solve_problem 之后调一次——"
            "答案算错时抓得到（避免后续 60s 渲染白费）。失败返回具体 assert "
            "信息，可拼成 error_hint 喂回 solve_problem 重做。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文（缺省取会话题目）"},
                "answer": {"type": "string", "description": "已知答案（缺省取 state.solution_answer）"},
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
        prev_failure = ctx.state.get("last_verify_failure") or ""
        previous_failure_section = ""
        if prev_failure:
            previous_failure_section = (
                "\n## ⚠️ 上次验证失败原因\n"
                f"{prev_failure[:400]}\n"
                "本轮请重新抽数值并重写 verify 函数（确保覆盖全部题面条件）。\n"
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
            return ToolResult(
                success=False,
                summary="无法解析 ## 验证 section",
                error="parse_failed",
                data={"raw": text[:500]},
            )

        problem_data = _parse_json_field(md.get_field(section, "题目数值", "problem_data"))
        answer_data = _parse_json_field(md.get_field(section, "答案数值", "answer_data"))
        if problem_data is None or answer_data is None:
            return ToolResult(
                success=False,
                summary="题目数值 / 答案数值 字段无法解析为 JSON",
                error="bad_data_fields",
                data={"problem_data": problem_data, "answer_data": answer_data},
            )

        code = _extract_python_block(section)
        if not code:
            return ToolResult(
                success=False,
                summary="没找到 ```python``` 代码块",
                error="no_code_block",
            )

        merged_data = {**problem_data, **answer_data}
        passed, message = _safe_exec_verify(code, merged_data)

        # Persist outcome to state for downstream tools to read.
        if passed:
            ctx.state["solution_verified"] = True
            ctx.state.pop("last_verify_failure", None)
        else:
            ctx.state["solution_verified"] = False
            ctx.state["last_verify_failure"] = message

        # Match LLM's "expected" claim against actual outcome — a healthy
        # signal that the model is calibrated about its own answer quality.
        expected = (md.get_field(section, "预期", "expected") or "").lower()
        expected_pass = "通过" in expected or "pass" in expected

        return ToolResult(
            success=passed,  # SuccessTrue iff verify actually passes
            summary=(
                f"自校验：{'通过' if passed else '失败'}"
                + (f"（模型预期：{expected}）" if expected and (expected_pass != passed) else "")
                + (f"——{message[:80]}" if not passed else "")
            ),
            data={
                "passed": passed,
                "message": message,
                "problem_data": problem_data,
                "answer_data": answer_data,
                "expected": expected,
                "expected_matched_actual": expected_pass == passed,
                "verify_code": code,
            },
            error=None if passed else message,
        )
