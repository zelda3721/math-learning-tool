"""Geometric truth: a drawing that contradicts its own function never ships.

Motivating incident (real, 2026-08-09).  "求 y = sin(2x+1) 的导数" produced a
SceneSpec with a correct answer, a sensible narration — and invented geometry:
a labelled point on neither curve, a "tangent" drawn horizontally where the
real slope is cos(0.5) = 0.878, and a second "tangent" whose slope was -1.682
where the real derivative is 2cos(2) = -0.832.  `grounding_source` was None:
the deterministic constructor never fired, so nothing recomputed the picture.

These tests hold the checker to the discipline the incident demands: it must
catch fabricated geometry from any source, must not fire on honest geometry,
and must stay silent when an expression cannot be recomputed at all — a claim
that cannot be checked is skipped, never blamed.
"""
from __future__ import annotations

import math
from typing import Any

from math_tutor.application.interfaces import ToolContext
from math_tutor.infrastructure.agent.tools import visual_plan as vp
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _geometric_truth_violations,
    _validate_plan,
    build_composition_visual_plan,
    build_derivative_visual_plan,
    build_integral_visual_plan,
    build_limit_visual_plan,
)


def _plan(*objects: dict[str, Any]) -> dict[str, Any]:
    return {"visual_objects": list(objects)}


def _curve(
    object_id: str,
    expression: str,
    *,
    variable: str = "x",
    x_range: list[float] | None = None,
    label: str = "",
) -> dict[str, Any]:
    return {
        "id": object_id,
        "primitive": "function_curve",
        "meaning": f"函数 {expression}",
        "label": label or f"y = {expression}",
        "params": {
            "expression": expression,
            "variable": variable,
            "x_range": x_range if x_range is not None else [-1, 3],
        },
    }


def _axes(y_range: list[float]) -> dict[str, Any]:
    return {
        "id": "axes",
        "primitive": "axes",
        "meaning": "坐标参照",
        "label": "",
        "params": {"x_range": [-1, 3], "y_range": y_range},
    }


# The plan the live system actually delivered, transcribed from the incident.
def _sin_2x_plus_1_fabricated_plan() -> dict[str, Any]:
    return _plan(
        _axes([-1.5, 1.5]),
        _curve("base_curve", "sin(x)", label="y = sin(x)"),
        # The director wrote implicit multiplication; the gate must still be
        # able to recompute it rather than silently skipping the whole check.
        _curve("compressed_curve", "sin(2x+1)", label="y = sin(2x+1)"),
        {
            "id": "reading_point",
            "primitive": "dot",
            "meaning": "两条曲线上要比较斜率的观察点",
            "label": "x = 0.5",
            "params": {"x": 0.5, "y": 0},
        },
        {
            "id": "base_tangent",
            "primitive": "line",
            "meaning": "sin(x) 在观察点处的切线",
            "label": "切线",
            "params": {"points": [[0.5, 0.479], [1.5, 0.479]]},
        },
        {
            "id": "compressed_tangent",
            "primitive": "line",
            "meaning": "sin(2x+1) 在观察点处的切线，更陡",
            "label": "切线",
            "params": {"points": [[0.5, 0.841], [1.5, -0.841]]},
        },
    )


def test_real_sin_2x_plus_1_plan_is_convicted_of_inventing_geometry() -> None:
    violations = _geometric_truth_violations(_sin_2x_plus_1_fabricated_plan())

    blamed = " ".join(violations)
    # The marked point sits on neither curve: sin(0.5)=0.479, sin(2)=0.909.
    assert "reading_point" in blamed
    assert "0.4794" in blamed and "0.9093" in blamed
    # A horizontal "tangent" where the real slope is cos(0.5)=0.8776 ...
    assert "base_tangent" in blamed
    assert "0.8776" in blamed
    # ... and a second one whose slope is nowhere near 2cos(2)=-0.8323.
    assert "compressed_tangent" in blamed
    assert "-0.8323" in blamed
    assert len(violations) == 3


def test_fabricated_geometry_blocks_the_plan_through_validate_plan() -> None:
    """Geometry lies must travel the same repair/degrade path as structural
    defects — otherwise they reach a child unchallenged."""
    plan = _sin_2x_plus_1_fabricated_plan()

    errors = _validate_plan(plan, "high")

    for violation in _geometric_truth_violations(plan):
        assert violation in errors


def test_true_tangent_and_true_point_are_not_flagged() -> None:
    at_x = 0.5
    value = math.sin(at_x)
    slope = math.cos(at_x)
    plan = _plan(
        _axes([-1.5, 1.5]),
        _curve("base_curve", "sin(x)"),
        {
            "id": "touch_point",
            "primitive": "dot",
            "meaning": "曲线上的切点",
            "label": "",
            "params": {"x": at_x, "y": round(value, 4)},
        },
        {
            "id": "true_tangent",
            "primitive": "line",
            "meaning": "sin(x) 在该点的切线",
            "label": "切线",
            "params": {
                "points": [
                    [at_x - 0.5, round(value - slope * 0.5, 4)],
                    [at_x + 0.5, round(value + slope * 0.5, 4)],
                ]
            },
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_root_on_the_x_axis_is_legitimate_but_a_fake_root_is_not() -> None:
    honest = _plan(
        _curve("parabola", "x**2 - 4", x_range=[-3, 3]),
        {
            "id": "roots",
            "primitive": "dot",
            "meaning": "曲线与 x 轴的交点，即确定性求解得到的实根",
            "label": "x = ±2",
            "params": {"positions": [[-2, 0], [2, 0]]},
        },
    )
    assert _geometric_truth_violations(honest) == []

    invented = _plan(
        _curve("parabola", "x**2 - 4", x_range=[-3, 3]),
        {
            "id": "roots",
            "primitive": "dot",
            "meaning": "曲线与 x 轴的交点，即确定性求解得到的实根",
            "label": "x = 1",
            "params": {"positions": [[1, 0]]},
        },
    )
    assert len(_geometric_truth_violations(invented)) == 1
    assert "roots" in _geometric_truth_violations(invented)[0]


def test_axis_annotation_at_y_zero_is_not_read_as_an_on_curve_claim() -> None:
    """A tick that marks a position on the x-axis claims nothing about height;
    punishing it would push directors away from honest annotation."""
    plan = _plan(
        _curve("wave", "sin(x)"),
        {
            "id": "x_marker",
            "primitive": "dot",
            "meaning": "在横轴上标出要考察的自变量位置",
            "label": "x = 0.5",
            "params": {"x": 0.5, "y": 0},
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_single_curve_makes_a_floating_height_a_claim_about_that_curve() -> None:
    """With one curve on screen, a dot at a non-zero height is read in that
    curve's frame — the incident's directors never write "on the curve", they
    just place the mark."""
    plan = _plan(
        _curve("wave", "sin(x)"),
        {
            "id": "reading",
            "primitive": "dot",
            "meaning": "标出这一点",
            "label": "",
            "params": {"x": 0.5, "y": 0.9},  # sin(0.5) = 0.479
        },
    )

    violations = _geometric_truth_violations(plan)
    assert len(violations) == 1
    assert "reading" in violations[0]


def test_counted_unit_dots_are_not_coordinate_claims() -> None:
    """A group of interchangeable counting units is laid out for counting, not
    read against a function; flagging it would punish elementary plans."""
    plan = _plan(
        _curve("wave", "sin(x)"),
        {
            "id": "apples",
            "primitive": "dot",
            "meaning": "5 个苹果",
            "label": "5",
            "params": {"x": 0.5, "y": 0.9, "count": 5},
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_hollow_limit_marker_is_exempt() -> None:
    """An open dot states "the function is not this value here"; checking it
    against the curve would punish a correct removable-discontinuity drawing."""
    plan = _plan(
        _curve("ratio", "(x**2 - 1)/(x - 1)", x_range=[-1, 3]),
        {
            "id": "limit_marker",
            "primitive": "dot",
            "meaning": "目标位置上的极限高度；空心表示该点函数值本身未定义",
            "label": "",
            "params": {"x": 1, "y": 2, "open": True},
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_tangent_primitive_slope_must_equal_the_derivative() -> None:
    honest = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "tangent",
            "primitive": "tangent_line",
            "meaning": "x=2 处的切线",
            "label": "f'(2) = 4",
            "params": {
                "expression": "x**2",
                "variable": "x",
                "at_x": 2,
                "slope": 4,
                "start": [1, 0],
                "end": [3, 8],
            },
        },
    )
    assert _geometric_truth_violations(honest) == []

    lying = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "tangent",
            "primitive": "tangent_line",
            "meaning": "x=2 处的切线",
            "label": "f'(2) = 3",
            "params": {
                "expression": "x**2",
                "variable": "x",
                "at_x": 2,
                "slope": 3,
                "start": [1, 1],
                "end": [3, 7],
            },
        },
    )
    messages = " ".join(_geometric_truth_violations(lying))
    assert "斜率" in messages and "4" in messages


def test_tangent_primitive_must_touch_the_curve_at_its_own_point() -> None:
    """Right slope, wrong altitude: a parallel line floating above the curve."""
    plan = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "tangent",
            "primitive": "tangent_line",
            "meaning": "x=2 处的切线",
            "label": "f'(2) = 4",
            "params": {
                "expression": "x**2",
                "variable": "x",
                "at_x": 2,
                "slope": 4,
                "start": [1, 3],
                "end": [3, 11],
            },
        },
    )

    violations = _geometric_truth_violations(plan)
    assert len(violations) == 1
    assert "没有经过切点" in violations[0]


def test_secant_slope_must_be_the_average_rate_of_change() -> None:
    honest = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "secant",
            "primitive": "secant_line",
            "meaning": "间隔 h=1 的割线",
            "label": "",
            "params": {
                "expression": "x**2",
                "variable": "x",
                "x0": 2,
                "h": 1,
                "slope": 5,
                "start": [2, 4],
                "end": [3, 9],
            },
        },
    )
    assert _geometric_truth_violations(honest) == []

    lying = {**honest}
    lying["visual_objects"] = [
        honest["visual_objects"][0],
        {
            **honest["visual_objects"][1],
            "params": {**honest["visual_objects"][1]["params"], "slope": 4},
        },
    ]
    messages = " ".join(_geometric_truth_violations(lying))
    assert "割线斜率是编的" in messages

    misplaced = {
        "visual_objects": [
            honest["visual_objects"][0],
            {
                **honest["visual_objects"][1],
                "params": {
                    **honest["visual_objects"][1]["params"],
                    "end": [3, 7],
                },
            },
        ]
    }
    assert any("割线端点" in item for item in _geometric_truth_violations(misplaced))


def test_secant_labelled_two_point_line_must_join_two_curve_points() -> None:
    honest = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "secant_segment",
            "primitive": "line",
            "meaning": "连接曲线上两点的割线",
            "label": "割线",
            "params": {"points": [[1, 1], [3, 9]]},
        },
    )
    assert _geometric_truth_violations(honest) == []

    lying = _plan(
        _curve("parabola", "x**2", x_range=[0, 4]),
        {
            "id": "secant_segment",
            "primitive": "line",
            "meaning": "连接曲线上两点的割线",
            "label": "割线",
            "params": {"points": [[1, 1], [3, 5]]},
        },
    )
    assert any("割线" in item for item in _geometric_truth_violations(lying))


def test_riemann_rectangle_heights_must_be_real_function_values() -> None:
    def rects(heights: list[float]) -> dict[str, Any]:
        edges = [(0.0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0)]
        return {
            "id": "rects",
            "primitive": "riemann_rects",
            "meaning": "累积面积的矩形",
            "label": "",
            "params": {
                "expression": "x**2",
                "variable": "x",
                "x_range": [0, 2],
                "n": 4,
                "side": "mid",
                "approx_area": sum(
                    height * (right - left)
                    for height, (left, right) in zip(heights, edges)
                ),
                "rects": [
                    [left, right, height]
                    for height, (left, right) in zip(heights, edges)
                ],
            },
        }

    true_heights = [((left + right) / 2) ** 2 for left, right in
                    ((0.0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0))]
    assert _geometric_truth_violations(
        _plan(_curve("parabola", "x**2", x_range=[0, 2]), rects(true_heights))
    ) == []

    inflated = [*true_heights[:2], true_heights[2] + 0.9, true_heights[3]]
    violations = _geometric_truth_violations(
        _plan(_curve("parabola", "x**2", x_range=[0, 2]), rects(inflated))
    )
    assert len(violations) == 1
    assert "第 3 个黎曼矩形" in violations[0]


def test_riemann_area_must_equal_the_rectangles_actually_drawn() -> None:
    edges = [(0.0, 1.0), (1.0, 2.0)]
    heights = [(left + right) / 2 for left, right in edges]  # f(x) = x, mid rule
    plan = _plan(
        _curve("ramp", "x", x_range=[0, 2]),
        {
            "id": "rects",
            "primitive": "riemann_rects",
            "meaning": "累积面积的矩形",
            "label": "",
            "params": {
                "expression": "x",
                "variable": "x",
                "x_range": [0, 2],
                "n": 2,
                "side": "mid",
                "approx_area": 3.5,  # the drawn rectangles sum to 2.0
                "rects": [
                    [left, right, height]
                    for height, (left, right) in zip(heights, edges)
                ],
            },
        },
    )

    violations = _geometric_truth_violations(plan)
    assert len(violations) == 1
    assert "近似面积" in violations[0]


def test_unparsable_expression_is_skipped_rather_than_blamed() -> None:
    """Silence on the uncheckable is the whole discipline: a checker that
    guesses would reject honest drawings and teach directors to omit the
    expression that makes checking possible in the first place."""
    plan = _plan(
        _curve("mystery", "wobble(x) + spline(x)"),
        {
            "id": "reading_point",
            "primitive": "dot",
            "meaning": "曲线上的观察点",
            "label": "",
            "params": {"x": 0.5, "y": 42},
        },
        {
            "id": "tangent",
            "primitive": "line",
            "meaning": "该点的切线",
            "label": "切线",
            "params": {"points": [[0, 0], [1, 99]]},
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_gate_ignores_plans_without_any_curve() -> None:
    plan = _plan(
        {
            "id": "bar",
            "primitive": "quantity_bar",
            "meaning": "已验证的数量",
            "label": "26",
            "params": {"value": 26},
        },
        {
            "id": "units",
            "primitive": "unit_grid",
            "meaning": "单位方块",
            "label": "",
            "params": {"count": 12},
        },
    )

    assert _geometric_truth_violations(plan) == []


def test_deterministic_calculus_constructors_pass_their_own_gate() -> None:
    """The gate is source-agnostic: the trusted constructors must survive it,
    or the gate is measuring the wrong thing."""
    from tests.unit.agent.test_calculus_visual_plans import (
        _derivative_state,
        _verified_state,
    )

    derivative_plan = build_derivative_visual_plan(
        ToolContext("s", 3, "high", "求导", _derivative_state("sin(2*x+1)", "2*cos(2*x+1)", 0.5))
    )
    assert derivative_plan is not None
    assert _geometric_truth_violations(derivative_plan) == []

    integral_plan = build_integral_visual_plan(
        ToolContext(
            "s",
            3,
            "high",
            "求定积分",
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
        )
    )
    assert integral_plan is not None
    assert _geometric_truth_violations(integral_plan) == []

    limit_plan = build_limit_visual_plan(
        ToolContext(
            "s",
            3,
            "high",
            "求极限",
            _verified_state(
                [
                    {
                        "id": "l",
                        "op": "limit",
                        "expression": "(x**2 - 1)/(x - 1)",
                        "variable": "x",
                        "point": 1,
                    }
                ],
                [{"id": "l", "result": "2"}],
            ),
        )
    )
    assert limit_plan is not None
    assert _geometric_truth_violations(limit_plan) == []

    # The very problem from the incident, now built deterministically.
    composition_plan = build_composition_visual_plan(
        ToolContext(
            "s",
            3,
            "high",
            "求 y = sin(2x+1) 的导数",
            _verified_state(
                [
                    {
                        "id": "d",
                        "op": "differentiate",
                        "expression": "sin(2*x+1)",
                        "variable": "x",
                    }
                ],
                [{"id": "d", "result": "2*cos(2*x+1)"}],
            ),
        )
    )
    assert composition_plan is not None
    assert _geometric_truth_violations(composition_plan) == []


def test_salvage_drops_the_fabricated_tangent_and_keeps_the_true_curve() -> None:
    """Honest degradation: show the real curve and say less, rather than hand a
    child a picture whose slopes are invented."""
    candidate = _sin_2x_plus_1_fabricated_plan()
    candidate.update(
        {
            "visual_thesis": "把 sin(x) 横向压缩成 sin(2x+1)，斜率随之乘 2",
            "essence_rationale": "学生看到压缩后同一段曲线走得更快，斜率因此加倍。",
            "symbol_ledger": ["蓝色曲线 = sin(x)", "橙色曲线 = sin(2x+1)"],
            "scenes": [],
            "forbidden": ["只写导数公式", "画装饰性直线"],
        }
    )
    ctx = ToolContext(
        "s",
        3,
        "high",
        "求 y = sin(2x+1) 的导数",
        {"solution_verified": True, "solution_answer": "2cos(2x+1)"},
    )

    salvaged = vp.build_safe_visual_plan(candidate, ctx)

    assert salvaged is not None
    kept = {str(item["id"]) for item in salvaged["visual_objects"]}
    # The honestly computed curves survive; every invented mark is gone.
    assert "base_curve" in kept and "compressed_curve" in kept
    assert kept.isdisjoint({"base_tangent", "compressed_tangent", "reading_point"})
    assert _geometric_truth_violations(salvaged) == []
    assert _validate_plan(salvaged, "high") == []
