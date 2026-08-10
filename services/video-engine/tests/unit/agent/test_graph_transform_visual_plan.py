"""The graph-transformation incident, pinned as tests.

A high-school student asked how the graph of ``y = sin(2x+1)`` comes from
``y = sin(x)``.  The prose answer talked about sliding and compressing the
curve; the SceneSpec that shipped was a quantity bar and two empty rectangles
labelled "乘积", grounded in arithmetic scraped out of the written solution.
Nothing in the picture was about a graph at all.

Two halves are checked here.  First, a constructor that draws the
transformation for real: three sampled curves and the same tracked points
carried across both steps, with the horizontal slide computed from
``f(ax + b) = f(a(x + b/a))`` so it is b/a and never b — exactly the step this
topic exists to teach.  Second, a quantity fallback that abstains when the
verified evidence is a function being reshaped rather than an amount being
counted, so the empty boxes cannot come back through the salvage path.
"""
from __future__ import annotations

import asyncio
from typing import Any

from math_tutor.application.interfaces import ToolContext, ToolResult
from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _geometric_truth_violations,
    _real_value_at,
    _validate_plan,
    _verified_arithmetic_candidate,
    build_composition_visual_plan,
    build_graph_transform_visual_plan,
    build_grounded_math_visual_plan,
    build_quantity_story_visual_plan,
    build_safe_visual_plan,
)

INCIDENT_PROBLEM = (
    "y = sin(2x+1) 是怎么由 sin 和 2x+1 复合出来的？"
    "函数图像是怎么从 y = sin(x) 变换过来的？"
)
INCIDENT_ANSWER = "先向左平移 1/2 个单位，再把横坐标缩短为原来的 1/2"
# The arithmetic the written solution happens to contain.  It is genuinely
# verified — and it is the evidence that became two rectangles named "乘积".
INCIDENT_STEPS: list[dict[str, str]] = [
    {
        "description": "把 2x+1 改写成 2(x + 1/2)",
        "operation": "1 ÷ 2 = 0.5",
        "result": "平移量 0.5",
    },
    {
        "description": "横坐标压缩为原来的一半",
        "operation": "2 × 1 = 2",
        "result": "2",
    },
]


def _math_ir_state(expression: str = "sin(2*x + 1)") -> dict[str, Any]:
    """Verified Math IR of the shape a session about this question produces."""
    return {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {"id": "f", "op": "evaluate", "expression": expression, "variable": "x"},
                {
                    "id": "value",
                    "op": "substitute",
                    "expression": "$f",
                    "substitutions": {"x": 0},
                },
            ],
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [
                {"id": "f", "result": expression},
                {"id": "value", "result": "0.8414709848078965"},
            ],
        },
    }


def _incident_ctx(**state_overrides: Any) -> ToolContext:
    state: dict[str, Any] = {
        "solution_verified": True,
        "solution_answer": INCIDENT_ANSWER,
        "solution_steps": [dict(step) for step in INCIDENT_STEPS],
    }
    state.update(state_overrides)
    return ToolContext("s", 3, "high", INCIDENT_PROBLEM, state)


def _curves(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in plan["visual_objects"] if item["primitive"] == "function_curve"
    ]


def _object(plan: dict[str, Any], object_id: str) -> dict[str, Any]:
    return next(item for item in plan["visual_objects"] if item["id"] == object_id)


def test_graph_transform_plan_replaces_the_empty_product_boxes() -> None:
    """The incident itself: this question now has a picture about the graph."""
    plan = build_graph_transform_visual_plan(_incident_ctx())

    assert plan is not None
    assert plan["grounding_source"] == "graph_transform"
    assert plan["grounded_from_math_execution"] is True
    assert _validate_plan(plan, "high") == []

    # Base, intermediate and final: the transformation is a sequence, not a
    # before/after pair.
    curves = _curves(plan)
    assert len(curves) >= 3
    expressions = [item["params"]["expression"] for item in curves]
    assert expressions[0] == "sin(x)"
    assert expressions[-1] == "sin(2*x+1)"

    # Nothing from the incident survives: no counting vocabulary at all.
    primitives = {item["primitive"] for item in plan["visual_objects"]}
    assert primitives.isdisjoint({"quantity_bar", "unit_grid"})
    assert "乘积" not in str(plan)


def test_graph_transform_plan_also_reads_the_expression_from_verified_math_ir() -> None:
    """Prose is a convenience; Math IR is the preferred source of the form."""
    plan = build_graph_transform_visual_plan(
        ToolContext("s", 3, "high", "这个函数的图像是怎么变换来的？", _math_ir_state())
    )

    assert plan is not None
    assert plan["grounding_source"] == "graph_transform"
    assert _object(plan, "graph_transform_result")["params"]["expression"] == (
        "sin(2*x + 1)"
    )


def test_horizontal_slide_is_b_over_a_and_never_b() -> None:
    """The whole point of the topic: after compressing, the slide is 1/2."""
    plan = build_graph_transform_visual_plan(_incident_ctx())
    assert plan is not None

    result_curve = _object(plan, "graph_transform_result")
    assert result_curve["params"]["scale"] == 2.0
    # b/a = 1/2. The wrong answer this constructor exists to prevent is 1.
    assert result_curve["params"]["shift"] == 0.5
    assert _object(plan, "graph_transform_result_points")["params"]["shift"] == 0.5

    slide_arrows = [
        item
        for item in plan["visual_objects"]
        if str(item["id"]).startswith("graph_transform_slide_")
    ]
    assert slide_arrows
    for arrow in slide_arrows:
        assert arrow["params"]["shift"] == 0.5
        start, end = arrow["params"]["start"], arrow["params"]["end"]
        # Drawn leftwards by exactly b/a, at unchanged height.
        assert abs((start[0] - end[0]) - 0.5) < 1e-9
        assert start[1] == end[1]

    # And the narration must say why, naming both the right and the wrong
    # number, because "1" is the answer a student reaches on their own.
    slide_beat = plan["scenes"][2]
    assert slide_beat["role"] == "transform"
    line = slide_beat["teaching_line"]
    assert "b ÷ a" in line and "1/2" in line and "而不是 b = 1" in line
    assert "sin(2(x + 1/2))" in line


def test_every_drawn_curve_is_a_true_sample_of_its_expression() -> None:
    """Recompute the three curves and the tracked points from scratch.

    The intermediate curve is *not* the answer curve — that is the point of
    the beat.  What must hold is the correspondence: sliding the intermediate
    curve left by b/a lands exactly on sin(2x+1), and every tracked point keeps
    the height it started with on sin(x).
    """
    plan = build_graph_transform_visual_plan(_incident_ctx())
    assert plan is not None

    base = _object(plan, "graph_transform_base")["params"]["expression"]
    middle = _object(plan, "graph_transform_scaled")["params"]["expression"]
    final = _object(plan, "graph_transform_result")["params"]["expression"]

    for x in (-2.0, -0.75, 0.0, 0.4, 1.3):
        truth = _real_value_at("sin(2*x + 1)", "x", x)
        assert truth is not None
        # The final curve is the asked function.
        assert abs(_real_value_at(final, "x", x) - truth) < 1e-9
        # The intermediate curve reaches the same value half a unit later:
        # f(2(x + 1/2)) = f(2x + 1).
        assert abs(_real_value_at(middle, "x", x + 0.5) - truth) < 1e-9
        # And the base curve reaches it at 2x + 1.
        assert abs(_real_value_at(base, "x", 2 * x + 1) - truth) < 1e-9

    tracked = [
        _object(plan, f"graph_transform_{stage}_points")["params"]["positions"]
        for stage in ("base", "scaled", "result")
    ]
    assert len({len(group) for group in tracked}) == 1
    for (source_x, height), (middle_x, _), (final_x, _) in zip(*tracked):
        assert abs(_real_value_at(base, "x", source_x) - height) < 1e-3
        assert abs(_real_value_at(middle, "x", middle_x) - height) < 1e-3
        assert abs(_real_value_at(final, "x", final_x) - height) < 1e-3
        # One point, two moves: compress, then slide by exactly b/a.
        assert abs(middle_x - source_x / 2.0) < 1e-6
        assert abs(final_x - (middle_x - 0.5)) < 1e-6


def test_graph_transform_plan_passes_the_geometric_truth_gate() -> None:
    for ctx in (
        _incident_ctx(),
        ToolContext("s", 3, "high", "图像如何变换", _math_ir_state()),
        ToolContext("s", 3, "high", "y = (x-3)**2 的图像怎么平移得到？", {}),
    ):
        plan = build_graph_transform_visual_plan(ctx)
        assert plan is not None
        assert _geometric_truth_violations(plan) == []
        assert _validate_plan(plan, "high") == []


def test_pure_translation_needs_no_scaling_beat() -> None:
    """a = 1: there is nothing to compress, and the slide is b itself."""
    plan = build_graph_transform_visual_plan(
        ToolContext("s", 3, "high", "y = (x + 3)**2 的图像由 y = x**2 怎么平移？", {})
    )

    assert plan is not None
    assert len(_curves(plan)) == 2
    assert "graph_transform_scaled" not in {
        item["id"] for item in plan["visual_objects"]
    }
    assert _object(plan, "graph_transform_result")["params"]["shift"] == 3.0
    assert _validate_plan(plan, "high") == []


def test_graph_transform_plan_abstains_without_a_linear_inner_map() -> None:
    # A composite whose inner map is not linear is not a graph translation.
    assert (
        build_graph_transform_visual_plan(
            ToolContext("s", 3, "high", "sin(x**2) 的图像", {})
        )
        is None
    )
    # A basic function is already its own graph; nothing was transformed.
    assert (
        build_graph_transform_visual_plan(
            ToolContext("s", 3, "high", "y = sin(x) 的图像", {})
        )
        is None
    )
    # No expression anywhere: the constructor never guesses one.
    assert (
        build_graph_transform_visual_plan(
            ToolContext("s", 3, "high", "描述一下图像的平移变换", {})
        )
        is None
    )
    # The abstraction ceiling by audience still applies.
    assert build_graph_transform_visual_plan(_incident_ctx_elementary()) is None


def _incident_ctx_elementary() -> ToolContext:
    return ToolContext(
        "s",
        3,
        "elementary_upper",
        INCIDENT_PROBLEM,
        {"solution_verified": True, "solution_answer": INCIDENT_ANSWER},
    )


def test_quantity_fallback_refuses_the_incident_arithmetic() -> None:
    """The empty "乘积" boxes cannot be built from this evidence any more."""
    ctx = _incident_ctx()

    assert _verified_arithmetic_candidate(ctx) is None
    assert build_safe_visual_plan(None, ctx) is None

    # Same arithmetic, a question that really is about an amount: the quantity
    # chain still builds, so the refusal is about the semantics of the
    # evidence and not a blanket disabling of the fallback.
    counting_ctx = ToolContext(
        "s",
        3,
        "middle",
        "一盒有 1 个，取 2 盒，一共几个？",
        {
            "solution_verified": True,
            "solution_answer": "2",
            "solution_steps": [dict(step) for step in INCIDENT_STEPS],
        },
    )
    counting_plan = _verified_arithmetic_candidate(counting_ctx)
    assert counting_plan is not None
    assert counting_plan["grounding_source"] == "verified_solution_arithmetic"
    # This is precisely the shape the incident shipped — proof that the guard,
    # not some unrelated precondition, is what silences it above.
    assert "乘积" in str(counting_plan["visual_objects"])


def test_grounded_curve_fallback_refuses_a_graph_transformation_question() -> None:
    """The generic neighbourhood lowering yields to the transformation."""
    incident = ToolContext("s", 3, "high", INCIDENT_PROBLEM, _math_ir_state())
    assert build_grounded_math_visual_plan(incident) is None

    # The very same Math IR under a question about a value still lowers, so
    # the abstention is driven by what was asked, not by the evidence being
    # unusable.
    valued = ToolContext("s", 3, "high", "求这个函数在 0 处的值", _math_ir_state())
    assert build_grounded_math_visual_plan(valued) is not None


def test_symbolic_evidence_never_becomes_counting_graphics() -> None:
    """A free variable under a symbolic operation is not an amount."""
    state = {
        "solution_verified": True,
        "solution_answer": "2",
        "solution_steps": [dict(step) for step in INCIDENT_STEPS],
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "d",
                    "op": "differentiate",
                    "expression": "x**3 + 5",
                    "variable": "x",
                }
            ],
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "d", "result": "3*x**2"}],
        },
    }
    ctx = ToolContext("s", 3, "high", "求这个函数的导函数", state)

    assert _verified_arithmetic_candidate(ctx) is None


def test_direct_video_directs_the_incident_deterministically() -> None:
    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=False, summary="不应被调用", error="parse_failed")

    ctx = _incident_ctx(**_math_ir_state())
    planner = Planner()

    result = asyncio.run(DirectVideoTool(planner).execute({}, ctx))  # type: ignore[arg-type]

    assert result.success is True
    assert planner.calls == 0
    assert result.data["grounding_source"] == "graph_transform"
    assert ctx.state["visual_plan"]["grounding_source"] == "graph_transform"


def test_non_transform_questions_keep_their_existing_constructors() -> None:
    """No land grab: the new constructor only claims transformation questions."""
    story_ctx = ToolContext(
        "s",
        3,
        "elementary",
        "小明有5个苹果，吃了2个，还剩几个？",
        {
            "solution_verified": True,
            "solution_answer": "3",
            "quantity_story": {
                "relation": "take_away",
                "entity": "苹果",
                "first": 5,
                "second": 2,
                "result": 3,
            },
            "solve_math_request": {
                "engine": "sympy",
                "operations": [{"id": "calc", "op": "evaluate", "expression": "5 - 2"}],
            },
            "solve_math_evidence": {
                "success": True,
                "all_claims_passed": True,
                "operations": [{"id": "calc", "op": "evaluate", "result": "3"}],
            },
        },
    )
    story = build_quantity_story_visual_plan(story_ctx)
    assert story is not None and story["grounding_source"] == "quantity_story"
    assert build_graph_transform_visual_plan(story_ctx) is None

    # A composition question about the same expression still reads as x → u → y
    # when nothing in it asks how the graph moved.
    composition_ctx = ToolContext(
        "s", 3, "high", "复合函数是怎么合成的", _math_ir_state()
    )
    composition = build_composition_visual_plan(composition_ctx)
    assert composition is not None
    assert composition["grounding_source"] == "calculus_composition"
