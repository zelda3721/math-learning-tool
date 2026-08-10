"""Calculus visual vocabulary: verified Math IR must become drawable geometry.

Every assertion here checks provenance, not styling: the emitted primitives
must carry the expressions that were actually executed, and every number in
their params must be recomputed from that evidence rather than authored.
"""
from __future__ import annotations

import asyncio
from typing import Any

from math_tutor.application.interfaces import ToolContext, ToolResult
from math_tutor.infrastructure.agent.math_runtime import evaluate_real_expression_at
from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _validate_plan,
    build_composition_visual_plan,
    build_derivative_visual_plan,
    build_integral_visual_plan,
    build_limit_visual_plan,
)


def _verified_state(
    operations: list[dict[str, Any]], results: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": operations,
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": results,
        },
    }


def _derivative_state(
    expression: str, derivative: str, at_x: float
) -> dict[str, Any]:
    return _verified_state(
        [
            {"id": "f", "op": "evaluate", "expression": expression, "variable": "x"},
            {"id": "df", "op": "diff", "expression": "$f", "variable": "x"},
            {
                "id": "value",
                "op": "substitute",
                "expression": "$df",
                "substitutions": {"x": at_x},
            },
        ],
        [
            {"id": "f", "result": expression},
            {"id": "df", "result": derivative},
            {"id": "value", "result": str(at_x)},
        ],
    )


def _object(plan: dict[str, Any], object_id: str) -> dict[str, Any]:
    return next(item for item in plan["visual_objects"] if item["id"] == object_id)


def _objects_of(plan: dict[str, Any], primitive: str) -> list[dict[str, Any]]:
    return [item for item in plan["visual_objects"] if item["primitive"] == primitive]


def test_derivative_plan_collapses_secants_onto_the_verified_tangent() -> None:
    for expression, derivative, at_x in (("x**2", "2*x", 2.0), ("x**3", "3*x**2", 1.0)):
        ctx = ToolContext(
            "s", 3, "high", "求导", _derivative_state(expression, derivative, at_x)
        )

        plan = build_derivative_visual_plan(ctx)

        assert plan is not None
        assert plan["grounding_source"] == "calculus_derivative"
        assert _validate_plan(plan, "high") == []

        tangent = _object(plan, "derivative_tangent")
        assert tangent["primitive"] == "tangent_line"
        # Point and slope come from the evidence: the substitution names the
        # point, the verified derivative expression gives the slope there.
        assert tangent["params"]["expression"] == expression
        assert tangent["params"]["at_x"] == at_x
        expected_slope = evaluate_real_expression_at(derivative, variable="x", point=at_x)
        assert tangent["params"]["slope"] == round(expected_slope, 6)

        secants = _objects_of(plan, "secant_line")
        assert len(secants) >= 2
        offsets = [item["params"]["h"] for item in secants]
        assert offsets == sorted(offsets, reverse=True), "h must shrink beat by beat"
        for secant in secants:
            offset = secant["params"]["h"]
            near = evaluate_real_expression_at(expression, variable="x", point=at_x)
            far = evaluate_real_expression_at(expression, variable="x", point=at_x + offset)
            assert secant["params"]["slope"] == round((far - near) / offset, 6)
            assert secant["params"]["x0"] == at_x
        # The last secant is replaced by the tangent, one h per beat.
        transforms = [
            action
            for scene in plan["scenes"]
            for action in scene["actions"]
            if action["op"] == "transform"
        ]
        assert [action["result"] for action in transforms] == [
            *[item["id"] for item in secants[1:]],
            "derivative_tangent",
        ]


def test_derivative_plan_requires_verified_evidence() -> None:
    state = _derivative_state("x**2", "2*x", 2.0)
    state["verify_math_evidence"]["all_claims_passed"] = False

    assert build_derivative_visual_plan(ToolContext("s", 3, "high", "求导", state)) is None


def test_integral_plan_accumulates_rectangles_toward_the_verified_area() -> None:
    state = _verified_state(
        [
            {
                "id": "area",
                "op": "integrate",
                "expression": "x**2",
                "variable": "x",
                "bounds": [0, 2],
            }
        ],
        [{"id": "area", "result": "8/3"}],
    )
    ctx = ToolContext("s", 3, "high", "求定积分", state)

    plan = build_integral_visual_plan(ctx)

    assert plan is not None
    assert plan["grounding_source"] == "calculus_integral"
    assert _validate_plan(plan, "high") == []

    rects = _objects_of(plan, "riemann_rects")
    assert [item["params"]["n"] for item in rects] == [4, 8, 16]
    exact = 8 / 3
    previous_error = None
    for item in rects:
        params = item["params"]
        assert params["expression"] == "x**2"
        assert params["x_range"] == [0.0, 2.0]  # taken from the verified bounds
        assert len(params["rects"]) == params["n"]
        width = 2.0 / params["n"]
        # Every rectangle height is the integrand's real value at its sample.
        for index, (left, right, height) in enumerate(params["rects"]):
            assert round(right - left, 6) == round(width, 6)
            sample = left + width / 2
            assert height == round(
                evaluate_real_expression_at("x**2", variable="x", point=sample), 6
            )
            assert index == round(left / width)
        assert params["approx_area"] == round(
            sum((right - left) * height for left, right, height in params["rects"]), 6
        )
        error = abs(params["approx_area"] - exact)
        assert previous_error is None or error < previous_error
        previous_error = error
    assert previous_error is not None and previous_error < 0.01


def test_limit_plan_shows_two_sided_approach_to_the_verified_value() -> None:
    state = _verified_state(
        [
            {
                "id": "lim",
                "op": "limit",
                "expression": "sin(x)/x",
                "variable": "x",
                "point": 0,
            }
        ],
        [{"id": "lim", "result": "1"}],
    )
    ctx = ToolContext("s", 3, "high", "求极限", state)

    plan = build_limit_visual_plan(ctx)

    assert plan is not None
    assert plan["grounding_source"] == "calculus_limit"
    assert _validate_plan(plan, "high") == []

    approaches = _objects_of(plan, "limit_approach")
    assert [item["id"] for item in approaches] == ["limit_far", "limit_near"]
    for approach in approaches:
        params = approach["params"]
        assert params["expression"] == "sin(x)/x"
        assert params["target"] == 0.0
        assert params["from"] == "both"
        for side, sign in (("left", -1), ("right", 1)):
            assert len(params["points"][side]) == len(params["offsets"])
            for offset, point in zip(params["offsets"], params["points"][side]):
                sample = params["target"] + sign * offset
                assert point[0] == round(sample, 4)
                assert point[1] == round(
                    evaluate_real_expression_at("sin(x)/x", variable="x", point=sample), 4
                )
    # The nearest samples must actually be closer to the verified value than
    # the far ones, otherwise the picture would not be an argument.
    far = _object(plan, "limit_far")["params"]["points"]["right"][-1][1]
    near = _object(plan, "limit_near")["params"]["points"]["right"][-1][1]
    assert abs(near - 1.0) < abs(far - 1.0)
    assert _object(plan, "limit_near")["params"]["limit_value"] == 1.0
    marker = _object(plan, "limit_marker")
    # sin(x)/x is undefined at 0, so the limit point is drawn hollow.
    assert marker["params"] == {"x": 0.0, "y": 1.0, "open": True}


def test_limit_plan_keeps_divergence_visible_instead_of_inventing_a_value() -> None:
    state = _verified_state(
        [
            {
                "id": "lim",
                "op": "limit",
                "expression": "1/x**2",
                "variable": "x",
                "point": 0,
            }
        ],
        [{"id": "lim", "result": "oo"}],
    )

    plan = build_limit_visual_plan(ToolContext("s", 3, "high", "求极限", state))

    assert plan is not None
    assert _validate_plan(plan, "high") == []
    assert [item["id"] for item in plan["visual_objects"] if item["primitive"] == "line"] == []
    assert _object(plan, "limit_near")["params"]["divergent"] is True
    assert "limit_value" not in _object(plan, "limit_near")["params"]


def test_composition_plan_separates_inner_outer_and_composed_curves() -> None:
    state = _verified_state(
        [{"id": "f", "op": "evaluate", "expression": "sin(2*x + 1)", "variable": "x"}],
        [{"id": "f", "result": "sin(2*x + 1)"}],
    )

    plan = build_composition_visual_plan(ToolContext("s", 3, "high", "复合函数", state))

    assert plan is not None
    assert plan["grounding_source"] == "calculus_composition"
    assert _validate_plan(plan, "high") == []

    inner = _object(plan, "composition_inner")["params"]
    outer = _object(plan, "composition_outer")["params"]
    result = _object(plan, "composition_result")["params"]
    assert inner["expression"] == "2*x + 1" and inner["variable"] == "x"
    assert outer["expression"] == "sin(u)" and outer["variable"] == "u"
    assert result["expression"] == "sin(2*x + 1)"
    # The outer curve is plotted over the range u actually takes on, so all
    # three curves live in one coordinate frame.
    inner_values = [
        evaluate_real_expression_at("2*x + 1", variable="x", point=x)
        for x in (inner["x_range"][0], inner["x_range"][1])
    ]
    assert outer["x_range"][0] <= min(inner_values)
    assert outer["x_range"][1] >= max(inner_values)

    chain = _object(plan, "composition_chain")
    assert chain["primitive"] == "composition_chain"
    assert chain["params"]["outer"] == "sin(u)" and chain["params"]["inner"] == "2*x + 1"
    for sample in chain["params"]["samples"]:
        assert sample["u"] == round(
            evaluate_real_expression_at("2*x + 1", variable="x", point=sample["x"]), 4
        )
        assert sample["y"] == round(
            evaluate_real_expression_at("sin(2*x + 1)", variable="x", point=sample["x"]), 4
        )
    # x → u → y is a three-beat construction, not one finished picture.
    assert [scene["role"] for scene in plan["scenes"]][:3] == [
        "setup",
        "transform",
        "reveal",
    ]


def test_composition_plan_ignores_expressions_that_are_not_composite() -> None:
    state = _verified_state(
        [{"id": "f", "op": "evaluate", "expression": "2*x + 5", "variable": "x"}],
        [{"id": "f", "result": "2*x + 5"}],
    )

    assert build_composition_visual_plan(ToolContext("s", 3, "high", "线性", state)) is None


def test_composition_plan_yields_to_root_finding_when_the_question_solves() -> None:
    # Composite expression, but the verified question asks where it vanishes:
    # the zero-crossing argument owns that, not the x → u → y chain.
    state = _verified_state(
        [
            {"id": "f", "op": "evaluate", "expression": "sin(2*x + 1)", "variable": "x"},
            {"id": "roots", "op": "solve", "expression": "$f", "variable": "x"},
        ],
        [{"id": "f", "result": "sin(2*x + 1)"}, {"id": "roots", "result": ["-1/2"]}],
    )

    assert build_composition_visual_plan(ToolContext("s", 3, "high", "求零点", state)) is None


def test_direct_video_prefers_calculus_constructors_over_generic_grounding() -> None:
    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=False, summary="不应被调用", error="parse_failed")

    for state, expected in (
        (_derivative_state("x**2", "2*x", 2.0), "calculus_derivative"),
        (
            _verified_state(
                [
                    {
                        "id": "area",
                        "op": "integrate",
                        "expression": "x**2",
                        "variable": "x",
                        "bounds": [0, 2],
                    }
                ],
                [{"id": "area", "result": "8/3"}],
            ),
            "calculus_integral",
        ),
    ):
        ctx = ToolContext("s", 3, "high", "微积分题", state)
        planner = Planner()
        tool = DirectVideoTool(planner)  # type: ignore[arg-type]

        result = asyncio.run(tool.execute({}, ctx))

        assert result.success is True
        assert planner.calls == 0
        assert result.data["grounding_source"] == expected
        assert ctx.state["visual_plan"]["grounding_source"] == expected
