from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from math_tutor.application.interfaces import ToolContext
from math_tutor.infrastructure.agent.math_runtime import (
    evaluate_real_expression_at,
    execute_math_request,
    sample_real_expression,
)
from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
from math_tutor.infrastructure.agent.tools.solve_problem import _execute_declared_math
from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool


def test_math_runtime_executes_exact_symbolic_chain_and_claims() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"u": {"domain": "real"}},
            "operations": [
                {
                    "id": "expanded",
                    "op": "expand",
                    "expression": "(u + 2)**2",
                },
                {
                    "id": "derivative",
                    "op": "differentiate",
                    "expression": "$expanded",
                    "variable": "u",
                },
            ],
            "claims": [
                {
                    "id": "derivative_check",
                    "relation": "equivalent",
                    "left": "$derivative",
                    "right": "2*u + 4",
                }
            ],
        }
    )

    assert result.success is True
    assert result.all_claims_passed is True
    assert result.operations[-1]["result"] == "2*u + 4"


def test_math_runtime_supports_open_capabilities_without_question_routing() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"k": {"domain": "integer"}},
            "operations": [
                {
                    "id": "finite_sum",
                    "op": "summation",
                    "expression": "k",
                    "variable": "k",
                    "bounds": [1, 8],
                },
                {
                    "id": "matrix_value",
                    "op": "determinant",
                    "expression": [[1, 2], [3, 4]],
                },
            ],
            "claims": [
                {"relation": "equal", "left": "$finite_sum", "right": 36},
                {"relation": "equal", "left": "$matrix_value", "right": -2},
            ],
        }
    )

    assert result.success is True
    assert result.all_claims_passed is True


def test_math_runtime_rejects_arbitrary_python_and_reports_false_claims() -> None:
    unsafe = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {},
            "operations": [
                {
                    "id": "unsafe",
                    "op": "evaluate",
                    "expression": "__import__('os').system('id')",
                }
            ],
            "claims": [],
        }
    )
    assert unsafe.success is False
    assert "unsupported expression node" in unsafe.errors[0]

    false_claim = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {},
            "operations": [{"id": "value", "op": "evaluate", "expression": "7*6"}],
            "claims": [{"relation": "equal", "left": "$value", "right": 41}],
        }
    )
    assert false_claim.success is True
    assert false_claim.all_claims_passed is False
    assert false_claim.claims[0]["passed"] is False


def test_math_runtime_normalizes_bare_prior_operation_references() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "numerator_derivative",
                    "op": "differentiate",
                    "expression": "sin(x)",
                    "variable": "x",
                },
                {
                    "id": "denominator_derivative",
                    "op": "differentiate",
                    "expression": "x",
                    "variable": "x",
                },
                {
                    "id": "ratio",
                    "op": "simplify",
                    "expression": "numerator_derivative / denominator_derivative",
                },
                {
                    "id": "result",
                    "op": "limit",
                    "expression": "$ratio",
                    "variable": "x",
                    "point": 0,
                },
            ],
            "claims": [{"relation": "equal", "left": "$result", "right": 1}],
        }
    )

    assert result.success is True
    assert result.all_claims_passed is True


def test_math_runtime_supports_composite_values_and_safe_result_selectors() -> None:
    composite = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {},
            "operations": [
                {
                    "id": "values",
                    "op": "evaluate",
                    "expression": ["1 + 1", "3 * 4"],
                }
            ],
            "claims": [],
        }
    )
    assert composite.success is True
    assert composite.operations[0]["result"] == ["2", "12"]

    selected_root = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "function",
                    "op": "evaluate",
                    "expression": "x**2 - 4*x + 3",
                },
                {
                    "id": "derivative",
                    "op": "differentiate",
                    "expression": "$function",
                    "variable": "x",
                },
                {
                    "id": "critical_points",
                    "op": "solve",
                    "expression": "$derivative",
                    "variable": "x",
                },
                {
                    "id": "minimum",
                    "op": "substitute",
                    "expression": "$function",
                    "variable": "x",
                    "substitution": "$critical_points[0]",
                },
            ],
            "claims": [{"relation": "equal", "left": "$minimum", "right": -1}],
        }
    )
    assert selected_root.success is True
    assert selected_root.all_claims_passed is True
    assert selected_root.operations[2]["result"] == ["2"]


def test_math_runtime_supports_keyed_selection_for_multivariable_solutions() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {
                "x": {"domain": "real"},
                "y": {"domain": "real"},
            },
            "operations": [
                {
                    "id": "solution",
                    "op": "solve",
                    "expression": ["x + y - 5", "x - y - 1"],
                    "variables": ["x", "y"],
                },
                {
                    "id": "selected_x",
                    "op": "evaluate",
                    "expression": "$solution[0].x",
                },
            ],
            "claims": [{"relation": "equal", "left": "$selected_x", "right": 3}],
        }
    )
    assert result.success is True
    assert result.all_claims_passed is True


def test_math_runtime_normalizes_safe_sympy_shorthand_without_repair() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "defined",
                    "op": "define",
                    "expression": "x**2 - 4*x + 3",
                },
                {
                    "id": "root",
                    "op": "solve",
                    "expression": "diff(x**2 - 4*x + 3, x)",
                    "variable": "x",
                },
                {
                    "id": "value",
                    "op": "subs",
                    "expression": "$defined",
                    "substitutions": {"x": "$root[0]"},
                },
            ],
            "claims": [
                {
                    "id": "minimum",
                    "relation": "equal",
                    "left": "$value",
                    "right": "-1",
                }
            ],
        }
    )

    assert result.success is True
    assert result.all_claims_passed is True


def test_math_runtime_compares_composite_solve_results_symbolically() -> None:
    result = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "solutions",
                    "op": "solve",
                    "expression": "2**x - 8",
                    "variable": "x",
                }
            ],
            "claims": [
                {
                    "id": "solution_set",
                    "relation": "equal",
                    "left": "$solutions",
                    "right": "[3]",
                }
            ],
        }
    )

    assert result.success is True
    assert result.all_claims_passed is True
    assert result.claims[0]["left"] == ["3"]


def test_safe_expression_sampler_splits_discontinuities_without_eval() -> None:
    sine_segments = sample_real_expression(
        "sin(x)", start=-2, end=2, y_min=-2, y_max=2
    )
    assert len(sine_segments) == 1
    assert len(sine_segments[0]) >= 17

    unsafe = "__import__('os').system('id')"
    try:
        sample_real_expression(unsafe)
    except ValueError as exc:
        assert "unsupported" in str(exc)
    else:
        raise AssertionError("unsafe curve expression must be rejected")


def test_safe_point_evaluation_distinguishes_a_hole_from_a_value() -> None:
    assert evaluate_real_expression_at("sin(x)/x", point=0) is None
    assert evaluate_real_expression_at("sin(x)", point=0) == 0.0


def test_solver_extracts_declared_math_request_as_execution_evidence() -> None:
    done = SimpleNamespace(
        text="""## 确定性计算
```json
{
  "engine": "sympy",
  "symbols": {},
  "operations": [{"id": "answer", "op": "evaluate", "expression": "5/2"}],
  "claims": [{"relation": "equal", "left": "$answer", "right": "5/2"}]
}
```

## 解题
内容
""",
        reasoning="",
    )
    request, execution = _execute_declared_math(done)
    assert request is not None
    assert execution.all_claims_passed is True
    assert execution.operations[0]["result"] == "5/2"


def test_verify_solution_accepts_independent_math_ir_evidence() -> None:
    class LLM:
        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            return SimpleNamespace(
                text="""## 验证
**验证模式**: math_ir

### 计算请求
```json
{
  "engine": "sympy",
  "symbols": {"t": {"domain": "real"}},
  "operations": [
    {"id": "computed", "op": "simplify", "expression": "(t+t)/2"}
  ],
  "claims": [
    {"id": "answer_check", "relation": "equivalent", "left": "$computed", "right": "t"}
  ]
}
```
""",
                reasoning="",
            )

    ctx = ToolContext(
        session_id="s",
        turn_index=2,
        grade="advanced",
        problem="验证一个符号结论",
        state={
            "solution_answer": "t",
            "solution_steps": [{"description": "derive", "result": "t"}],
        },
    )
    result = asyncio.run(
        VerifySolutionTool(LLM(), PromptLibrary()).execute({}, ctx)  # type: ignore[arg-type]
    )

    assert result.success is True
    assert result.data is not None and result.data["mode"] == "math_ir"
    assert ctx.state["solution_verified"] is True
    assert ctx.state["verify_math_evidence"]["all_claims_passed"] is True
    assert result.artifacts[0].kind == "math_execution"
