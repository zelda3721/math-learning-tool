"""One bounded compile stage: write → validate → render.

Static/semantic validation and Manim execution are compiler internals, not
agent planning stages.  A first production draft receives at most one
evidence-directed repair before the high-level stage returns.
"""

from __future__ import annotations

import json
import logging
import re
import textwrap
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from ..math_runtime import sample_real_expression
from .generate_manim_code import GenerateManimCodeTool

logger = logging.getLogger(__name__)
from .run_manim import RunManimTool
from .validate_manim_code import ValidateManimCodeTool


def _plain_fallback_text(value: Any) -> str:
    """Convert common math markup into glyphs safe for Manim Text."""
    text = str(value or "").strip()
    text = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", text)
    text = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"\1/\2", text)
    replacements = {
        r"\times": "×",
        r"\div": "÷",
        r"\cdot": "·",
        r"\le": "≤",
        r"\ge": "≥",
        r"\neq": "≠",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return re.sub(r"[$`{}]", "", text).replace("\\", "").strip()


def _wrap_fallback_text(value: Any, *, width: int = 26, max_lines: int = 4) -> str:
    text = " ".join(_plain_fallback_text(value).split())
    if not text:
        return ""
    actual_width = width if re.search(r"[\u3400-\u9fff]", text) else width * 2
    lines = textwrap.wrap(
        text,
        width=actual_width,
        break_long_words=True,
        break_on_hyphens=False,
    )
    if len(lines) > max_lines:
        lines = [*lines[: max_lines - 1], lines[max_lines - 1][: actual_width - 1] + "…"]
    wrapped = "\n".join(lines)
    # Chinese punctuation belongs to the preceding phrase.  Leaving it alone
    # on the next line creates a distracting pseudo-bullet in captions.
    wrapped = re.sub(r"\n([，。！？；：、])", r"\1\n", wrapped)
    return wrapped.strip()


def _fallback_relation_model(raw: Any, index: int) -> dict[str, Any]:
    """Build a universal relation model from one verified solution step."""
    if isinstance(raw, dict):
        description = _plain_fallback_text(raw.get("description"))
        operation = _plain_fallback_text(raw.get("operation"))
        result = _plain_fallback_text(raw.get("result"))
    else:
        description = _plain_fallback_text(raw)
        operation = ""
        result = ""

    number = r"-?\d+(?:\.\d+)?"
    arithmetic = re.search(
        rf"(?P<left>{number})\s*(?P<operator>[+\-−×÷*/])\s*"
        rf"(?P<right>{number})\s*=\s*(?P<output>{number})",
        operation,
    )
    title = _wrap_fallback_text(
        f"第{index}步：{description or result or operation}", width=25, max_lines=2
    )
    if arithmetic:
        operator = arithmetic.group("operator").replace("*", "×").replace("/", "÷")
        return {
            "mode": "quantity",
            "title": title,
            "operator": operator,
            "left_label": arithmetic.group("left"),
            "right_label": arithmetic.group("right"),
            "output_label": arithmetic.group("output"),
            "left_value": float(arithmetic.group("left")),
            "right_value": float(arithmetic.group("right")),
            "output_value": float(arithmetic.group("output")),
            "result": _wrap_fallback_text(result, width=25, max_lines=2),
        }

    if "=" in operation:
        left, right = operation.split("=", 1)
    else:
        left = operation or description or "已验证前提"
        right = result or "已验证结论"
    return {
        "mode": "relation",
        "title": title,
        "left": _wrap_fallback_text(left, width=16, max_lines=3),
        "right": _wrap_fallback_text(right, width=16, max_lines=3),
        "result": _wrap_fallback_text(result, width=25, max_lines=2),
    }


_FALLBACK_IR_PRIMITIVES = {
    "dot",
    "circle",
    "rectangle",
    "line",
    "function_curve",
    "arrow",
    "quantity_bar",
    "unit_grid",
    "number_line",
    "axes",
    "polygon",
    "relation_node",
    "balance",
    # 讲义原图的转写重画（引擎注入的确定性坐标：点+字母+线段+阴影）
    "figure",
}
_FALLBACK_IR_ACTIONS = {
    "create",
    "transform",
    "move",
    "highlight",
    "partition",
    "merge",
    "compare",
    "map",
    "measure",
    "verify",
    "remove",
    "take_from",
    "combine",
    "count",
    "recount_verify",
    "replicate",
    "swap_units",
    "balance_remove",
    "balance_divide",
    "balance_verify",
}
# Quantity-verb parameters that must survive IR extraction for the template.
_FALLBACK_IR_ACTION_FIELDS = (
    "source",
    "destination",
    "count",
    "style",
    "expect",
    "expect_total",
)


def _safe_ir_value(value: Any, depth: int = 0) -> Any:
    """Keep fallback IR bounded and JSON-only; it is never executed as code."""
    # 4 层：figure 的参数是 params→points→{id,at}→[x,y]，坐标在第 4 层。
    # 上限 3 时坐标会被砍成 None——图整个画不出来，而且没有任何报错。
    if depth > 4:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, list):
        return [_safe_ir_value(item, depth + 1) for item in value[:64]]
    if isinstance(value, dict):
        return {
            str(key)[:40]: _safe_ir_value(item, depth + 1) for key, item in list(value.items())[:24]
        }
    return str(value)[:120]


def _fallback_visual_ir(raw_plan: Any) -> dict[str, Any] | None:
    """Extract the topic-independent graphical contract for deterministic render."""
    if not isinstance(raw_plan, dict):
        return None
    raw_objects = raw_plan.get("visual_objects") or []
    raw_scenes = raw_plan.get("scenes") or []
    if not isinstance(raw_objects, list) or not isinstance(raw_scenes, list):
        return None

    objects: list[dict[str, Any]] = []
    object_ids: set[str] = set()
    for raw in raw_objects[:24]:
        if not isinstance(raw, dict):
            continue
        object_id = str(raw.get("id") or "").strip()
        primitive = str(raw.get("primitive") or "").strip().lower()
        meaning = _plain_fallback_text(raw.get("meaning"))
        if (
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", object_id)
            or object_id in object_ids
            or primitive not in _FALLBACK_IR_PRIMITIVES
            or not meaning
        ):
            continue
        object_ids.add(object_id)
        raw_label = raw.get("label") if "label" in raw else meaning
        objects.append(
            {
                "id": object_id,
                "primitive": primitive,
                "meaning": _wrap_fallback_text(meaning, width=18, max_lines=2),
                "label": _wrap_fallback_text(raw_label, width=14, max_lines=2),
                "color": str(raw.get("color") or "blue").strip().lower()[:24],
                "params": _safe_ir_value(raw.get("params") or {}),
            }
        )
    if len(objects) < 2:
        return None

    axes_object = next((item for item in objects if item.get("primitive") == "axes"), None)
    if axes_object is not None:
        axis_params = axes_object.get("params") or {}
        x_range = axis_params.get("x_range") or [-3, 3]
        y_range = axis_params.get("y_range") or [-2, 2]
        try:
            x_start, x_end = float(x_range[0]), float(x_range[1])
            y_start, y_end = float(y_range[0]), float(y_range[1])
        except (IndexError, TypeError, ValueError):
            return None
        for item in objects:
            if item.get("primitive") != "function_curve":
                continue
            params = item.get("params") or {}
            curve_range = params.get("x_range") or [x_start, x_end]
            try:
                expression = str(params.get("expression") or "").strip()
                variable = str(params.get("variable") or "x").strip()
                segments = sample_real_expression(
                    expression,
                    variable=variable,
                    start=float(curve_range[0]),
                    end=float(curve_range[1]),
                    y_min=y_start,
                    y_max=y_end,
                )
            except (IndexError, TypeError, ValueError):
                return None
            params["sampled_segments"] = segments
            item["params"] = params
        # The generated Scene needs the axes before converting data points to
        # screen coordinates, independent of the planner's object ordering.
        objects.sort(key=lambda item: item.get("primitive") != "axes")

    scenes: list[dict[str, Any]] = []
    for raw_scene in raw_scenes[:8]:
        if not isinstance(raw_scene, dict):
            continue
        actions: list[dict[str, Any]] = []
        for raw_action in (raw_scene.get("actions") or [])[:8]:
            if not isinstance(raw_action, dict):
                continue
            op = str(raw_action.get("op") or "").strip().lower()
            targets = [
                str(item) for item in (raw_action.get("targets") or []) if str(item) in object_ids
            ]
            result = str(raw_action.get("result") or "")
            if op not in _FALLBACK_IR_ACTIONS or not targets:
                continue
            extracted = {
                "op": op,
                "targets": targets,
                "result": result if result in object_ids else "",
                "meaning": _wrap_fallback_text(
                    raw_action.get("meaning") or raw_scene.get("action") or op,
                    width=24,
                    max_lines=2,
                ),
            }
            for field in _FALLBACK_IR_ACTION_FIELDS:
                value = raw_action.get(field)
                if isinstance(value, str):
                    value = value.strip()[:64]
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    value = int(value)
                else:
                    value = None
                if value not in (None, ""):
                    extracted[field] = value
            actions.append(extracted)
        if actions:
            try:
                duration_s = max(0.0, min(20.0, float(raw_scene.get("duration_s") or 0)))
            except (TypeError, ValueError):
                duration_s = 0.0
            scenes.append(
                {
                    "role": str(raw_scene.get("role") or "").lower(),
                    "teaching_line": _wrap_fallback_text(
                        raw_scene.get("teaching_line") or raw_scene.get("attention_target"),
                        width=30,
                        max_lines=2,
                    ),
                    "duration_s": duration_s,
                    "actions": actions,
                }
            )
    if len(scenes) < 2:
        return None
    return {"objects": objects, "scenes": scenes}


def _build_visual_ir_fallback_code(*, problem: str, answer: str, visual_ir: dict[str, Any]) -> str:
    """Compile generic Visual IR into conservative, deterministic Manim code."""
    template = r"""from manim import *
import math

PROBLEM_TEXT = __PROBLEM_JSON__
ANSWER_TEXT = __ANSWER_JSON__
VISUAL_OBJECTS = __OBJECTS_JSON__
VISUAL_SCENES = __SCENES_JSON__


class SolutionScene(Scene):
    COLOR_MAP = {
        "blue": BLUE, "green": GREEN, "yellow": YELLOW, "gold": GOLD,
        "orange": ORANGE, "red": RED, "purple": PURPLE, "teal": TEAL,
        "white": WHITE, "grey": GREY, "gray": GREY,
    }

    def fit(self, item, max_width=3.4, max_height=2.5):
        if item.width > max_width:
            item.scale_to_fit_width(max_width)
        if item.height > max_height:
            item.scale_to_fit_height(max_height)
        return item

    def number(self, value, default=1.0, low=-1000.0, high=1000.0):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return default
        if not math.isfinite(value):
            return default
        return min(max(value, low), high)

    def color(self, value):
        return self.COLOR_MAP.get(str(value).lower(), BLUE)

    def place_figure_label(self, mobj, x, y):
        # 阶梯避让：首选原位，太近（<0.6）依次试右/左/下/上等空位
        spots = [
            (0, 0), (0.65, 0), (-0.65, 0), (0, -0.5), (0, 0.5),
            (0.65, -0.5), (-0.65, 0.5), (1.15, 0), (-1.15, 0),
        ]
        cx, cy = x, y
        for dx, dy in spots:
            cx, cy = x + dx, y + dy
            if all(
                (cx - px) ** 2 + (cy - py) ** 2 > 0.36
                for px, py in self.placed_figure_labels
            ):
                break
        self.placed_figure_labels.append((cx, cy))
        mobj.move_to([cx, cy, 0])
        return mobj

    def geometry_point(self, point):
        center_x, center_y = self.geometry_center
        return [
            (self.number(point[0], 0) - center_x) * self.geometry_scale,
            (self.number(point[1], 0) - center_y) * self.geometry_scale,
            0,
        ]

    def labeled(self, body, spec):
        label_text = str(spec.get("label") or "").strip()
        if not label_text:
            return body
        label = Text(label_text, font_size=22, color=WHITE)
        self.fit(label, 3.0, 0.65)
        return VGroup(body, label).arrange(DOWN, buff=0.18)

    def repeat_count(self, params):
        raw = params.get("count")
        if isinstance(raw, bool) or raw is None:
            return 1
        try:
            return min(max(int(round(float(raw))), 1), 64)
        except (TypeError, ValueError):
            return 1

    def repeated_body(self, primitive, params, color, extra_row_gap=0.0):
        count = self.repeat_count(params)
        if count <= 1 or primitive not in {
            "dot", "circle", "rectangle", "line", "arrow", "polygon"
        }:
            return None
        units = []
        for _ in range(count):
            if primitive == "dot":
                unit = Dot(radius=0.105, color=color)
            elif primitive == "circle":
                unit = Circle(
                    radius=0.15, color=color,
                    fill_color=color, fill_opacity=0.2,
                )
            elif primitive == "rectangle":
                unit = Rectangle(
                    width=0.3, height=0.2, color=color,
                    fill_color=color, fill_opacity=0.2,
                )
            elif primitive == "line":
                unit = Line(DOWN * 0.15, UP * 0.15, color=color, stroke_width=3)
            elif primitive == "arrow":
                unit = Arrow(LEFT * 0.17, RIGHT * 0.17, color=color, buff=0)
            else:
                unit = RegularPolygon(
                    n=max(3, int(self.number(params.get("sides", 3), 3, 3, 8))),
                    radius=0.16, color=color,
                    fill_color=color, fill_opacity=0.18,
                )
            units.append(unit)
        columns = int(self.number(
            params.get("columns", math.ceil(math.sqrt(count * 1.45))),
            math.ceil(math.sqrt(count * 1.45)), 1, 10,
        ))
        rows = math.ceil(count / columns)
        body = VGroup(*units).arrange_in_grid(
            rows=rows, cols=columns, buff=(0.11, 0.13 + extra_row_gap),
        )
        return body

    def animate_create(self, object_id):
        item = self.objects[object_id]
        if object_id in self.coordinate_ids:
            body = self.object_bodies.get(object_id, item)
            label = self.object_labels.get(object_id)
            if isinstance(body, VGroup):
                animations = [Create(part) for part in body]
            elif isinstance(body, (VMobject, Axes, NumberLine)):
                animations = [Create(body)]
            else:
                animations = [FadeIn(body)]
            if label is not None:
                animations.append(FadeIn(label, shift=UP * 0.08))
            return AnimationGroup(*animations, lag_ratio=0.08)
        units = self.repeat_units.get(object_id)
        if units is None or len(units) <= 1:
            return FadeIn(item, shift=UP * 0.12)
        animations = [FadeIn(unit, scale=0.7) for unit in units]
        label = self.object_labels.get(object_id)
        if label is not None:
            animations.insert(0, FadeIn(label, shift=UP * 0.08))
        return LaggedStart(*animations, lag_ratio=min(0.08, 1.6 / len(animations)))

    def attach_per_unit_marks(self, marker_id, visible, new_ids):
        spec = self.specs[marker_id]
        params = spec.get("params") or {}
        per_unit = int(self.number(params.get("count_per_unit"), 0, 0, 6))
        if per_unit <= 0:
            return None
        candidates = [
            object_id for object_id in [*visible, *new_ids]
            if object_id != marker_id and object_id in self.repeat_units
        ]
        if not candidates:
            return None
        host_id = max(candidates, key=lambda item: len(self.repeat_units[item]))
        host_units = self.repeat_units[host_id]
        color = self.color(spec.get("color"))
        marks = VGroup()
        for unit in host_units:
            center = unit.get_center()
            # Legs hang from the unit's bottom edge — a circle with vertical
            # lines below reads as an individual with countable appendages.
            top_y = unit.get_bottom()[1] - 0.01
            for index in range(per_unit):
                offset = (index - (per_unit - 1) / 2) * 0.075
                mark = Line(
                    [center[0] + offset, top_y, 0],
                    [center[0] + offset, top_y - 0.16, 0],
                    color=color, stroke_width=2.5,
                )
                unit.add(mark)
                marks.add(mark)
        self.attached_ids.add(marker_id)
        self.attachment_hosts[marker_id] = host_id
        self.objects[marker_id] = marks
        # The host's entity label was positioned before the legs existed;
        # clear the bottom row's marks so the two never interleave.
        host_label = self.object_labels.get(host_id)
        if host_label is not None:
            host_label.shift(DOWN * 0.24)
        return LaggedStart(
            *[Create(mark) for mark in marks],
            lag_ratio=min(0.025, 1.2 / max(len(marks), 1)),
        )

    def prepare_coordinate_system(self):
        self.specs = {spec["id"]: spec for spec in VISUAL_OBJECTS}
        self.repeat_units = {}
        self.object_bodies = {}
        self.object_labels = {}
        self.attached_ids = set()
        self.attachment_hosts = {}
        self.mapped_into = {}
        self.partition_ratios = {}
        self.mapping_badges = {}
        self.mapping_evidence = {}
        self.comparison_badges = {}
        self.measurement_badges = {}
        self.unit_ledger = {}
        self.count_badges = {}
        self.balance_parts = {}
        self.deferred_creates = set()
        self.last_comparison_difference = None
        self.relation_values = []
        quantity_values = []
        for spec in VISUAL_OBJECTS:
            params = spec.get("params") or {}
            if spec.get("primitive") in {"relation_node", "line", "arrow"}:
                value = abs(self.number(
                    params.get(
                        "value",
                        params.get("length", params.get("count_per_unit")),
                    ),
                    0,
                    0,
                    1000,
                ))
                if value > 0:
                    self.relation_values.append(value)
            if spec.get("primitive") != "quantity_bar":
                continue
            quantity_values.append(abs(self.number(
                params.get("value", params.get("count", 0)), 0, 0, 1000,
            )))
        self.quantity_bar_max = max(quantity_values, default=1.0) or 1.0
        self.coordinate_ids = set()
        self.coordinate_models = {}
        self.coordinate_domains = {}
        self.coordinate_segments = {}
        self.height_models = {}
        self.geometry_plane_spec = next(
            (
                spec
                for spec in VISUAL_OBJECTS
                if spec.get("primitive") == "unit_grid"
                and isinstance((spec.get("params") or {}).get("x_range"), list)
                and isinstance((spec.get("params") or {}).get("y_range"), list)
            ),
            None,
        )
        self.geometry_scale = 1.0
        self.geometry_center = (0.0, 0.0)
        self.geometry_background = None
        # 图内标签的占位登记：区域数值/线段标签共享，太近就沿阶梯找空位。
        # 实机踩过：三块区域的重心挤在图形窄处，12/28/16 叠成一摞
        self.placed_figure_labels = []
        coordinate_points = []
        for spec in VISUAL_OBJECTS:
            primitive = spec.get("primitive")
            params = spec.get("params") or {}
            if primitive == "polygon":
                coordinate_points.extend(
                    point
                    for point in params.get("vertices") or []
                    if isinstance(point, list) and len(point) >= 2
                )
            if primitive in {"line", "arrow"}:
                coordinate_points.extend(
                    point
                    for point in (params.get("start"), params.get("end"))
                    if isinstance(point, list) and len(point) >= 2
                )
            if primitive == "figure":
                coordinate_points.extend(
                    item["at"]
                    for item in params.get("points") or []
                    if isinstance(item, dict)
                    and isinstance(item.get("at"), list)
                    and len(item["at"]) >= 2
                )
        if self.geometry_plane_spec is not None:
            plane_params = self.geometry_plane_spec.get("params") or {}
            x_range = plane_params.get("x_range") or [-3, 3]
            y_range = plane_params.get("y_range") or [-2, 2]
            if len(x_range) >= 2 and len(y_range) >= 2:
                x_start = self.number(x_range[0], -3)
                x_end = self.number(x_range[1], 3)
                y_start = self.number(y_range[0], -2)
                y_end = self.number(y_range[1], 2)
                coordinate_points.extend(
                    [[x_start, y_start], [x_end, y_end]]
                )
        if coordinate_points:
            x_values = [self.number(point[0], 0) for point in coordinate_points]
            y_values = [self.number(point[1], 0) for point in coordinate_points]
            x_start, x_end = min(x_values), max(x_values)
            y_start, y_end = min(y_values), max(y_values)
            x_span = max(x_end - x_start, 1.0)
            y_span = max(y_end - y_start, 1.0)
            x_margin = max(0.45, x_span * 0.08)
            y_margin = max(0.45, y_span * 0.08)
            x_start -= x_margin
            x_end += x_margin
            y_start -= y_margin
            y_end += y_margin
            self.geometry_scale = min(
                6.4 / (x_end - x_start),
                4.25 / (y_end - y_start),
            )
            self.geometry_center = (
                (x_start + x_end) / 2,
                (y_start + y_end) / 2,
            )
            for spec in VISUAL_OBJECTS:
                primitive = spec.get("primitive")
                params = spec.get("params") or {}
                has_vertices = (
                    primitive == "polygon"
                    and isinstance(params.get("vertices"), list)
                    and len(params.get("vertices")) >= 3
                )
                has_segment = (
                    primitive in {"line", "arrow"}
                    and isinstance(params.get("start"), list)
                    and isinstance(params.get("end"), list)
                )
                has_figure = (
                    primitive == "figure"
                    and isinstance(params.get("points"), list)
                    # 2 个点也算（纯辅助线的 overlay）：进不了坐标体系就会被
                    # 当自由对象缩小挪位，画在图外（实机踩过）
                    and len(params.get("points")) >= 2
                )
                if has_vertices or has_segment or has_figure:
                    self.coordinate_ids.add(spec["id"])
            if self.geometry_plane_spec is not None:
                self.coordinate_ids.add(self.geometry_plane_spec["id"])
            elif any(
                spec.get("primitive") == "polygon"
                for spec in VISUAL_OBJECTS
            ):
                self.geometry_background = NumberPlane(
                    x_range=[x_start, x_end, 1],
                    y_range=[y_start, y_end, 1],
                    x_length=(x_end - x_start) * self.geometry_scale,
                    y_length=(y_end - y_start) * self.geometry_scale,
                    background_line_style={
                        "stroke_color": GREY_D,
                        "stroke_width": 1,
                        "stroke_opacity": 0.28,
                    },
                    axis_config={
                        "stroke_color": GREY_B,
                        "stroke_width": 1.8,
                    },
                )
        axes_specs = [spec for spec in VISUAL_OBJECTS if spec["primitive"] == "axes"]
        self.axes_spec = axes_specs[0] if axes_specs else None
        if self.axes_spec is None:
            self.scan_tracker = None
            return
        self.coordinate_ids.add(self.axes_spec["id"])
        path_specs = []
        height_specs = []
        for spec in VISUAL_OBJECTS:
            if spec["primitive"] == "function_curve":
                self.coordinate_ids.add(spec["id"])
                continue
            if spec["primitive"] != "line":
                continue
            params = spec.get("params") or {}
            points = params.get("points") or []
            if (
                isinstance(points, list) and len(points) >= 2
                and all(isinstance(point, list) and len(point) >= 2 for point in points[:2])
            ):
                x1 = self.number(points[0][0], 0)
                y1 = self.number(points[0][1], 0)
                x2 = self.number(points[1][0], 1)
                y2 = self.number(points[1][1], 1)
                if abs(x2 - x1) > 1e-6:
                    slope = (y2 - y1) / (x2 - x1)
                    self.coordinate_models[spec["id"]] = (slope, y1 - slope * x1)
                    self.coordinate_domains[spec["id"]] = (x1, x2)
                    path_specs.append(spec)
                    self.coordinate_ids.add(spec["id"])
                else:
                    self.coordinate_segments[spec["id"]] = (
                        (x1, y1),
                        (x2, y2),
                    )
                    self.coordinate_ids.add(spec["id"])
            elif "slope" in params and "intercept" in params:
                self.coordinate_models[spec["id"]] = (
                    self.number(params.get("slope"), 1),
                    self.number(params.get("intercept"), 0),
                )
                domain = params.get("x_range") or []
                if isinstance(domain, list) and len(domain) >= 2:
                    self.coordinate_domains[spec["id"]] = (
                        self.number(domain[0], -3), self.number(domain[1], 3)
                    )
            elif all(key in params for key in ("x", "y_start", "y_end")):
                x_value = self.number(params.get("x"), 0)
                self.coordinate_segments[spec["id"]] = (
                    (x_value, self.number(params.get("y_start"), 0)),
                    (x_value, self.number(params.get("y_end"), 1)),
                )
                self.coordinate_ids.add(spec["id"])
            elif all(key in params for key in ("x_start", "x_end", "y")):
                y_value = self.number(params.get("y"), 0)
                self.coordinate_segments[spec["id"]] = (
                    (self.number(params.get("x_start"), 0), y_value),
                    (self.number(params.get("x_end"), 1), y_value),
                )
                self.coordinate_ids.add(spec["id"])
            elif str(params.get("type") or "").lower() == "vertical":
                height_specs.append(spec)
                self.coordinate_ids.add(spec["id"])
        for index, spec in enumerate(height_specs):
            if path_specs:
                model_id = path_specs[min(index, len(path_specs) - 1)]["id"]
                self.height_models[spec["id"]] = self.coordinate_models[model_id]
        axis_params = self.axes_spec.get("params") or {}
        x_range = axis_params.get("x_range") or [-3, 3]
        start = self.number(x_range[0] if len(x_range) > 0 else -3, -3, -100, 100)
        self.scan_target_x = start
        self.scan_target_y = 0
        if len(path_specs) >= 2:
            m1, b1 = self.coordinate_models[path_specs[0]["id"]]
            m2, b2 = self.coordinate_models[path_specs[1]["id"]]
            if abs(m1 - m2) > 1e-6:
                self.scan_target_x = (b2 - b1) / (m1 - m2)
                self.scan_target_y = m1 * self.scan_target_x + b1
        self.scan_tracker = ValueTracker(start)
        vertical_x_values = {
            round(segment[0][0], 9)
            for segment in self.coordinate_segments.values()
            if abs(segment[0][0] - segment[1][0]) < 1e-6
        }
        curve_specs = [
            spec for spec in VISUAL_OBJECTS
            if spec["primitive"] == "function_curve"
        ]
        unbound_dots = [
            spec for spec in VISUAL_OBJECTS
            if spec["primitive"] == "dot"
            and not all(key in (spec.get("params") or {}) for key in ("x", "y"))
        ]
        if (
            len(vertical_x_values) == 1
            and len(curve_specs) == 1
            and len(unbound_dots) == 1
        ):
            projection_x = next(iter(vertical_x_values))
            sampled_points = [
                point
                for segment in (curve_specs[0].get("params") or {}).get(
                    "sampled_segments", []
                )
                if isinstance(segment, list)
                for point in segment
                if isinstance(point, list) and len(point) >= 2
            ]
            if sampled_points:
                nearest = min(
                    sampled_points,
                    key=lambda point: abs(self.number(point[0], 0) - projection_x),
                )
                dot_params = unbound_dots[0].setdefault("params", {})
                dot_params["x"] = projection_x
                dot_params["y"] = self.number(nearest[1], 0)
                self.coordinate_ids.add(unbound_dots[0]["id"])
        for spec in VISUAL_OBJECTS:
            params = spec.get("params") or {}
            if spec["primitive"] == "dot" and (
                all(key in params for key in ("x", "y"))
                or isinstance(params.get("positions"), list)
                or "交点" in spec.get("meaning", "")
                or "intersection" in spec["id"].lower()
            ):
                self.coordinate_ids.add(spec["id"])

    def make_visual(self, spec):
        primitive = spec["primitive"]
        params = spec.get("params") or {}
        color = self.color(spec.get("color"))
        # Units that will host per-unit marks ("legs") need vertical room
        # for them; without it the marks squeeze into the next grid row.
        max_marks = max(
            (
                int(self.number((other.get("params") or {}).get("count_per_unit"), 0, 0, 6))
                for other in self.specs.values()
            ),
            default=0,
        )
        if primitive == "balance":
            body = self.build_balance(spec["id"], params)
            # Self-positioned hero object: keep it out of slot layout/fit.
            self.coordinate_ids.add(spec["id"])
            self.object_bodies[spec["id"]] = body
            return body
        repeated = self.repeated_body(
            primitive, params, color,
            extra_row_gap=0.2 if max_marks > 0 else 0.0,
        )
        if repeated is not None and spec["id"] not in self.coordinate_ids:
            body = repeated
            self.repeat_units[spec["id"]] = body
        elif primitive == "dot":
            if spec["id"] in self.coordinate_ids and hasattr(self, "primary_axes"):
                params = spec.get("params") or {}
                positions = [
                    position
                    for position in params.get("positions") or []
                    if isinstance(position, list) and len(position) >= 2
                ]
                if positions:
                    body = VGroup(*[
                        Dot(
                            self.primary_axes.c2p(
                                self.number(position[0], 0),
                                self.number(position[1], 0),
                            ),
                            radius=0.16,
                            color=color,
                        )
                        for position in positions
                    ])
                else:
                    point_x = self.number(params.get("x"), self.scan_target_x)
                    point_y = self.number(params.get("y"), self.scan_target_y)
                    if params.get("open"):
                        body = Circle(
                            radius=0.16,
                            color=color,
                            fill_opacity=0,
                            stroke_width=5,
                        ).move_to(self.primary_axes.c2p(point_x, point_y))
                    else:
                        body = Dot(
                            self.primary_axes.c2p(point_x, point_y),
                            radius=0.16, color=color,
                        )
            else:
                body = Dot(radius=0.16, color=color)
        elif primitive == "circle":
            body = Circle(radius=0.78, color=color, fill_color=color, fill_opacity=0.18)
        elif primitive == "rectangle":
            body = Rectangle(
                width=2.2, height=1.25, color=color,
                fill_color=color, fill_opacity=0.16,
            )
        elif primitive == "line":
            if (
                spec["id"] in self.coordinate_ids
                and isinstance(params.get("start"), list)
                and isinstance(params.get("end"), list)
                and not hasattr(self, "primary_axes")
            ):
                line_type = (
                    DashedLine
                    if str(params.get("style") or "").lower() == "dashed"
                    else Line
                )
                body = line_type(
                    self.geometry_point(params["start"]),
                    self.geometry_point(params["end"]),
                    color=color,
                    stroke_width=4,
                )
            elif spec["id"] in self.coordinate_segments and hasattr(self, "primary_axes"):
                start, end = self.coordinate_segments[spec["id"]]
                line_type = (
                    DashedLine
                    if str(params.get("style") or "").lower() == "dashed"
                    else Line
                )
                body = line_type(
                    self.primary_axes.c2p(*start),
                    self.primary_axes.c2p(*end),
                    color=color, stroke_width=4,
                )
            elif spec["id"] in self.coordinate_models and hasattr(self, "primary_axes"):
                params = self.axes_spec.get("params") or {}
                x_range = params.get("x_range") or [-3, 3]
                default_start = self.number(x_range[0] if len(x_range) > 0 else -3, -3)
                default_end = self.number(x_range[1] if len(x_range) > 1 else 3, 3)
                start, end = self.coordinate_domains.get(
                    spec["id"], (default_start, default_end)
                )
                slope, intercept = self.coordinate_models[spec["id"]]
                body = Line(
                    self.primary_axes.c2p(start, slope * start + intercept),
                    self.primary_axes.c2p(end, slope * end + intercept),
                    color=color, stroke_width=5,
                )
            elif spec["id"] in self.height_models and hasattr(self, "primary_axes"):
                slope, intercept = self.height_models[spec["id"]]
                def moving_height(slope=slope, intercept=intercept, color=color, spec=spec):
                    x_value = self.scan_tracker.get_value()
                    y_value = slope * x_value + intercept
                    segment = Line(
                        self.primary_axes.c2p(x_value, 0),
                        self.primary_axes.c2p(x_value, y_value),
                        color=color, stroke_width=5,
                    )
                    marker = Dot(segment.get_end(), radius=0.07, color=color)
                    return VGroup(segment, marker)
                body = always_redraw(moving_height)
            else:
                body = Line(LEFT * 1.2, RIGHT * 1.2, color=color, stroke_width=5)
        elif primitive == "function_curve":
            if not hasattr(self, "primary_axes"):
                body = VGroup()
            else:
                paths = VGroup()
                for segment in params.get("sampled_segments") or []:
                    if not isinstance(segment, list) or len(segment) < 2:
                        continue
                    path = VMobject(color=color, stroke_width=5)
                    path.set_points_smoothly([
                        self.primary_axes.c2p(
                            self.number(point[0], 0), self.number(point[1], 0)
                        )
                        for point in segment
                        if isinstance(point, list) and len(point) >= 2
                    ])
                    paths.add(path)
                body = paths
        elif primitive == "arrow":
            if (
                spec["id"] in self.coordinate_ids
                and isinstance(params.get("start"), list)
                and isinstance(params.get("end"), list)
            ):
                body = Arrow(
                    self.geometry_point(params["start"]),
                    self.geometry_point(params["end"]),
                    color=color,
                    buff=0.02,
                )
            else:
                body = Arrow(LEFT * 1.15, RIGHT * 1.15, color=color, buff=0.04)
        elif primitive == "quantity_bar":
            value = abs(self.number(params.get("value", params.get("count", 1)), 1, 0, 1000))
            units = min(max(int(round(value)), 1), 16)
            # Preserve relative magnitude across all aggregate bars.  The old
            # capped ``1 + .18 * min(value, 16)`` made any two values above 16
            # look identical, erasing the comparison the bar was meant to show.
            width = 1.0 + 2.2 * value / self.quantity_bar_max
            shell = RoundedRectangle(
                width=width, height=0.72, corner_radius=0.1,
                color=color, fill_color=color, fill_opacity=0.25,
            )
            ticks = VGroup(*[
                Line(
                    [-width / 2 + width * i / units, -0.3, 0],
                    [-width / 2 + width * i / units, 0.3, 0],
                    color=color, stroke_width=1,
                )
                for i in range(1, units)
            ])
            amount = Text(str(params.get("value", params.get("count", ""))), font_size=25)
            amount.move_to(shell)
            body = VGroup(shell, ticks, amount)
        elif primitive == "unit_grid":
            x_range = params.get("x_range")
            y_range = params.get("y_range")
            if (
                isinstance(x_range, list) and len(x_range) >= 2
                and isinstance(y_range, list) and len(y_range) >= 2
            ):
                x_start = self.number(x_range[0], -3)
                x_end = self.number(x_range[1], 3)
                y_start = self.number(y_range[0], -2)
                y_end = self.number(y_range[1], 2)
                body = NumberPlane(
                    x_range=[x_start, x_end, 1],
                    y_range=[y_start, y_end, 1],
                    x_length=(x_end - x_start) * self.geometry_scale,
                    y_length=(y_end - y_start) * self.geometry_scale,
                    background_line_style={
                        "stroke_color": color,
                        "stroke_width": 1.25,
                        "stroke_opacity": 0.38,
                    },
                    axis_config={
                        "stroke_color": GREY_B,
                        "stroke_width": 2,
                    },
                )
            else:
                count = int(self.number(params.get("count", 12), 12, 1, 64))
                columns = int(self.number(
                    params.get("columns", math.ceil(math.sqrt(count))),
                    4, 1, 8,
                ))
                cells = VGroup(*[
                    Square(
                        side_length=0.34,
                        color=color,
                        fill_color=color,
                        fill_opacity=0.24,
                    )
                    for _ in range(count)
                ])
                rows = math.ceil(count / columns)
                cells.arrange_in_grid(rows=rows, cols=columns, buff=0.055)
                body = cells
                self.repeat_units[spec["id"]] = body
        elif primitive == "number_line":
            start = self.number(params.get("min", params.get("start", 0)), 0, -100, 100)
            end = self.number(params.get("max", params.get("end", 10)), 10, -100, 100)
            if end <= start:
                end = start + 10
            step = max((end - start) / 5, 0.1)
            body = NumberLine(
                x_range=[start, end, step], length=3.2,
                color=color, include_numbers=False,
            )
        elif primitive == "axes":
            params = spec.get("params") or {}
            x_values = params.get("x_range") or [-3, 3]
            y_values = params.get("y_range") or [-2, 2]
            x_start = self.number(x_values[0] if len(x_values) > 0 else -3, -3)
            x_end = self.number(x_values[1] if len(x_values) > 1 else 3, 3)
            y_start = self.number(y_values[0] if len(y_values) > 0 else -2, -2)
            y_end = self.number(y_values[1] if len(y_values) > 1 else 2, 2)

            def nice_tick(span):
                raw = max(abs(span) / 5, 1e-6)
                magnitude = 10 ** math.floor(math.log10(raw))
                scaled = raw / magnitude
                factor = 1 if scaled <= 1 else 2 if scaled <= 2 else 5
                return factor * magnitude

            x_step = nice_tick(x_end - x_start)
            y_step = nice_tick(y_end - y_start)
            body = Axes(
                x_range=[x_start, x_end, x_step],
                y_range=[y_start, y_end, y_step],
                x_length=8.6, y_length=4.7,
                axis_config={
                    "color": color,
                    "include_tip": True,
                    # NumberLine defaults to MathTex for numeric labels. The
                    # deterministic renderer must work without a LaTeX binary,
                    # so readable ticks are added below with ordinary Text.
                    "include_numbers": False,
                    "font_size": 20,
                },
            )
            body.move_to(UP * 0.15)
            x_labels = VGroup()
            y_labels = VGroup()
            x_value = math.ceil(x_start / x_step) * x_step
            while x_value <= x_end + 1e-8:
                x_label = Text(f"{x_value:g}", font_size=16, color=GREY_B)
                x_label.next_to(body.c2p(x_value, 0), DOWN, buff=0.08)
                x_labels.add(x_label)
                x_value += x_step
            y_value = math.ceil(y_start / y_step) * y_step
            while y_value <= y_end + 1e-8:
                if abs(y_value) > 1e-8:
                    y_label = Text(f"{y_value:g}", font_size=16, color=GREY_B)
                    y_label.next_to(body.c2p(0, y_value), LEFT, buff=0.08)
                    y_labels.add(y_label)
                y_value += y_step
            body.add(x_labels, y_labels)
            self.primary_axes = body
            if len(self.coordinate_models) >= 2:
                x_mark = Text(f"{self.scan_target_x:g}", font_size=20, color=WHITE)
                y_mark = Text(f"{self.scan_target_y:g}", font_size=20, color=WHITE)
                x_mark.next_to(body.c2p(self.scan_target_x, 0), DOWN, buff=0.1)
                y_mark.next_to(body.c2p(0, self.scan_target_y), LEFT, buff=0.1)
                body.add(x_mark, y_mark)
        elif primitive == "polygon":
            raw_vertices = [
                point
                for point in params.get("vertices") or []
                if isinstance(point, list) and len(point) >= 2
            ]
            if len(raw_vertices) >= 3:
                vertices = [
                    self.geometry_point(point)
                    for point in raw_vertices[:24]
                ]
            else:
                sides = int(self.number(params.get("sides", 3), 3, 3, 8))
                vertices = [
                    [
                        0.9 * math.cos(TAU * i / sides),
                        0.9 * math.sin(TAU * i / sides),
                        0,
                    ]
                    for i in range(sides)
                ]
            body = Polygon(*vertices, color=color, fill_color=color, fill_opacity=0.18)
        elif primitive == "figure":
            # 讲义原图的转写重画：点(带字母)+线段+阴影区域。坐标由引擎按原图量出，
            # 这里只负责忠实地画；字母沿"顶点远离重心"的方向外推，别盖住图形本身
            figure_points = {
                str(item.get("id")): self.geometry_point(item["at"])
                for item in params.get("points") or []
                if isinstance(item, dict)
                and isinstance(item.get("at"), list)
                and len(item["at"]) >= 2
            }
            body = VGroup()
            if figure_points:
                fig_cx = sum(p[0] for p in figure_points.values()) / len(figure_points)
                fig_cy = sum(p[1] for p in figure_points.values()) / len(figure_points)
                for cycle in params.get("polygons") or []:
                    names = [str(n) for n in (cycle.get("points") or [])]
                    if len(names) >= 3 and all(n in figure_points for n in names):
                        body.add(Polygon(
                            *[figure_points[n] for n in names],
                            color=WHITE,
                            fill_color=GREY_B,
                            fill_opacity=0.5 if cycle.get("shaded") else 0.0,
                            stroke_width=2.4,
                        ))
                        # 区域标签写在重心：面积数值属于那块区域，不该漂在图外
                        cycle_label = str(cycle.get("label") or "").strip()
                        if cycle_label:
                            cpts = [figure_points[n] for n in names]
                            mark = Text(cycle_label, font_size=22, color=WHITE)
                            self.place_figure_label(
                                mark,
                                sum(p[0] for p in cpts) / len(cpts),
                                sum(p[1] for p in cpts) / len(cpts),
                            )
                            body.add(mark)
                for seg in params.get("segments") or []:
                    seg_a, seg_b = str(seg.get("from")), str(seg.get("to"))
                    if seg_a in figure_points and seg_b in figure_points:
                        seg_line = Line(
                            figure_points[seg_a], figure_points[seg_b],
                            color=WHITE, stroke_width=2.4,
                        )
                        body.add(seg_line)
                        seg_label = str(seg.get("label") or "").strip()
                        if seg_label:
                            tag = Text(seg_label, font_size=18, color=GREY_B)
                            mid = seg_line.get_center()
                            self.place_figure_label(tag, mid[0] + 0.35, mid[1] + 0.3)
                            body.add(tag)
                # 顶点字母只由底图画；overlay 的点是底图点的子集，再画一遍就是重影
                if not str(spec.get("id") or "").startswith("figure_overlay_"):
                    for name, p in figure_points.items():
                        dx, dy = p[0] - fig_cx, p[1] - fig_cy
                        norm = max((dx * dx + dy * dy) ** 0.5, 1e-6)
                        letter = Text(name, font_size=24, color=YELLOW)
                        lx = p[0] + dx / norm * 0.32
                        ly = p[1] + dy / norm * 0.32
                        letter.move_to([lx, ly, 0])
                        # 字母位置也登记占位：区域数值不许压到顶点字母上
                        self.placed_figure_labels.append((lx, ly))
                        body.add(letter)
            if len(body) == 0:
                body = VGroup(Dot([0, 0, 0], radius=0.001))
        else:
            node_label = Text(str(spec.get("label") or spec.get("meaning") or "关系"), font_size=23)
            self.fit(node_label, 2.7, 1.0)
            box = RoundedRectangle(
                width=max(1.8, node_label.width + 0.5),
                height=max(0.9, node_label.height + 0.38),
                corner_radius=0.12, color=color, fill_color=color, fill_opacity=0.18,
            )
            node_label.move_to(box)
            return VGroup(box, node_label)
        self.object_bodies[spec["id"]] = body
        if spec["id"] in self.coordinate_ids:
            label_text = str(spec.get("label") or "").strip()
            if label_text and primitive in {"line", "function_curve", "dot", "polygon"}:
                label = Text(label_text, font_size=20, color=color)
                if primitive == "function_curve":
                    curve_count = sum(
                        item.get("primitive") == "function_curve"
                        for item in VISUAL_OBJECTS[:VISUAL_OBJECTS.index(spec)]
                    )
                    anchor = body.get_left() if curve_count % 2 == 0 else body.get_right()
                    label.next_to(anchor, UP, buff=0.16)
                elif primitive == "line":
                    label.next_to(body.get_right(), UP, buff=0.16)
                elif primitive == "polygon":
                    label.next_to(body, DOWN, buff=0.16)
                else:
                    label.next_to(body, UR, buff=0.18)
                label.shift_onto_screen(buff=0.25)
                group = VGroup(body, label)
                self.object_labels[spec["id"]] = label
                return group
            return body
        group = self.labeled(body, spec)
        if isinstance(group, VGroup) and len(group) > 1:
            self.object_labels[spec["id"]] = group[-1]
        return group

    def slots(self, count):
        columns = min(3, max(count, 1))
        rows = math.ceil(count / columns)
        if self.coordinate_ids:
            # 几何图形以原点为中心占据画面中部（geometry_point 的映射）；
            # 关系框等自由对象沉到底部一条带——压在图上就是"框糊脸"（实机踩过）
            x_gap = 3.9 if columns > 1 else 0
            return [
                RIGHT * ((index % columns) - (columns - 1) / 2) * x_gap
                + DOWN * (2.95 - (index // columns) * 1.0)
                for index in range(count)
            ]
        x_gap = 3.7 if columns > 1 else 0
        y_gap = 2.45 if rows > 1 else 0
        return [
            RIGHT * ((index % columns) - (columns - 1) / 2) * x_gap
            + UP * (((rows - 1) / 2) - index // columns) * y_gap
            + DOWN * 0.2
            for index in range(count)
        ]

    def relayout(self, visible, new_ids):
        ids = [*visible, *[item for item in new_ids if item not in visible]]
        free_ids = [
            item for item in ids
            if item not in self.coordinate_ids and item not in self.attached_ids
        ]
        positions = self.slots(len(free_ids))
        animations = []
        for object_id, position in zip(free_ids, positions):
            item = self.objects[object_id]
            self.fit(item)
            if object_id in visible:
                animations.append(item.animate.move_to(position))
            else:
                item.move_to(position)
        return animations

    def record_beat(self, beat_index, scene):
        # Render-time beat manifest: actual timestamps and the per-group unit
        # state the frame SHOULD show at this moment. Consumed by the review
        # stage for deterministic count verification. Coordinates are scene
        # units; the consumer converts to pixels via frame_width/height.
        groups = {}
        for object_id, units in self.unit_ledger.items():
            live = [unit for unit in units if unit.width > 0]
            if not live:
                continue
            box = VGroup(*live)
            color_hex = ""
            opacity = 1.0
            try:
                color_hex = str(live[0].get_color().to_hex())
            except Exception:
                color_hex = ""
            try:
                opacity = float(live[0].get_stroke_opacity())
            except Exception:
                opacity = 1.0
            spec = self.specs.get(object_id) or {}
            groups[object_id] = {
                "count": len(live),
                "bbox": [
                    round(float(box.get_left()[0]), 3),
                    round(float(box.get_bottom()[1]), 3),
                    round(float(box.get_right()[0]), 3),
                    round(float(box.get_top()[1]), 3),
                ],
                "color": color_hex,
                "opacity": round(opacity, 2),
                "label": str(spec.get("label") or spec.get("meaning") or "")[:24],
            }
        self.beat_manifest.append({
            "beat_index": beat_index,
            "role": str(scene.get("role") or ""),
            "end_time": round(float(self.renderer.time), 3),
            "groups": groups,
        })

    def emit_beat_manifest(self):
        import json as json_module
        payload = {
            "frame_width": float(config.frame_width),
            "frame_height": float(config.frame_height),
            "beats": self.beat_manifest,
        }
        try:
            print("BEAT_MANIFEST_JSON:" + json_module.dumps(payload))
        except Exception:
            pass

    def register_badge(self, registry, key, badge):
        # Overwriting a badge slot must clear the old mobject from the scene;
        # a stale formula left behind overlaps the new one at the same anchor.
        old = registry.pop(key, None)
        if old is not None:
            old.clear_updaters()
            self.remove(old)
        registry[key] = badge

    def build_balance(self, spec_id, params):
        # A physical two-pan balance: unknown boxes + unit dots on the left,
        # unit dots on the right, level beam = the equality itself.
        coefficient = int(self.number(params.get("coefficient"), 1, 0, 6))
        constant = int(self.number(params.get("constant"), 0, 0, 24))
        total = int(self.number(params.get("total"), 1, 0, 30))
        variable = str(params.get("variable") or "x")[:2]
        # Tall clearance between pans and beam: pan stacks need two rows of
        # countable objects without touching the beam.
        beam_y, pan_y = 1.75, 0.55
        beam = Line([-3.1, beam_y, 0], [3.1, beam_y, 0], color=GREY_B, stroke_width=6)
        fulcrum = Polygon(
            [0, beam_y - 0.04, 0], [-0.42, 0.1, 0], [0.42, 0.1, 0],
            color=GREY_B, fill_color=GREY_D, fill_opacity=1,
        )
        parts = VGroup(beam, fulcrum)
        pans = {}
        for side, pan_x in (("left", -2.25), ("right", 2.25)):
            hanger = Line(
                [pan_x, beam_y, 0], [pan_x, pan_y, 0], color=GREY_B, stroke_width=3
            )
            pan = Line(
                [pan_x - 1.25, pan_y, 0], [pan_x + 1.25, pan_y, 0],
                color=GREY_B, stroke_width=5,
            )
            parts.add(hanger, pan)
            pans[side] = pan
        equal_sign = Text("=", font_size=34, color=WHITE).move_to([0, beam_y + 0.4, 0])
        parts.add(equal_sign)

        def unit_dot():
            return Dot(radius=0.1, color=YELLOW)

        left_boxes = []
        for _ in range(coefficient):
            box = VGroup(
                Square(side_length=0.44, color=BLUE, fill_color=BLUE, fill_opacity=0.25),
                Text(variable, font_size=24, color=WHITE),
            )
            left_boxes.append(box)
        left_units = [unit_dot() for _ in range(constant)]
        right_units = [unit_dot() for _ in range(total)]

        def arrange_on_pan(items, pan):
            if not items:
                return
            # At most two rows so stacks always fit under the beam.
            columns = max(4, math.ceil(len(items) / 2))
            group = VGroup(*items).arrange_in_grid(
                rows=math.ceil(len(items) / columns), cols=columns,
                buff=(0.1, 0.12),
            )
            if group.width > 2.4:
                group.scale_to_fit_width(2.4)
            group.next_to(pan, UP, buff=0.08)

        arrange_on_pan(left_boxes + left_units, pans["left"])
        arrange_on_pan(right_units, pans["right"])
        for item in (*left_boxes, *left_units, *right_units):
            parts.add(item)
        parts.move_to([0, 0.4, 0])
        self.balance_parts[spec_id] = {
            "beam": beam,
            "equal_sign": equal_sign,
            "pans": pans,
            "left_boxes": left_boxes,
            "left_units": left_units,
            "right_units": right_units,
            "params": {
                "coefficient": coefficient,
                "constant": constant,
                "total": total,
                "solution": int(self.number(params.get("solution"), 1, 0, 24)),
                "variable": variable,
            },
        }
        return parts

    def ledger_units(self, object_id):
        # A group's units are the same mobjects for the whole video: they can
        # move, recolor or get crossed out, but are never destroyed/redrawn.
        # The ledger tracks which units currently belong to which group.
        if object_id not in self.unit_ledger:
            units = self.repeat_units.get(object_id)
            self.unit_ledger[object_id] = list(units) if units is not None else []
        return self.unit_ledger[object_id]

    def reparent_unit(self, source_id, unit):
        holder = self.repeat_units.get(source_id)
        if holder is not None and unit in holder.submobjects:
            holder.remove(unit)
            self.add(unit)
        ledger = self.unit_ledger.get(source_id)
        if ledger is not None and unit in ledger:
            ledger.remove(unit)

    def container_body(self, object_id):
        container = self.objects.get(object_id)
        if container is None:
            return None
        if isinstance(container, VGroup) and len(container.submobjects) >= 1:
            return container.submobjects[0]
        return container

    def container_slots(self, object_id, total):
        body = self.container_body(object_id)
        if body is None or total < 1:
            return []
        columns = max(1, min(4, int(math.ceil(math.sqrt(total)))))
        rows = max(1, int(math.ceil(total / columns)))
        usable_width = body.width * 0.82
        usable_height = body.height * 0.78
        cell_width = usable_width / columns
        cell_height = usable_height / rows
        center = body.get_center()
        slots = []
        for index in range(total):
            row = index // columns
            column = index % columns
            slots.append([
                center[0] - usable_width / 2 + cell_width * (column + 0.5),
                center[1] + usable_height / 2 - cell_height * (row + 0.5),
                0,
            ])
        return slots

    def unit_arrival_scale(self, unit, object_id, total):
        slots = self.container_slots(object_id, total)
        if not slots or unit.width <= 0:
            return 1.0
        body = self.container_body(object_id)
        cell_width = body.width * 0.82 / max(1, min(4, int(math.ceil(math.sqrt(total)))))
        return min(1.0, cell_width * 0.8 / unit.width)

    def animate_count(self, object_id, expect=None):
        # Numerals are born from counting the graphics: units light up one by
        # one with an incrementing counter, then the total anchors to the
        # group with a brace. A number the video never counted or measured
        # must not appear on screen.
        units = self.ledger_units(object_id)
        if not units:
            return
        total = len(units)
        group = VGroup(*units)
        # Text digits only: DecimalNumber/Integer require a LaTeX toolchain,
        # which this pipeline deliberately avoids.
        counter = None
        step_time = 0.32 if total <= 8 else max(0.1, 2.4 / total)
        for index, unit in enumerate(units, start=1):
            fresh = Text(str(index), font_size=36, color=YELLOW)
            fresh.next_to(group, UP, buff=0.26)
            fresh.shift_onto_screen(buff=0.3)
            if counter is not None:
                self.remove(counter)
            counter = fresh
            self.add(counter)
            self.play(Indicate(unit, scale_factor=1.22), run_time=step_time)
        if counter is not None:
            self.remove(counter)

        def overlaps(first, second):
            return (
                first.get_left()[0] < second.get_right()[0]
                and second.get_left()[0] < first.get_right()[0]
                and first.get_bottom()[1] < second.get_top()[1]
                and second.get_bottom()[1] < first.get_top()[1]
            )

        # Anchor above the units by default; a cross_out subgroup lives inside
        # another group's area, so if the badge would stack on another badge
        # or a label, walk through alternative sides. Its own predecessor is
        # about to be replaced and must not count as an obstacle. The badge
        # enters as ONE mobject so register_badge replacement can remove it.
        obstacles = [
            existing
            for key, existing in self.count_badges.items()
            if key != object_id
        ]
        obstacles.extend(
            label for label in self.object_labels.values() if label is not None
        )
        badge = None
        for direction in (UP, RIGHT, LEFT, DOWN):
            brace = Brace(group, direction, buff=0.12)
            value = Text(str(total), font_size=30, color=YELLOW)
            value.next_to(brace, direction, buff=0.08)
            candidate = VGroup(brace, value)
            candidate.shift_onto_screen(buff=0.3)
            badge = candidate
            if not any(overlaps(candidate, obstacle) for obstacle in obstacles):
                break
        self.register_badge(self.count_badges, object_id, badge)
        self.play(GrowFromCenter(badge), run_time=0.5)

    def show_caption(self, old_caption, text):
        caption = Text(str(text or "观察图形关系的变化"), font_size=23, color=WHITE)
        self.fit(caption, 11.0, 0.9)
        caption.to_edge(DOWN, buff=0.3)
        if old_caption is None:
            self.play(FadeIn(caption))
        else:
            # Never cross-fade two unrelated sentences in the same safe band:
            # even a short overlap is unreadable in sampled frames.
            self.play(FadeOut(old_caption), run_time=0.22)
            self.play(FadeIn(caption), run_time=0.3)
        return caption

    def execute_action(self, action, visible):
        op = action["op"]
        targets = [item for item in action.get("targets", []) if item in self.objects]
        result_id = action.get("result")
        if op == "create":
            new_ids = [item for item in targets if item not in visible]
            animations = self.relayout(visible, new_ids)
            regular_ids = []
            attachment_ids = []
            for item in new_ids:
                if self.number(
                    (self.specs[item].get("params") or {}).get("count_per_unit"), 0
                ) > 0:
                    attachment_ids.append(item)
                else:
                    regular_ids.append(item)
            animations.extend(self.animate_create(item) for item in regular_ids)
            if animations:
                self.play(*animations)
            attachment_animations = [
                animation for item in attachment_ids
                if (animation := self.attach_per_unit_marks(item, visible, new_ids)) is not None
            ]
            if attachment_animations:
                self.play(*attachment_animations)
            visible.extend(new_ids)
        elif op == "map" and targets and result_id in self.objects:
            source_ids = [item for item in targets if item in visible]
            if not source_ids:
                return
            source_id = source_ids[0]
            source_units = self.repeat_units.get(source_id)
            result_units = self.repeat_units.get(result_id)
            if source_units is not None and result_units is not None:
                if result_id not in visible:
                    # Extraction map: keep the invariant source visible, put
                    # the derived subset in its own slot, and copy members one
                    # by one.  Placing the result at the source centre used to
                    # superimpose bars/labels around the 24-second transition.
                    layout_animations = self.relayout(visible, [result_id])
                    if layout_animations:
                        self.play(*layout_animations)
                    visible.append(result_id)
                    pair_count = min(len(source_units), len(result_units))
                    source_object = self.objects[source_id]
                    result_object = self.objects[result_id]
                    connector = Arrow(
                        source_object.get_bottom(), result_object.get_top(),
                        color=YELLOW, buff=0.12, stroke_width=5,
                    )
                    mapping_label = Text(
                        "逐个对应", font_size=19, color=YELLOW,
                    ).next_to(connector, RIGHT, buff=0.12)
                    result_label = self.object_labels.get(result_id)
                    entrance = [GrowArrow(connector), FadeIn(mapping_label)]
                    if result_label is not None:
                        entrance.append(FadeIn(result_label))
                    self.play(*entrance)
                    self.play(LaggedStart(*[
                        AnimationGroup(
                            FadeIn(result_units[index], scale=0.7),
                            source_units[index].animate.set_color(GREEN).scale(1.16),
                            lag_ratio=0,
                        )
                        for index in range(pair_count)
                    ], lag_ratio=min(0.08, 1.4 / max(pair_count, 1))))
                    self.play(
                        *[
                            source_units[index].animate.scale(1 / 1.16)
                            for index in range(pair_count)
                        ],
                        FadeOut(connector), FadeOut(mapping_label),
                    )
                    mapped_units = VGroup(*source_units[:pair_count])
                    mapped_outline = SurroundingRectangle(
                        mapped_units, color=GREEN, buff=0.07, stroke_width=2.5,
                    )
                    mapped_outline.add_updater(
                        lambda outline, units=mapped_units: outline.become(
                            SurroundingRectangle(
                                units, color=GREEN, buff=0.07, stroke_width=2.5,
                            )
                        )
                    )
                    mapped_label = Text(
                        f"{pair_count} 个已对应", font_size=19, color=GREEN,
                    ).next_to(mapped_outline, UP, buff=0.1)
                    mapped_label.add_updater(
                        lambda label, outline=mapped_outline: label.next_to(
                            outline, UP, buff=0.1,
                        )
                    )
                    self.mapping_evidence[result_id] = VGroup(
                        mapped_outline, mapped_label,
                    )
                    self.play(Create(mapped_outline), FadeIn(mapped_label))
                    divisor = next(
                        (
                            value for value in self.relation_values
                            if self.last_comparison_difference is not None
                            and abs(
                                self.last_comparison_difference / value - pair_count
                            ) < 1e-6
                        ),
                        None,
                    )
                    if divisor is not None:
                        formula = Text(
                            f"{self.last_comparison_difference:g} ÷ {divisor:g} = {pair_count}",
                            font_size=22, color=GREEN,
                        )
                        formula.next_to(result_object, DOWN, buff=0.22)
                        formula.add_updater(
                            lambda badge, host=result_object: badge.next_to(
                                host, DOWN, buff=0.22,
                            )
                        )
                        self.register_badge(self.mapping_badges, result_id, formula)
                        self.play(FadeIn(formula, shift=UP * 0.08))
                    self.mapped_into[source_id] = (result_id, pair_count)
                    return
                pair_count = min(len(source_units), len(result_units))
                result_object = self.objects[result_id]
                # Route along the outside edges.  A centre-to-centre diagonal
                # crosses the source/target labels and can look like graphical
                # overlap in both sampled frames and ordinary playback.
                start = source_object.get_right()
                end = result_object.get_right()
                if np.linalg.norm(end - start) < 0.45:
                    start = source_object.get_right()
                    end = result_object.get_left()
                connector = Arrow(
                    start, end, color=YELLOW, buff=0.12, stroke_width=5,
                )
                mapping_label = Text("每组对应一个单位", font_size=19, color=YELLOW)
                mapping_label.next_to(connector, RIGHT, buff=0.12)
                mapping_label.shift_onto_screen(buff=0.3)
                self.play(GrowArrow(connector), FadeIn(mapping_label))
                self.play(LaggedStart(*[
                    AnimationGroup(
                        FadeOut(source_units[index], shift=LEFT * 0.16),
                        result_units[index].animate.set_color(GREEN).scale(1.18),
                        lag_ratio=0,
                    )
                    for index in range(pair_count)
                ], lag_ratio=min(0.08, 1.4 / max(pair_count, 1))))
                self.play(
                    *[result_units[index].animate.scale(1 / 1.18) for index in range(pair_count)],
                    FadeOut(self.objects[source_id]), FadeOut(connector),
                    FadeOut(mapping_label),
                )
                extra_per_unit = self.partition_ratios.get(source_id, 0)
                extra_marks = []
                if extra_per_unit > 0:
                    for unit_index in range(pair_count):
                        unit = result_units[unit_index]
                        center = unit.get_center()
                        for mark_index in range(extra_per_unit):
                            offset = (
                                mark_index - (extra_per_unit - 1) / 2
                            ) * 0.26
                            mark = Line(
                                center + [offset, -0.08, 0],
                                center + [offset, -0.27, 0],
                                color=GREEN, stroke_width=2.5,
                            )
                            extra_marks.append((unit, mark))
                    self.play(LaggedStart(*[
                        GrowFromPoint(mark, unit.get_center())
                        for unit, mark in extra_marks
                    ], lag_ratio=min(0.035, 1.2 / max(len(extra_marks), 1))))
                    for unit, mark in extra_marks:
                        self.remove(mark)
                        unit.add(mark)
                base_per_unit = 0
                for marker_id, host_id in self.attachment_hosts.items():
                    if host_id == result_id:
                        marker_params = self.specs[marker_id].get("params") or {}
                        base_per_unit = int(self.number(
                            marker_params.get("count_per_unit"), 0, 0, 12
                        ))
                        break
                remainder = max(0, len(result_units) - pair_count)
                mapped_count_line = Text(
                    f"{pair_count} 组 → {pair_count} 个发生变化的单位",
                    font_size=21, color=YELLOW,
                )
                if base_per_unit > 0 and extra_per_unit > 0:
                    mapped_total = base_per_unit + extra_per_unit
                    formulas = VGroup(
                        mapped_count_line,
                        Text(
                            f"{pair_count} × {mapped_total} = {pair_count * mapped_total}",
                            font_size=25, color=GREEN,
                        ),
                        Text(
                            f"{remainder} × {base_per_unit} = {remainder * base_per_unit}",
                            font_size=25, color=BLUE,
                        ),
                    ).arrange(DOWN, aligned_edge=LEFT, buff=0.25)
                    formulas.next_to(self.objects[result_id], DOWN, buff=0.42)
                    formulas.shift_onto_screen(buff=0.35)
                    self.register_badge(self.mapping_badges, result_id, formulas)
                    self.play(FadeIn(formulas, shift=LEFT * 0.12))
                elif extra_per_unit > 0:
                    source_total = pair_count * extra_per_unit
                    formulas = VGroup(
                        mapped_count_line,
                        Text(
                            f"{source_total} ÷ {extra_per_unit} = {pair_count}",
                            font_size=25, color=GREEN,
                        ),
                        Text(
                            f"{len(result_units)} − {pair_count} = {remainder}",
                            font_size=25, color=BLUE,
                        ),
                    ).arrange(DOWN, aligned_edge=LEFT, buff=0.25)
                    formulas.next_to(self.objects[result_id], DOWN, buff=0.42)
                    formulas.shift_onto_screen(buff=0.35)
                    self.register_badge(self.mapping_badges, result_id, formulas)
                    self.play(FadeIn(formulas, shift=LEFT * 0.12))
                self.mapped_into[source_id] = (result_id, pair_count)
                visible.remove(source_id)
                return
            self.play(TransformFromCopy(self.objects[source_id], self.objects[result_id]))
        elif op == "transform" and targets and result_id in self.objects:
            source_ids = [item for item in targets if item in visible]
            if not source_ids:
                source_ids = targets[:1]
                self.objects[source_ids[0]].move_to(ORIGIN + DOWN * 0.2)
                self.play(FadeIn(self.objects[source_ids[0]]))
                visible.append(source_ids[0])
            if result_id in source_ids:
                item = self.objects[result_id]
                self.play(item.animate.scale(1.06).set_color(GREEN))
                self.play(item.animate.scale(1 / 1.06))
                return
            attached_source_id = next(
                (item for item in source_ids if item in self.attachment_hosts), None
            )
            result_units = self.repeat_units.get(result_id)
            if attached_source_id is not None and result_units is not None:
                host_id = self.attachment_hosts[attached_source_id]
                host_units = self.repeat_units.get(host_id)
                if host_units is not None:
                    layout_animations = self.relayout(visible, [result_id])
                    if layout_animations:
                        self.play(*layout_animations)
                    pair_count = min(len(host_units), len(result_units))
                    result_label = self.object_labels.get(result_id)
                    entrance = []
                    if result_label is not None:
                        entrance.append(FadeIn(result_label))
                    entrance.append(LaggedStart(*[
                        AnimationGroup(
                            host_units[index].animate.set_color(GREEN),
                            FadeIn(result_units[index], scale=0.7),
                            lag_ratio=0,
                        )
                        for index in range(pair_count)
                    ], lag_ratio=min(0.08, 1.4 / max(pair_count, 1))))
                    self.play(*entrance)
                    if result_id not in visible:
                        visible.append(result_id)
                    self.mapped_into[attached_source_id] = (host_id, pair_count)
                    return
            # A transform from a larger addressable collection to a smaller
            # one represents subset extraction, even when the planner chose
            # ``transform`` instead of ``map``.  Preserve the source and show
            # which individual units produce the result; replacing the whole
            # collection hid the mathematical change in page-generated runs.
            source_id = source_ids[0] if len(source_ids) == 1 else None
            source_units = self.repeat_units.get(source_id) if source_id else None
            if (
                source_id is not None
                and source_units is not None
                and result_units is not None
                and len(source_units) > len(result_units)
            ):
                layout_animations = self.relayout(visible, [result_id])
                if layout_animations:
                    self.play(*layout_animations)
                if result_id not in visible:
                    visible.append(result_id)
                pair_count = len(result_units)
                result_object = self.objects[result_id]
                mapping_label = Text(
                    "从原集合逐个取出", font_size=19, color=YELLOW,
                ).next_to(result_object, UP, buff=0.16)
                mapping_label.shift_onto_screen(buff=0.3)
                result_label = self.object_labels.get(result_id)
                entrance = [FadeIn(mapping_label)]
                if result_label is not None:
                    entrance.append(FadeIn(result_label))
                self.play(*entrance)
                self.play(LaggedStart(*[
                    AnimationGroup(
                        source_units[index].animate.set_color(GREEN).scale(1.16),
                        FadeIn(result_units[index], scale=0.7),
                        lag_ratio=0,
                    )
                    for index in range(pair_count)
                ], lag_ratio=min(0.08, 1.4 / max(pair_count, 1))))
                self.play(
                    *[
                        source_units[index].animate.scale(1 / 1.16)
                        for index in range(pair_count)
                    ],
                    FadeOut(mapping_label),
                )
                mapped_units = VGroup(*source_units[:pair_count])
                mapped_outline = SurroundingRectangle(
                    mapped_units, color=GREEN, buff=0.07, stroke_width=2.5,
                )
                mapped_outline.add_updater(
                    lambda outline, units=mapped_units: outline.become(
                        SurroundingRectangle(
                            units, color=GREEN, buff=0.07, stroke_width=2.5,
                        )
                    )
                )
                evidence_label = Text(
                    f"{pair_count} 个来自原集合", font_size=19, color=GREEN,
                ).next_to(mapped_outline, UP, buff=0.1)
                evidence_label.add_updater(
                    lambda label, outline=mapped_outline: label.next_to(
                        outline, UP, buff=0.1,
                    )
                )
                self.mapping_evidence[result_id] = VGroup(
                    mapped_outline, evidence_label,
                )
                self.play(Create(mapped_outline), FadeIn(evidence_label))
                divisor = next(
                    (
                        value for value in self.relation_values
                        if self.last_comparison_difference is not None
                        and abs(
                            self.last_comparison_difference / value - pair_count
                        ) < 1e-6
                    ),
                    None,
                )
                if divisor is not None:
                    formula = Text(
                        f"{self.last_comparison_difference:g} ÷ {divisor:g} = {pair_count}",
                        font_size=22, color=GREEN,
                    )
                    formula.next_to(result_object, DOWN, buff=0.22)
                    formula.add_updater(
                        lambda badge, host=result_object: badge.next_to(
                            host, DOWN, buff=0.22,
                        )
                    )
                    self.register_badge(self.mapping_badges, result_id, formula)
                    self.play(FadeIn(formula, shift=UP * 0.08))
                self.mapped_into[source_id] = (result_id, pair_count)
                return
            source_objects = [self.objects[item] for item in source_ids]
            source = source_objects[0] if len(source_objects) == 1 else VGroup(*source_objects)
            result = self.objects[result_id]
            # Coordinate objects are already positioned by Axes.c2p. Moving
            # them to the source bounding-box centre destroys the mathematical
            # coordinates (a focused curve near y=1 can visibly fall to y=.6).
            if result_id not in self.coordinate_ids:
                self.fit(result)
                result.move_to(source.get_center())
            self.play(ReplacementTransform(source, result))
            for item in source_ids:
                if item in visible:
                    visible.remove(item)
            if result_id not in visible:
                visible.append(result_id)
        elif op == "remove":
            departing = [item for item in targets if item in visible]
            if departing:
                self.play(*[FadeOut(self.objects[item]) for item in departing])
                for item in departing:
                    visible.remove(item)
        elif op == "take_from":
            source_id = str(action.get("source") or (targets[0] if targets else ""))
            destination_id = str(action.get("destination") or "")
            take_count = int(self.number(action.get("count"), 0, 0, 64))
            style = str(action.get("style") or "fly")
            source_units = self.ledger_units(source_id)
            if (
                style != "cross_out"
                and destination_id
                and destination_id in self.objects
                and destination_id not in visible
            ):
                animations = self.relayout(visible, [destination_id])
                animations.append(self.animate_create(destination_id))
                self.play(*animations)
                visible.append(destination_id)
            destination_body = self.container_body(destination_id)
            if take_count >= 1 and source_units and destination_body is not None:
                take_count = min(take_count, len(source_units))
                taken = list(source_units[-take_count:])
                self.play(
                    *[Indicate(unit, color=YELLOW, scale_factor=1.3) for unit in taken],
                    run_time=0.7,
                )
                arrived = self.unit_ledger.setdefault(destination_id, [])
                final_total = len(arrived) + take_count
                slots = self.container_slots(destination_id, final_total)
                step_time = 0.45 if take_count <= 8 else max(0.15, 3.0 / take_count)
                for offset, unit in enumerate(taken):
                    self.reparent_unit(source_id, unit)
                    if style == "cross_out":
                        # In-place disappearance: the unit stays where it was,
                        # dimmed and crossed. The whole is still visible as
                        # "remaining + crossed", which IS the subtraction.
                        mark = Line(
                            unit.get_corner(UL), unit.get_corner(DR),
                            color=GREY, stroke_width=5,
                        )
                        self.play(
                            Create(mark),
                            unit.animate.set_opacity(0.35),
                            run_time=step_time,
                        )
                        unit.add(mark)
                    else:
                        slot_index = len(arrived)
                        slot = (
                            slots[slot_index]
                            if slot_index < len(slots)
                            else destination_body.get_center()
                        )
                        scale = self.unit_arrival_scale(unit, destination_id, final_total)
                        self.play(
                            unit.animate.move_to(slot).scale(scale),
                            run_time=step_time,
                        )
                    arrived.append(unit)
                if style == "cross_out" and taken:
                    # Materialize the destination as an outline that wraps the
                    # crossed units in place, labelling the removed part
                    # without moving anything out of the whole.
                    container = self.objects.get(destination_id)
                    if container is not None:
                        taken_group = VGroup(*taken)
                        destination_body.set_fill(opacity=0)
                        destination_body.stretch_to_fit_width(taken_group.width + 0.5)
                        destination_body.stretch_to_fit_height(taken_group.height + 0.5)
                        destination_body.move_to(taken_group.get_center())
                        if (
                            isinstance(container, VGroup)
                            and len(container.submobjects) > 1
                        ):
                            # Sideways label: the band below is occupied by
                            # the source group's own label.
                            label = container.submobjects[1]
                            label.next_to(destination_body, RIGHT, buff=0.18)
                            label.shift_onto_screen(buff=0.3)
                        source_label = self.object_labels.get(source_id)
                        if source_label is not None and (
                            source_label.get_top()[1] > destination_body.get_bottom()[1]
                            and source_label.get_bottom()[1]
                            < destination_body.get_top()[1]
                        ):
                            # The wrapped outline swallowed the source label;
                            # push it below the outline.
                            self.play(
                                source_label.animate.next_to(
                                    destination_body, DOWN, buff=0.16
                                ),
                                run_time=0.3,
                            )
                        if destination_id not in visible:
                            self.play(FadeIn(container), run_time=0.5)
                            visible.append(destination_id)
            elif source_units:
                self.play(*[Indicate(unit, color=YELLOW) for unit in source_units[:8]])
        elif op == "combine" and targets and result_id in self.objects:
            if result_id not in visible:
                animations = self.relayout(visible, [result_id])
                animations.append(self.animate_create(result_id))
                self.play(*animations)
                visible.append(result_id)
            arrivals = []
            for source_id in targets:
                arrivals.extend(
                    (str(source_id), unit)
                    for unit in list(self.ledger_units(str(source_id)))
                )
            destination_body = self.container_body(result_id)
            if arrivals and destination_body is not None:
                existing = self.unit_ledger.setdefault(result_id, [])
                final_total = len(existing) + len(arrivals)
                slots = self.container_slots(result_id, final_total)
                moves = []
                for source_id, unit in arrivals:
                    self.reparent_unit(source_id, unit)
                    slot_index = len(existing)
                    slot = (
                        slots[slot_index]
                        if slot_index < len(slots)
                        else destination_body.get_center()
                    )
                    scale = self.unit_arrival_scale(unit, result_id, final_total)
                    moves.append(unit.animate.move_to(slot).scale(scale))
                    existing.append(unit)
                self.play(
                    LaggedStart(*moves, lag_ratio=min(0.12, 2.0 / max(len(moves), 1)))
                )
        elif op in ("balance_remove", "balance_divide", "balance_verify"):
            balance_id = str(targets[0]) if targets else ""
            state = self.balance_parts.get(balance_id)
            if state is None:
                return
            beam = state["beam"]
            if op == "balance_remove":
                amount = int(self.number(action.get("count"), 0, 0, 24))
                amount = min(amount, len(state["left_units"]), len(state["right_units"]))
                step_time = 0.5 if amount <= 5 else max(0.2, 2.5 / amount)
                for _ in range(amount):
                    left_unit = state["left_units"].pop()
                    right_unit = state["right_units"].pop()
                    # The PAIR leaves together: same operation, both sides.
                    self.play(
                        Indicate(left_unit, color=RED, scale_factor=1.4),
                        Indicate(right_unit, color=RED, scale_factor=1.4),
                        run_time=step_time * 0.6,
                    )
                    self.play(
                        FadeOut(left_unit, shift=UP * 0.4),
                        FadeOut(right_unit, shift=UP * 0.4),
                        run_time=step_time * 0.6,
                    )
                self.play(Indicate(beam, color=GREEN, scale_factor=1.02), run_time=0.6)
            elif op == "balance_divide":
                shares = int(self.number(action.get("count"), 2, 2, 6))
                boxes = state["left_boxes"]
                right_units = state["right_units"]
                if not boxes or not right_units:
                    return
                per_share = max(1, len(right_units) // shares)
                # Regroup the right pan into one visible row per share, each
                # aligned with the unknown box it corresponds to.
                pan_right = state["pans"]["right"]
                base_y = pan_right.get_top()[1] + 0.16
                # Rows must stay clear of the beam above the pan.
                beam_y = beam.get_center()[1]
                headroom = beam_y - 0.22 - base_y
                row_gap = min(0.34, headroom / max(shares - 1, 1)) if shares > 1 else 0.34
                moves = []
                separators = VGroup()
                for share_index in range(shares):
                    share_units = right_units[
                        share_index * per_share:(share_index + 1) * per_share
                    ]
                    row_y = base_y + share_index * row_gap
                    for column, unit in enumerate(share_units):
                        moves.append(unit.animate.move_to([
                            pan_right.get_center()[0]
                            + (column - (per_share - 1) / 2) * 0.24,
                            row_y,
                            0,
                        ]))
                    if share_index > 0:
                        separators.add(DashedLine(
                            [pan_right.get_left()[0], row_y - row_gap / 2, 0],
                            [pan_right.get_right()[0], row_y - row_gap / 2, 0],
                            color=GREY_B, stroke_width=2, dash_length=0.08,
                        ))
                self.play(LaggedStart(*moves, lag_ratio=0.03), run_time=1.6)
                if len(separators):
                    self.play(Create(separators), run_time=0.6)
                # Pair each box with its share, one connector at a time.
                connectors = VGroup()
                for share_index, box in enumerate(boxes[:shares]):
                    row_y = base_y + share_index * 0.34
                    connector = DashedLine(
                        box.get_right() + RIGHT * 0.08,
                        [pan_right.get_left()[0] - 0.08, row_y, 0],
                        color=BLUE_B, stroke_width=2.5, dash_length=0.1,
                    )
                    connectors.add(connector)
                    self.play(
                        Indicate(box, color=BLUE, scale_factor=1.15),
                        Create(connector),
                        run_time=0.7,
                    )
                self.wait(0.5)
                self.play(FadeOut(connectors), run_time=0.4)
                self.play(Indicate(beam, color=GREEN, scale_factor=1.02), run_time=0.6)
            else:  # balance_verify
                solution = int(self.number(
                    action.get("expect"),
                    state["params"].get("solution", 1),
                    0, 24,
                ))
                replacements = []
                for box in state["left_boxes"]:
                    dots = VGroup(*[
                        Dot(radius=0.1, color=GREEN) for _ in range(max(solution, 1))
                    ]).arrange_in_grid(
                        rows=max(1, math.ceil(max(solution, 1) / 3)), cols=min(3, max(solution, 1)),
                        buff=(0.08, 0.08),
                    ).move_to(box.get_center())
                    replacements.append((box, dots))
                self.play(*[
                    ReplacementTransform(box, dots) for box, dots in replacements
                ], run_time=1.2)
                left_count = (
                    len(state["left_units"])
                    + sum(len(dots) for _, dots in replacements)
                )
                right_count = len(state["right_units"])
                verdict_color = GREEN if left_count == right_count else RED
                left_badge = Text(str(left_count), font_size=30, color=verdict_color)
                left_badge.next_to(state["pans"]["left"], DOWN, buff=0.18)
                right_badge = Text(str(right_count), font_size=30, color=verdict_color)
                right_badge.next_to(state["pans"]["right"], DOWN, buff=0.18)
                check = Text("✓" if left_count == right_count else "✗",
                             font_size=40, color=verdict_color)
                check.next_to(state["equal_sign"], UP, buff=0.15)
                self.play(FadeIn(left_badge), FadeIn(right_badge), run_time=0.6)
                self.play(
                    Indicate(beam, color=verdict_color, scale_factor=1.03),
                    FadeIn(check),
                    run_time=0.8,
                )
                self.wait(0.6)
        elif op == "swap_units":
            source_id = str(action.get("source") or (targets[0] if targets else ""))
            swap_count = int(self.number(action.get("count"), 0, 0, 64))
            marks_after = int(self.number(action.get("expect"), 0, 0, 6))
            target_total = int(self.number(action.get("expect_total"), -1, -1, 4096))
            units = self.ledger_units(source_id)
            marker_id = next(
                (m for m, h in self.attachment_hosts.items() if h == source_id), None
            )
            marks_before = 0
            if marker_id is not None:
                marks_before = int(self.number(
                    (self.specs.get(marker_id, {}).get("params") or {}).get("count_per_unit"),
                    0, 0, 6,
                ))
            if units and swap_count >= 1:
                swap_count = min(swap_count, len(units))
                delta = marks_after - marks_before
                running = len(units) * marks_before
                swapped_color = GREEN
                counter = None

                def show_running(value, color=YELLOW):
                    nonlocal counter
                    fresh = Text(f"总数: {value}", font_size=32, color=color)
                    fresh.to_corner(UR, buff=0.4)
                    if counter is not None:
                        self.remove(counter)
                    counter = fresh
                    self.add(counter)

                show_running(running)
                self.wait(0.6)
                step_time = 0.5 if swap_count <= 8 else max(0.16, 4.5 / swap_count)
                for offset in range(swap_count):
                    unit = units[-1 - offset]
                    # Geometry from the unit's OWN path: attached legs are
                    # children and would drag the bbox down.
                    own_points = unit.points
                    if len(own_points):
                        body_bottom = float(own_points[:, 1].min())
                        body_x = (
                            float(own_points[:, 0].min()) + float(own_points[:, 0].max())
                        ) / 2
                    else:
                        body_bottom = float(unit.get_bottom()[1])
                        body_x = float(unit.get_center()[0])
                    top_y = body_bottom - 0.01
                    new_marks = VGroup()
                    for index in range(max(delta, 0)):
                        # Continue the existing mark row rightward so the
                        # original a marks keep their positions.
                        mark_offset = (
                            marks_before + index - (marks_before - 1) / 2
                        ) * 0.075
                        new_marks.add(Line(
                            [body_x + mark_offset, top_y, 0],
                            [body_x + mark_offset, top_y - 0.16, 0],
                            color=swapped_color, stroke_width=2.5,
                        ))
                    running += delta
                    show_running(running)
                    animations = [unit.animate.set_color(swapped_color)]
                    if len(new_marks):
                        animations.append(
                            LaggedStart(*[GrowFromCenter(m) for m in new_marks],
                                        lag_ratio=0.1)
                        )
                    self.play(*animations, run_time=step_time)
                    for mark in new_marks:
                        unit.add(mark)
                reached = target_total < 0 or running == target_total
                show_running(running, GREEN if reached else RED)
                self.wait(0.8)
                # Group braces: swapped tail vs untouched head.
                remaining_units = units[: len(units) - swap_count]
                swapped_units = units[len(units) - swap_count:]
                badges = []
                if remaining_units:
                    brace_a = Brace(VGroup(*remaining_units), LEFT, buff=0.15)
                    label_a = Text(str(len(remaining_units)), font_size=28, color=BLUE)
                    label_a.next_to(brace_a, LEFT, buff=0.08)
                    badge_a = VGroup(brace_a, label_a)
                    badge_a.shift_onto_screen(buff=0.3)
                    self.register_badge(self.count_badges, source_id, badge_a)
                    badges.append(badge_a)
                if swapped_units:
                    brace_b = Brace(VGroup(*swapped_units), RIGHT, buff=0.15)
                    label_b = Text(str(len(swapped_units)), font_size=28, color=swapped_color)
                    label_b.next_to(brace_b, RIGHT, buff=0.08)
                    badge_b = VGroup(brace_b, label_b)
                    badge_b.shift_onto_screen(buff=0.3)
                    self.register_badge(
                        self.count_badges, source_id + "__swapped", badge_b
                    )
                    badges.append(badge_b)
                if badges:
                    self.play(*[GrowFromCenter(b) for b in badges], run_time=0.6)
        elif op == "replicate" and targets and result_id in self.objects:
            source_id = str(action.get("source") or (targets[0] if targets else ""))
            times = int(self.number(action.get("count"), 0, 0, 24))
            source_units = self.ledger_units(source_id)
            if source_units and times >= 1:
                if result_id not in visible:
                    animations = self.relayout(visible, [result_id])
                    animations.append(self.animate_create(result_id))
                    self.play(*animations)
                    visible.append(result_id)
                destination_body = self.container_body(result_id)
                per_row = len(source_units)
                usable_width = destination_body.width * 0.85
                usable_height = destination_body.height * 0.8
                cell_width = usable_width / max(per_row, 1)
                cell_height = usable_height / max(times, 1)
                origin = destination_body.get_center()
                left = origin[0] - usable_width / 2
                top = origin[1] + usable_height / 2
                result_ledger = self.unit_ledger.setdefault(result_id, [])
                row_counter = None
                for row in range(times):
                    if row == 0:
                        row_units = list(source_units)
                        for unit in row_units:
                            self.reparent_unit(source_id, unit)
                    else:
                        # Multiplication stamps visible copies of the SAME row:
                        # each new row is born on screen from the original.
                        row_units = [unit.copy() for unit in source_units]
                        for unit in row_units:
                            self.add(unit)
                    moves = []
                    for column, unit in enumerate(row_units):
                        slot = [
                            left + cell_width * (column + 0.5),
                            top - cell_height * (row + 0.5),
                            0,
                        ]
                        scale = min(1.0, cell_width * 0.8 / max(unit.width, 1e-6))
                        moves.append(unit.animate.move_to(slot).scale(scale))
                        result_ledger.append(unit)
                    fresh = Text(f"{row + 1} 份", font_size=30, color=YELLOW)
                    fresh.next_to(destination_body, UP, buff=0.2)
                    fresh.shift_onto_screen(buff=0.3)
                    if row_counter is not None:
                        self.remove(row_counter)
                    row_counter = fresh
                    self.add(row_counter)
                    self.play(
                        LaggedStart(*moves, lag_ratio=min(0.15, 1.0 / max(per_row, 1))),
                        run_time=0.55,
                    )
                if row_counter is not None:
                    self.remove(row_counter)
                formula = Text(
                    f"{times} × {per_row} = {times * per_row}",
                    font_size=26,
                    color=GREEN,
                )
                formula.next_to(destination_body, DOWN, buff=0.22)
                formula.shift_onto_screen(buff=0.3)
                self.register_badge(self.mapping_badges, result_id, formula)
                self.play(FadeIn(formula, shift=UP * 0.08))
        elif op == "count":
            for item in targets:
                if str(item) in visible or self.ledger_units(str(item)):
                    self.animate_count(str(item))
                    break
        elif op == "recount_verify":
            group_ids = [str(item) for item in targets if self.ledger_units(str(item))]
            expect_total = int(self.number(action.get("expect_total"), -1, -1, 4096))
            if group_ids:
                for item in group_ids:
                    if item not in self.count_badges:
                        self.animate_count(item)
                counts = [len(self.ledger_units(item)) for item in group_ids]
                total = sum(counts)
                passed = expect_total < 0 or total == expect_total
                verdict_color = GREEN if passed else RED
                equation = Text(
                    " + ".join(str(value) for value in counts) + " = " + str(total),
                    font_size=34,
                    color=verdict_color,
                )
                equation.to_edge(DOWN, buff=1.05)
                check = Text("✓" if passed else "✗", font_size=40, color=verdict_color)
                check.next_to(equation, RIGHT, buff=0.2)
                frames = VGroup(*[
                    SurroundingRectangle(
                        VGroup(*self.ledger_units(item)), color=verdict_color, buff=0.15,
                    )
                    for item in group_ids
                ])
                self.play(
                    LaggedStart(*[Create(frame) for frame in frames], lag_ratio=0.12),
                    FadeIn(equation),
                    FadeIn(check),
                )
                self.wait(0.6)
                self.play(FadeOut(frames))
        elif op == "move":
            moving = [self.objects[item] for item in targets if item in visible]
            destination_raw = str(action.get("destination") or "").strip()
            axis_value = None
            if "=" in destination_raw and destination_raw.replace(" ", "").lower().startswith("x="):
                axis_value = self.number(destination_raw.split("=", 1)[1], None, -1000, 1000)
            coordinate_heights = [item for item in targets if item in self.height_models]
            if coordinate_heights and self.scan_tracker is not None:
                self.play(
                    self.scan_tracker.animate.set_value(
                        axis_value if axis_value is not None else self.scan_target_x
                    ),
                    run_time=3,
                    rate_func=linear,
                )
            elif moving and destination_raw in self.objects:
                destination_body = self.container_body(destination_raw)
                self.play(
                    *[item.animate.next_to(destination_body, UP, buff=0.3) for item in moving]
                )
            elif moving:
                # No executable destination: emphasize instead of faking a
                # displacement — a token shift reads as "nothing happened".
                self.play(*[Indicate(item, color=YELLOW) for item in moving])
        elif op == "partition":
            selected = [self.objects[item] for item in targets if item in visible]
            source_id = next((item for item in targets if item in visible), None)
            deferred_source = False
            if source_id is None:
                source_id = next(
                    (item for item in targets if item in self.deferred_creates), None
                )
                deferred_source = source_id is not None
            source_units = self.repeat_units.get(source_id) if source_id else None
            result_units = self.repeat_units.get(result_id)
            if source_units is not None and result_units is not None and result_id in self.objects:
                source = self.objects[source_id]
                entrance_animations = []
                if deferred_source:
                    entrance_animations.extend(self.relayout(visible, [source_id]))
                    entrance_animations.append(FadeIn(source))
                    visible.append(source_id)
                    self.deferred_creates.discard(source_id)
                result = self.objects[result_id]
                result.move_to(source.get_center())
                ratio = max(1, math.ceil(len(source_units) / len(result_units)))
                self.partition_ratios[result_id] = ratio
                outlines = VGroup()
                for index in range(len(result_units)):
                    chunk = source_units[index * ratio:(index + 1) * ratio]
                    if len(chunk):
                        outlines.add(SurroundingRectangle(
                            VGroup(*chunk), color=YELLOW, buff=0.035, stroke_width=2,
                        ))
                self.play(
                    *entrance_animations,
                    LaggedStart(*[Create(box) for box in outlines], lag_ratio=0.06),
                )
                copies = []
                for index, result_unit in enumerate(result_units):
                    chunk = source_units[index * ratio:(index + 1) * ratio]
                    if len(chunk):
                        copy = VGroup(*[unit.copy() for unit in chunk])
                        copies.append((copy, result_unit))
                        self.add(copy)
                self.play(*[
                    copy.animate.move_to(result_unit).scale(0.7)
                    for copy, result_unit in copies
                ])
                self.play(
                    *[FadeOut(copy) for copy, _ in copies],
                    FadeOut(source), FadeOut(outlines),
                    self.animate_create(result_id),
                )
                if len(source_units) == ratio * len(result_units):
                    formula = Text(
                        f"{len(source_units)} ÷ {ratio} = {len(result_units)}",
                        font_size=22,
                        color=GREEN,
                    )
                    formula.next_to(result, DOWN, buff=0.22)
                    formula.add_updater(
                        lambda badge, host=result: badge.next_to(
                            host, DOWN, buff=0.22,
                        )
                    )
                    self.register_badge(self.mapping_badges, result_id, formula)
                    self.play(FadeIn(formula, shift=UP * 0.08))
                visible.remove(source_id)
                visible.append(result_id)
            elif selected:
                self.play(*[
                    item.animate.scale(0.88).shift((LEFT if index % 2 == 0 else RIGHT) * 0.32)
                    for index, item in enumerate(selected)
                ])
        elif op == "merge":
            selected_ids = [item for item in targets if item in visible]
            selected = [self.objects[item] for item in selected_ids]
            repeated_ids = [
                item for item in selected_ids if item in self.repeat_units
            ]
            if len(repeated_ids) >= 2:
                smaller_id = min(repeated_ids, key=lambda item: len(self.repeat_units[item]))
                larger_id = max(repeated_ids, key=lambda item: len(self.repeat_units[item]))
                smaller_units = self.repeat_units[smaller_id]
                larger_units = self.repeat_units[larger_id]
                pair_count = min(len(smaller_units), len(larger_units))
                connector = DoubleArrow(
                    self.objects[smaller_id].get_right(),
                    self.objects[larger_id].get_left(),
                    color=YELLOW, buff=0.12,
                )
                self.play(
                    GrowArrow(connector),
                    *[
                        larger_units[index].animate.set_color(
                            self.color(self.specs[smaller_id].get("color"))
                        )
                        for index in range(pair_count)
                    ],
                )
                self.play(FadeOut(connector))
                self.mapped_into[smaller_id] = (larger_id, pair_count)
                return
            if selected:
                center = sum((item.get_center() for item in selected), ORIGIN) / len(selected)
                self.play(*[item.animate.move_to(center) for item in selected])
        elif op == "measure":
            selected_ids = [item for item in targets if item in visible]
            selected = [self.objects[item] for item in selected_ids]
            if selected:
                brace = Brace(VGroup(*selected), DOWN, color=YELLOW)
                new_badges = []
                for item in selected_ids:
                    spec = self.specs[item]
                    if spec.get("primitive") != "polygon":
                        continue
                    params = spec.get("params") or {}
                    value = params.get("verified_measure")
                    vertices = params.get("vertices") or []
                    if value is None and len(vertices) >= 3:
                        coordinate_area = 0.0
                        valid_vertices = True
                        for index, point in enumerate(vertices):
                            next_point = vertices[(index + 1) % len(vertices)]
                            if not (
                                isinstance(point, list)
                                and len(point) >= 2
                                and isinstance(next_point, list)
                                and len(next_point) >= 2
                            ):
                                valid_vertices = False
                                break
                            coordinate_area += (
                                self.number(point[0], 0) * self.number(next_point[1], 0)
                                - self.number(next_point[0], 0) * self.number(point[1], 0)
                            )
                        if valid_vertices:
                            value = abs(coordinate_area) / 2
                    if value is None:
                        continue
                    badge = Text(
                        f"面积 = {self.number(value, 0):g}",
                        font_size=28,
                        color=GREEN,
                    )
                    badge.to_corner(UR, buff=0.5).shift(DOWN * 0.7)
                    self.register_badge(self.measurement_badges, item, badge)
                    new_badges.append(badge)
                self.play(
                    GrowFromCenter(brace),
                    *[Indicate(item, color=YELLOW) for item in selected],
                    *[FadeIn(badge, shift=UP * 0.08) for badge in new_badges],
                )
                self.play(FadeOut(brace))
        elif op == "compare":
            selected = [self.objects[item] for item in targets if item in visible]
            if len(selected) >= 2:
                start = selected[0].get_right()
                end = selected[1].get_left()
                if abs(end[0] - start[0]) + abs(end[1] - start[1]) < 0.3:
                    center = (start + end) / 2
                    start = center + LEFT * 0.7
                    end = center + RIGHT * 0.7
                connector = DoubleArrow(
                    start, end,
                    color=YELLOW, buff=0.12,
                )
                compare_badge = None
                first_params = self.specs[targets[0]].get("params") or {}
                second_params = self.specs[targets[1]].get("params") or {}
                def comparison_value(params):
                    if params.get("y") is not None:
                        return params.get("y")
                    positions = params.get("positions") or []
                    y_values = [
                        position[1]
                        for position in positions
                        if isinstance(position, list) and len(position) >= 2
                    ]
                    if y_values and all(value == y_values[0] for value in y_values):
                        return y_values[0]
                    return params.get("value", params.get("count"))
                first_raw = comparison_value(first_params)
                second_raw = comparison_value(second_params)
                if first_raw is not None and second_raw is not None:
                    first_value = self.number(first_raw, 0)
                    second_value = self.number(second_raw, 0)
                    greater = max(first_value, second_value)
                    smaller = min(first_value, second_value)
                    difference = greater - smaller
                    self.last_comparison_difference = difference
                    smaller_text = f"({smaller:g})" if smaller < 0 else f"{smaller:g}"
                    compare_badge = Text(
                        f"{greater:g} − {smaller_text} = {difference:g}",
                        font_size=22, color=YELLOW,
                    )
                    compare_badge.next_to(VGroup(*selected[:2]), DOWN, buff=0.22)
                    compare_badge.add_updater(
                        lambda badge, pair=selected[:2]: badge.next_to(
                            VGroup(*pair), DOWN, buff=0.22,
                        )
                    )
                self.play(
                    GrowArrow(connector),
                    *[Indicate(item, color=YELLOW) for item in selected[:2]],
                    *([FadeIn(compare_badge)] if compare_badge is not None else []),
                )
                self.play(FadeOut(connector))
                if compare_badge is not None:
                    self.register_badge(self.comparison_badges, frozenset(targets[:2]), compare_badge)
            elif selected:
                self.play(Indicate(selected[0], color=YELLOW))
        elif op == "verify":
            selected_ids = [item for item in targets if item in visible]
            selected_ids = [
                item for item in selected_ids
                if not (
                    item in self.attached_ids
                    and self.attachment_hosts.get(item) in selected_ids
                )
            ]
            # An empty labeled container carries no evidence: framing it with
            # a green check would verify nothing (the incident pattern).
            selected_ids = [
                item for item in selected_ids
                if not (
                    self.specs.get(item, {}).get("primitive") == "rectangle"
                    and not self.ledger_units(item)
                )
            ]
            selected = [self.objects[item] for item in selected_ids]
            if selected:
                framed = [*selected]
                selected_set = set(selected_ids)
                framed.extend(
                    badge
                    for compared_ids, badge in self.comparison_badges.items()
                    if compared_ids.issubset(selected_set)
                )
                for item in selected_ids:
                    badge = self.mapping_badges.get(item)
                    if badge is not None:
                        framed.append(badge)
                    badge = self.measurement_badges.get(item)
                    if badge is not None:
                        framed.append(badge)
                frames = VGroup(*[
                    SurroundingRectangle(item, color=GREEN, buff=0.16)
                    for item in framed
                ])
                check = Text("✓", font_size=42, color=GREEN).next_to(
                    frames, RIGHT, buff=0.22,
                )
                # The frame verifies the whole relation without recolouring
                # every object; recolouring would erase the mapped/unmapped
                # distinction at exactly the moment it is being checked.
                self.play(
                    LaggedStart(*[Create(frame) for frame in frames], lag_ratio=0.12),
                    FadeIn(check),
                )
                self.play(FadeOut(frames), FadeOut(check))
        elif op == "highlight":
            mapped_units = []
            mapped_ids = set()
            for item in targets:
                mapping = self.mapped_into.get(item)
                if mapping is None:
                    continue
                mapped_ids.add(item)
                target_id, count = mapping
                target_units = self.repeat_units.get(target_id)
                if target_units is not None:
                    mapped_units.extend(target_units[:count])
            missing = [
                item for item in targets
                if item not in visible and item not in mapped_ids
            ]
            if missing:
                self.play(*[FadeIn(self.objects[item]) for item in missing])
                visible.extend(missing)
            selected = [self.objects[item] for item in targets if item in visible]
            if selected or mapped_units:
                self.play(
                    *[Indicate(item, color=YELLOW) for item in selected],
                    *[Indicate(item, color=GREEN, scale_factor=1.35) for item in mapped_units],
                )
        else:
            selected = [self.objects[item] for item in targets if item in visible]
            if selected:
                self.play(*[Indicate(item, color=YELLOW) for item in selected])

    def construct(self):
        problem_card = self.fit(Text(PROBLEM_TEXT, font_size=39, color=WHITE), 11.0, 5.4)
        self.play(Write(problem_card))
        self.wait(3)
        heading = Text("用图形观察数学关系", font_size=31, color=BLUE).to_edge(UP, buff=0.28)
        self.play(FadeOut(problem_card), FadeIn(heading))

        self.prepare_coordinate_system()
        self.objects = {spec["id"]: self.make_visual(spec) for spec in VISUAL_OBJECTS}
        if self.geometry_background is not None:
            self.play(FadeIn(self.geometry_background), run_time=0.6)
        visible = []
        caption = None
        self.beat_manifest = []
        for beat_index, scene in enumerate(VISUAL_SCENES):
            beat_start_time = float(self.renderer.time)
            caption = self.show_caption(caption, scene.get("teaching_line"))
            actions = scene.get("actions", [])
            for index, action in enumerate(actions):
                next_action = actions[index + 1] if index + 1 < len(actions) else {}
                # A source created only to be immediately partitioned is one
                # semantic action.  Deferring its entrance lets the units and
                # grouping outlines appear together instead of presenting a
                # misleading static block for a full animation beat.
                if (
                    action.get("op") == "create"
                    and next_action.get("op") == "partition"
                    and set(action.get("targets") or [])
                    and set(action.get("targets") or []).issubset(
                        set(next_action.get("targets") or [])
                    )
                ):
                    self.deferred_creates.update(action.get("targets") or [])
                    continue
                self.execute_action(action, visible)
            # Honor the plan's pacing budget: animations that finished early
            # get observation time instead of rushing to the next beat. This
            # is what makes key states pause long enough to read.
            elapsed = float(self.renderer.time) - beat_start_time
            planned = self.number(scene.get("duration_s"), 0.0, 0.0, 20.0)
            self.wait(min(8.0, max(0.7, planned - elapsed)))
            self.record_beat(beat_index, scene)

        if caption is not None:
            self.play(FadeOut(caption))
        self.emit_beat_manifest()
        answer = self.fit(Text(ANSWER_TEXT, font_size=34, color=GREEN), 10.6, 1.0)
        answer.to_edge(DOWN, buff=0.3)
        shown_ids = [
            item for item in visible
            if not (
                item in self.attached_ids
                and self.attachment_hosts.get(item) in visible
            )
        ]
        shown = [self.objects[item] for item in shown_ids]
        # The answer band must be clear: if any visible content (objects or
        # their badges) dips into it, lift everything above the band first.
        lift_targets = list(shown)
        for registry in (
            self.count_badges, self.mapping_badges,
            self.comparison_badges, self.measurement_badges,
        ):
            lift_targets.extend(registry.values())
        answer_top = answer.get_top()[1] + 0.2
        lowest = min(
            (item.get_bottom()[1] for item in lift_targets if item.width > 0),
            default=answer_top,
        )
        if lowest < answer_top:
            lift = min(1.6, answer_top - lowest)
            self.play(
                *[item.animate.shift(UP * lift) for item in lift_targets],
                run_time=0.5,
            )
        self.play(FadeIn(answer))
        if shown:
            self.play(*[Indicate(item, color=GREEN, scale_factor=1.03) for item in shown])
        self.wait(3)
"""
    return (
        template.replace("__PROBLEM_JSON__", json.dumps(problem, ensure_ascii=False))
        .replace("__ANSWER_JSON__", json.dumps(answer, ensure_ascii=False))
        .replace("__OBJECTS_JSON__", repr(visual_ir["objects"]))
        .replace("__SCENES_JSON__", repr(visual_ir["scenes"]))
    )


def build_verified_fallback_code(ctx: ToolContext) -> str:
    """Build a deterministic, content-agnostic visual relation explanation.

    This is a delivery fallback, not a problem-type renderer. A valid Visual IR
    is compiled directly from composable objects and actions. Older stored
    plans fall back to verified magnitude/relation diagrams, never prose pages.
    """
    problem = _wrap_fallback_text(ctx.problem, width=22, max_lines=5)
    answer = _wrap_fallback_text(
        "答案：" + _plain_fallback_text(ctx.state.get("solution_answer") or "已验证"),
        width=24,
        max_lines=3,
    )
    visual_ir = _fallback_visual_ir(ctx.state.get("visual_plan"))
    if visual_ir is not None:
        return _build_visual_ir_fallback_code(
            problem=problem,
            answer=answer,
            visual_ir=visual_ir,
        )

    raw_steps = ctx.state.get("solution_steps") or []
    if len(raw_steps) > 6:
        raw_steps = [*raw_steps[:5], raw_steps[-1]]
    models = [_fallback_relation_model(raw, index) for index, raw in enumerate(raw_steps, start=1)]
    if not models:
        models = [
            {
                "mode": "relation",
                "title": "已验证推理",
                "left": "题目条件",
                "right": "已验证结论",
                "result": "",
            }
        ]

    return f"""from manim import *

PROBLEM_TEXT = {json.dumps(problem, ensure_ascii=False)}
STEP_MODELS = {json.dumps(models, ensure_ascii=False, indent=4)}
ANSWER_TEXT = {json.dumps(answer, ensure_ascii=False)}


class SolutionScene(Scene):
    def fit(self, item, max_width=10.8, max_height=4.8):
        if item.width > max_width:
            item.scale_to_fit_width(max_width)
        if item.height > max_height:
            item.scale_to_fit_height(max_height)
        return item

    def quantity_bar(self, value, label, color, max_value):
        ratio = abs(float(value)) / max(max_value, 1.0)
        width = max(1.0, 4.2 * ratio)
        body = RoundedRectangle(
            width=width,
            height=0.72,
            corner_radius=0.12,
            stroke_color=color,
            stroke_width=3,
            fill_color=color,
            fill_opacity=0.28,
        )
        tick_count = min(max(int(abs(float(value))), 1), 12)
        ticks = VGroup()
        for tick_index in range(1, tick_count):
            x = -width / 2 + width * tick_index / tick_count
            ticks.add(Line([x, -0.29, 0], [x, 0.29, 0], color=color, stroke_width=1))
        value_text = Text(str(label), font_size=28, color=WHITE).move_to(body)
        return VGroup(body, ticks, value_text)

    def relation_card(self, text, color):
        label = self.fit(Text(str(text), font_size=27, color=WHITE), 4.2, 1.8)
        box = RoundedRectangle(
            width=max(2.4, label.width + 0.65),
            height=max(1.15, label.height + 0.5),
            corner_radius=0.14,
            stroke_color=color,
            stroke_width=3,
            fill_color=color,
            fill_opacity=0.18,
        )
        label.move_to(box)
        return VGroup(box, label)

    def make_board(self, model):
        if model["mode"] == "quantity":
            maximum = max(
                abs(float(model["left_value"])),
                abs(float(model["right_value"])),
                abs(float(model["output_value"])),
                1.0,
            )
            left = self.quantity_bar(
                model["left_value"], model["left_label"], BLUE, maximum
            )
            right = self.quantity_bar(
                model["right_value"], model["right_label"], ORANGE, maximum
            )
            operator = Text(model["operator"], font_size=38, color=YELLOW)
            inputs = VGroup(left, operator, right).arrange(RIGHT, buff=0.35)
            arrow = Arrow(UP * 0.2, DOWN * 0.55, color=WHITE, buff=0.05)
            output = self.quantity_bar(
                model["output_value"], model["output_label"], GREEN, maximum
            )
            output_tag = Text("得到", font_size=22, color=GREEN).next_to(output, LEFT, buff=0.28)
            result_group = VGroup(output_tag, output).arrange(RIGHT, buff=0.28)
            board = VGroup(inputs, arrow, result_group).arrange(DOWN, buff=0.32)
            focus = result_group
        else:
            premise = self.relation_card(model["left"], BLUE)
            conclusion = self.relation_card(model["right"], GREEN)
            arrow = Arrow(LEFT, RIGHT, color=YELLOW, buff=0.12, max_tip_length_to_length_ratio=0.15)
            board = VGroup(premise, arrow, conclusion).arrange(RIGHT, buff=0.45)
            focus = conclusion
        self.fit(board, 10.6, 3.7)
        return board, focus

    def construct(self):
        problem_card = self.fit(Text(PROBLEM_TEXT, font_size=40, color=WHITE))
        problem_card.move_to(ORIGIN)
        self.play(Write(problem_card))
        self.wait(3)
        self.play(FadeOut(problem_card))

        title = Text("已验证的数学关系", font_size=34, color=BLUE).to_edge(UP, buff=0.35)
        progress = VGroup(*[
            Circle(radius=0.11, stroke_color=WHITE, stroke_width=2)
            for _ in STEP_MODELS
        ]).arrange(RIGHT, buff=0.28).next_to(title, DOWN, buff=0.3)
        progress[0].set_fill(BLUE, opacity=1)
        step_title = self.fit(Text(STEP_MODELS[0]["title"], font_size=27, color=WHITE), 10.4, 1.0)
        step_title.next_to(progress, DOWN, buff=0.38)
        board, focus = self.make_board(STEP_MODELS[0])
        board.move_to(DOWN * 0.65)
        self.play(FadeIn(title), FadeIn(progress), FadeIn(step_title))
        self.play(FadeIn(board, shift=UP * 0.2))
        self.play(Indicate(focus, color=GREEN, scale_factor=1.04))
        self.wait(1.2)

        for index in range(1, len(STEP_MODELS)):
            next_title = self.fit(
                Text(STEP_MODELS[index]["title"], font_size=27, color=WHITE), 10.4, 1.0
            )
            next_title.move_to(step_title)
            next_board, next_focus = self.make_board(STEP_MODELS[index])
            next_board.move_to(board)
            self.play(
                FadeOut(step_title),
                FadeOut(board, shift=DOWN * 0.15),
                progress[index].animate.set_fill(BLUE, opacity=1),
            )
            step_title = next_title
            board = next_board
            focus = next_focus
            self.play(FadeIn(step_title), FadeIn(board, shift=UP * 0.15))
            self.play(Indicate(focus, color=GREEN, scale_factor=1.04))
            self.wait(1.2)

        answer = self.fit(Text(ANSWER_TEXT, font_size=38, color=GREEN), max_height=3.2)
        answer.move_to(UP * 0.35)
        verified = Text("上述结果已通过独立校验", font_size=26, color=WHITE)
        verified.next_to(answer, DOWN, buff=0.55)
        self.play(FadeOut(step_title), FadeOut(board), FadeOut(progress), FadeOut(title))
        self.play(FadeIn(answer), FadeIn(verified))
        self.wait(3)
"""


class CompileVideoTool(ITool):
    def __init__(
        self,
        writer: GenerateManimCodeTool,
        validator: ValidateManimCodeTool,
        renderer: RunManimTool,
    ) -> None:
        self._writer = writer
        self._validator = validator
        self._renderer = renderer

    @property
    def name(self) -> str:
        return "compile_video"

    @property
    def description(self) -> str:
        return (
            "把 SceneSpec 编译为可播放视频。阶段内部完成 Manim 写码、确定性静态门禁、"
            "语义审计和渲染；首稿失败时只允许一次由具体证据驱动的修复。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "review_repair": {
                    "type": "boolean",
                    "description": "是否由成片审查触发；该模式同样允许一次证据定向内部修复",
                },
                "visual_fallback_only": {
                    "type": "boolean",
                    "description": "跳过模型写码，直接渲染已验证关系图保底",
                },
                "model_codegen": {
                    "type": "boolean",
                    "description": "仅当 Visual IR 无法无损编译时显式启用模型写码",
                },
                "deterministic_ir": {
                    "type": "boolean",
                    "description": "仅在计划完全落入通用 IR 能力范围时使用确定性编译器",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        review_repair = bool(args.get("review_repair"))
        artifacts: list[ArtifactSpec] = []
        steps: list[dict[str, Any]] = []
        repair_count = 0
        # Soft-pass notes describe the previous compile's candidate only.
        ctx.state.pop("contract_soft_pass_issues", None)
        if args.get("visual_fallback_only"):
            rejected = ToolResult(
                success=False,
                summary="成片复审判定为纯文字或无视觉论证",
                error="meaningless_visual_candidate",
            )
            return await self._fallback_or_failed(
                "已拒绝纯文字候选",
                rejected,
                steps,
                artifacts,
                repair_count,
                ctx,
                review_repair=False,
            )
        visual_plan = ctx.state.get("visual_plan")
        compile_strategy = (
            str(visual_plan.get("compile_strategy") or "") if isinstance(visual_plan, dict) else ""
        )
        deterministic_ir = _fallback_visual_ir(visual_plan)
        plan_has_figure = isinstance(visual_plan, dict) and any(
            isinstance(o, dict) and o.get("primitive") == "figure"
            for o in visual_plan.get("visual_objects") or []
        )
        if (
            visual_plan
            and deterministic_ir is not None
            and (
                bool(args.get("deterministic_ir"))
                # 带图计划的重修同样走确定性编译：重修产出的是**新计划**，
                # 确定性地把它编出来就是修复本身。此前重修一律跳过 IR 去找模型写码，
                # 带图计划撞上写码保险丝，首审不过就必然掉进静态保底（实机闭环验证）
                or plan_has_figure
                or (
                    not review_repair
                    and not args.get("model_codegen")
                    and compile_strategy != "model_codegen"
                )
            )
        ):
            return await self._compile_visual_ir(ctx, artifacts, steps)

        # 带原图的计划**绝不**交给模型写码：模型手里没有真坐标，写出来必然是
        # 另一张编造的图（实机事故：满屏乱点乱线）。IR 不可用宁可走已验证
        # 关系图保底——图会缺席，但画面不撒谎
        if isinstance(visual_plan, dict) and any(
            isinstance(o, dict) and o.get("primitive") == "figure"
            for o in visual_plan.get("visual_objects") or []
        ):
            logger.warning("figure 计划的 IR 不可用，拒绝模型写码，走确定性保底")
            rejected = ToolResult(
                success=False,
                summary="figure 计划无法进入确定性 IR 编译",
                error="figure_ir_unavailable",
            )
            return await self._fallback_or_failed(
                "带原图的计划拒绝模型写码",
                rejected,
                steps,
                artifacts,
                repair_count,
                ctx,
                review_repair=False,
            )

        generated = await self._writer.execute({}, ctx)
        artifacts.extend(generated.artifacts)
        steps.append(self._step("write", generated))
        if not generated.success:
            # A review-triggered recompile deserves the same single
            # evidence-directed repair as a cold compile: an API slip in the
            # repair draft must not immediately discard the whole attempt.
            repair_count += 1
            ctx.state["last_generation_error"] = generated.error or generated.summary
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("write_repair", generated))
            if not generated.success:
                return await self._fallback_or_failed(
                    "写码修复失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )

        validated = await self._validator.execute({}, ctx)
        steps.append(self._step("validate", validated))
        if not validated.success:
            if repair_count >= 1:
                if not self._contract_soft_pass(validated, ctx, steps):
                    return await self._fallback_or_failed(
                        "代码门禁未通过",
                        validated,
                        steps,
                        artifacts,
                        repair_count,
                        ctx,
                        review_repair=review_repair,
                    )
            else:
                repair_count += 1
                generated = await self._writer.execute({}, ctx)
                artifacts.extend(generated.artifacts)
                steps.append(self._step("repair", generated))
                if not generated.success:
                    return await self._fallback_or_failed(
                        "证据定向修复失败",
                        generated,
                        steps,
                        artifacts,
                        repair_count,
                        ctx,
                        review_repair=review_repair,
                    )
                validated = await self._validator.execute({}, ctx)
                steps.append(self._step("revalidate", validated))
                if not validated.success and not self._contract_soft_pass(
                    validated, ctx, steps
                ):
                    return await self._fallback_or_failed(
                        "修复后代码门禁仍未通过",
                        validated,
                        steps,
                        artifacts,
                        repair_count,
                        ctx,
                        review_repair=review_repair,
                    )

        rendered = await self._renderer.execute({}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("render", rendered))
        if not rendered.success:
            if repair_count >= 1:
                return await self._fallback_or_failed(
                    "渲染未通过",
                    rendered,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            repair_count += 1
            generated = await self._writer.execute({}, ctx)
            artifacts.extend(generated.artifacts)
            steps.append(self._step("render_repair", generated))
            if not generated.success:
                return await self._fallback_or_failed(
                    "渲染修复写码失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            validated = await self._validator.execute({}, ctx)
            steps.append(self._step("repair_validate", validated))
            if not validated.success and not self._contract_soft_pass(
                validated, ctx, steps
            ):
                return await self._fallback_or_failed(
                    "渲染修复未通过代码门禁",
                    validated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
            rendered = await self._renderer.execute({}, ctx)
            artifacts.extend(rendered.artifacts)
            steps.append(self._step("rerender", rendered))
            if not rendered.success:
                return await self._fallback_or_failed(
                    "修复后仍无法渲染",
                    rendered,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )

        ctx.state["compile_internal_repairs"] = (
            int(ctx.state.get("compile_internal_repairs") or 0) + repair_count
        )
        ctx.state["last_compiler"] = "model"
        # A normal model-authored render replaces any earlier delivery fallback.
        # Keep the quality warning until Watch has reviewed this new candidate.
        ctx.state.pop("delivery_fallback", None)
        ctx.state.pop("delivery_fallback_reason", None)
        data = {
            "code": ctx.state.get("latest_manim_code") or "",
            "video_path": ctx.state.get("latest_video_path"),
            "video_url": ctx.state.get("latest_video_url"),
            "internal_repair_count": repair_count,
            "internal_steps": steps,
        }
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename=f"compile-turn{ctx.turn_index:02d}.json",
                content=json.dumps(
                    {"stage": self.name, "internal_repair_count": repair_count},
                    ensure_ascii=False,
                    indent=2,
                ),
                meta={"stage": self.name, "internal_repair_count": repair_count},
            )
        )
        return ToolResult(
            success=True,
            summary=(
                "编译成功：写码、校验、渲染均通过"
                + (f"（内部定向修复 {repair_count} 次）" if repair_count else "（首稿通过）")
            ),
            data=data,
            artifacts=artifacts,
        )

    async def _compile_visual_ir(
        self,
        ctx: ToolContext,
        artifacts: list[ArtifactSpec],
        steps: list[dict[str, Any]],
    ) -> ToolResult:
        """Compile the validated scene contract without another generative hop."""
        code = build_verified_fallback_code(ctx)
        ctx.state["latest_manim_code"] = code
        ctx.state["last_validation_passed"] = True
        ctx.state.pop("delivery_fallback", None)
        ctx.state.pop("delivery_fallback_reason", None)
        artifacts.append(
            ArtifactSpec(
                kind="manim_code",
                filename=f"compiled-turn{ctx.turn_index:02d}.py",
                content=code,
                meta={"mode": "visual_ir_compiler", "quality_degraded": False},
            )
        )
        rendered = await self._renderer.execute({"code": code}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("visual_ir_render", rendered))
        if not rendered.success:
            return self._failed(
                "Visual IR 确定性编译未能渲染",
                rendered,
                steps,
                artifacts,
                0,
            )
        ctx.state["last_compiler"] = "visual_ir"
        report = {
            "stage": self.name,
            "success": True,
            "compiler": "visual_ir",
            "internal_repair_count": 0,
        }
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename=f"compile-turn{ctx.turn_index:02d}.json",
                content=json.dumps(report, ensure_ascii=False, indent=2),
                meta=report,
            )
        )
        return ToolResult(
            success=True,
            summary="编译成功：已验证 Visual IR 首次确定性渲染通过",
            data={
                "code": code,
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
                "internal_repair_count": 0,
                "internal_steps": steps,
                "deterministic_compiler": True,
                "delivery_fallback": False,
            },
            artifacts=artifacts,
        )

    @staticmethod
    def _step(name: str, result: ToolResult) -> dict[str, Any]:
        return {
            "name": name,
            "success": result.success,
            "summary": result.summary,
            "error": result.error,
        }

    @staticmethod
    def _contract_soft_pass(
        validated: ToolResult, ctx: ToolContext, steps: list[dict[str, Any]]
    ) -> bool:
        """Render despite a failed validation when only contract heuristics remain.

        Visual-evidence / graphical-reasoning / semantic-audit checks compare
        source text against the SceneSpec — proxies with real false positives
        that historically diverted most model code into the template fallback.
        The rendered-frame review is the authoritative judge of graphical
        reasoning, so let it decide.  Crash-class gates (syntax, structure,
        missing problem opening) still block unconditionally.
        """
        data = validated.data or {}
        if not data.get("syntax_ok"):
            return False
        if data.get("structure_issues") or data.get("problem_opening_issues"):
            return False
        remaining = (
            list(data.get("visual_evidence_issues") or [])
            + list(data.get("graphical_reasoning_issues") or [])
            + list(data.get("semantic_audit_issues") or [])
        )
        if not remaining:
            return False
        ctx.state["contract_soft_pass_issues"] = [str(item) for item in remaining[:6]]
        # The stale validator hints are superseded by the soft pass; leaving
        # them in state would hijack a later review repair's error context.
        ctx.state.pop("last_validation_issues", None)
        if ctx.state.get("last_error_source") == "validate":
            ctx.state.pop("last_error_source", None)
        steps.append(
            {
                "name": "contract_soft_pass",
                "success": True,
                "summary": (
                    "仅剩契约类校验问题，放行渲染交由成片审查裁决："
                    + "；".join(str(item) for item in remaining[:2])
                ),
                "error": None,
            }
        )
        return True

    def _failed(
        self,
        label: str,
        result: ToolResult,
        steps: list[dict[str, Any]],
        artifacts: list[ArtifactSpec],
        repair_count: int,
    ) -> ToolResult:
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename="compile-failed.json",
                content=json.dumps(
                    {
                        "stage": self.name,
                        "internal_repair_count": repair_count,
                        "success": False,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                meta={
                    "stage": self.name,
                    "internal_repair_count": repair_count,
                    "success": False,
                },
            )
        )
        return ToolResult(
            success=False,
            summary=f"{label}；编译阶段已停止无证据试错",
            data={
                "code": "",
                "internal_repair_count": repair_count,
                "internal_steps": steps,
            },
            artifacts=artifacts,
            error=result.error or result.summary,
        )

    async def _fallback_or_failed(
        self,
        label: str,
        result: ToolResult,
        steps: list[dict[str, Any]],
        artifacts: list[ArtifactSpec],
        repair_count: int,
        ctx: ToolContext,
        *,
        review_repair: bool,
    ) -> ToolResult:
        """Guarantee a playable first delivery without hiding quality loss."""
        original_error = result.error or result.summary
        fallback_code = build_verified_fallback_code(ctx)
        ctx.state["latest_manim_code"] = fallback_code
        ctx.state["delivery_fallback"] = True
        ctx.state["delivery_fallback_reason"] = original_error
        ctx.state["last_validation_passed"] = False
        fallback_artifact = ArtifactSpec(
            kind="manim_code",
            filename=f"fallback-turn{ctx.turn_index:02d}.py",
            content=fallback_code,
            meta={"mode": "verified_delivery_fallback", "quality_degraded": True},
        )
        artifacts.append(fallback_artifact)
        rendered = await self._renderer.execute({"code": fallback_code}, ctx)
        artifacts.extend(rendered.artifacts)
        steps.append(self._step("verified_fallback_render", rendered))
        if not rendered.success:
            return self._failed(
                "模型代码与确定性交付保底均未能渲染",
                rendered,
                steps,
                artifacts,
                repair_count,
            )
        ctx.state["last_compiler"] = "visual_ir"

        report = {
            "stage": self.name,
            "success": True,
            "quality_degraded": True,
            "delivery_fallback": True,
            "internal_repair_count": repair_count,
            "primary_failure": label,
            "primary_error": original_error,
        }
        artifacts.append(
            ArtifactSpec(
                kind="pipeline_report",
                filename=f"compile-fallback-turn{ctx.turn_index:02d}.json",
                content=json.dumps(report, ensure_ascii=False, indent=2),
                meta=report,
            )
        )
        return ToolResult(
            success=True,
            summary=(
                f"{label}；已生成可播放的已验证关系图保底视频，"
                "画面质量标记为 degraded，后续仍会进入成片审查"
            ),
            data={
                "code": fallback_code,
                "video_path": ctx.state.get("latest_video_path"),
                "video_url": ctx.state.get("latest_video_url"),
                "internal_repair_count": repair_count,
                "internal_steps": steps,
                "delivery_fallback": True,
                "quality_degraded": True,
                "primary_error": original_error,
            },
            artifacts=artifacts,
        )
