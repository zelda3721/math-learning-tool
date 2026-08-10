"""The solve prompt must force executable Math IR, not prose about it.

Motivation (real regression): "求 y = sin(2x+1) 的导数" produced a correct
answer and a reasonable narration, but the solve stage only emitted prose
steps plus LaTeX.  No `differentiate` operation was declared, so
`_verified_math_operations` stayed empty, the deterministic calculus builders
never fired, and the plan fell back to invented geometry — a labelled point
that lies on neither curve and "tangent" lines whose slopes are fiction.

These are template-content tests plus deterministic execution of the examples
the template teaches.  No LLM is involved.
"""
from __future__ import annotations

import json
import re
from typing import Any

from math_tutor.application.interfaces import ToolContext
from math_tutor.infrastructure.agent.math_runtime import execute_math_request
from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
from math_tutor.infrastructure.agent.tools.visual_plan import (
    build_composition_visual_plan,
    build_derivative_visual_plan,
)

_JSON_BLOCK_RE = re.compile(r"```json\n(.*?)```", re.DOTALL)


def _solve_template() -> str:
    return PromptLibrary().get("solve")


def _runnable_examples(template: str) -> list[dict[str, Any]]:
    """Concrete (non-schema) JSON requests embedded in a prompt template.

    Schema blocks spell `op` as `evaluate|simplify|...` and use placeholder
    names, so they are skipped; everything else is a worked example the model
    is being told to imitate and therefore must actually execute.
    """
    examples: list[dict[str, Any]] = []
    for block in _JSON_BLOCK_RE.findall(template):
        try:
            payload = json.loads(block)
        except json.JSONDecodeError:
            continue
        operations = payload.get("operations")
        if not isinstance(operations, list) or not operations:
            continue
        if any("|" in str(operation.get("op", "")) for operation in operations):
            continue
        examples.append(payload)
    return examples


def test_solve_prompt_mandates_an_executable_op_for_calculus_style_tasks() -> None:
    template = _solve_template()

    assert "可执行运算必须声明" in template
    # The five executable actions and their required ops must be named together
    # so a small local model cannot read the rule as advisory.
    for action in ("求导", "求积分", "求极限", "化简", "解方程"):
        assert action in template
    for op in ("differentiate", "integrate", "limit", "simplify", "solve"):
        assert f"`{op}`" in template
    assert "必须" in template
    # Prose-only derivations are explicitly disqualified.
    assert "链式法则" in template
    assert "不合格" in template


def test_solve_prompt_bans_latex_inside_math_ir_expressions() -> None:
    template = _solve_template()

    assert "表达式书写纪律" in template
    for latex in ("\\sin", "\\frac", "$"):
        assert latex in template
    assert "2*x" in template
    assert "`2x`" in template  # implicit multiplication called out as illegal
    assert "LaTeX 只允许出现在给孩子看的 描述 / 解释 / 最终答案 文字里" in template


def test_solve_prompt_encourages_declaring_inner_and_outer_layers() -> None:
    template = _solve_template()

    assert "复合函数" in template
    assert "inner" in template and "outer" in template
    # Encouraged, not mandatory — the deterministic builder can decompose on
    # its own, so a missing declaration must never cost a repair round.
    assert "推荐，不强制" in template
    # A newly introduced intermediate symbol has to be declared or the whole
    # request fails to parse and the gate closes again.
    assert "symbols" in template


def test_solve_prompt_derivative_example_is_the_real_regression_case() -> None:
    template = _solve_template()

    assert "sin(2*x + 1)" in template
    assert "2*cos(2*x + 1)" in template
    assert '"op": "differentiate"' in template
    assert '"variable": "x"' in template


def test_every_worked_example_in_the_solve_prompt_actually_executes() -> None:
    examples = _runnable_examples(_solve_template())
    assert examples, "the solve prompt must carry at least one runnable example"

    for payload in examples:
        evidence = execute_math_request(payload).to_dict()
        assert evidence["success"] is True, (payload, evidence["errors"])
        assert evidence["all_claims_passed"] is True, (payload, evidence["claims"])


def test_prompt_derivative_example_opens_the_deterministic_calculus_gate() -> None:
    """End-to-end on the exact case that shipped fake geometry.

    Executing the request the prompt now demands is enough for the verified
    builders to take over, so the plan carries a `grounding_source` instead of
    LLM-invented coordinates.
    """
    request = next(
        payload
        for payload in _runnable_examples(_solve_template())
        if any(operation.get("op") == "differentiate" for operation in payload["operations"])
    )
    evidence = execute_math_request(request).to_dict()
    state = {
        "solution_verified": True,
        "solution_answer": "2*cos(2*x + 1)",
        "solve_math_request": request,
        "solve_math_evidence": evidence,
    }
    ctx = ToolContext("session", 3, "high", "求 y = sin(2x+1) 的导数", state)

    derivative_plan = build_derivative_visual_plan(ctx)
    assert derivative_plan is not None
    assert derivative_plan["grounding_source"] == "calculus_derivative"

    composition_plan = build_composition_visual_plan(ctx)
    assert composition_plan is not None
    assert composition_plan["grounding_source"] == "calculus_composition"


def test_prose_only_solution_leaves_the_gate_shut() -> None:
    """The negative example the prompt forbids, encoded as a test.

    Without a declared operation there is no verified evidence, and the
    builders must refuse rather than invent a tangent.
    """
    state = {
        "solution_verified": True,
        "solution_answer": "2cos(2x+1)",
        "solution_steps": [
            {
                "description": "设 u = 2x + 1",
                "operation": "根据链式法则求导",
                "result": "y' = 2cos(2x+1)",
            }
        ],
    }
    ctx = ToolContext("session", 3, "high", "求 y = sin(2x+1) 的导数", state)

    assert build_derivative_visual_plan(ctx) is None
    assert build_composition_visual_plan(ctx) is None


def test_verify_prompt_mirrors_the_executable_op_rule() -> None:
    """Verify-stage Math IR overrides solve-stage evidence downstream.

    `_verified_math_operations` reads `verify_math_request` first, so a verify
    request that only re-evaluates the candidate answer would close the gate
    again even when solve did the right thing.
    """
    template = PromptLibrary().get("verify_solution")

    assert "可执行运算必须声明" in template
    assert '"op": "differentiate"' in template
    assert "sin(2*x + 1)" in template
    assert "2*cos(2*x + 1)" in template
    assert "表达式书写纪律" in template
    assert "\\frac" in template
