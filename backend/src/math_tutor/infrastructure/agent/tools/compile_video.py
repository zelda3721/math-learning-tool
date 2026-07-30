"""One bounded compile stage: write → validate → render.

Static/semantic validation and Manim execution are compiler internals, not
agent planning stages.  A first production draft receives at most one
evidence-directed repair before the high-level stage returns.
"""
from __future__ import annotations

import json
import re
import textwrap
from typing import Any

from ....application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from .generate_manim_code import GenerateManimCodeTool
from .run_manim import RunManimTool
from .validate_manim_code import ValidateManimCodeTool


def _plain_fallback_text(value: Any) -> str:
    """Convert common math markup into glyphs safe for Manim Text."""
    text = str(value or "").strip()
    text = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"\1/\2", text)
    text = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", text)
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
    "arrow",
    "quantity_bar",
    "unit_grid",
    "number_line",
    "axes",
    "polygon",
    "relation_node",
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
}


def _safe_ir_value(value: Any, depth: int = 0) -> Any:
    """Keep fallback IR bounded and JSON-only; it is never executed as code."""
    if depth > 3:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, list):
        return [_safe_ir_value(item, depth + 1) for item in value[:64]]
    if isinstance(value, dict):
        return {
            str(key)[:40]: _safe_ir_value(item, depth + 1)
            for key, item in list(value.items())[:24]
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
        objects.append(
            {
                "id": object_id,
                "primitive": primitive,
                "meaning": _wrap_fallback_text(meaning, width=18, max_lines=2),
                "label": _wrap_fallback_text(
                    raw.get("label") or meaning, width=14, max_lines=2
                ),
                "color": str(raw.get("color") or "blue").strip().lower()[:24],
                "params": _safe_ir_value(raw.get("params") or {}),
            }
        )
    if len(objects) < 2:
        return None

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
                str(item)
                for item in (raw_action.get("targets") or [])
                if str(item) in object_ids
            ]
            result = str(raw_action.get("result") or "")
            if op not in _FALLBACK_IR_ACTIONS or not targets:
                continue
            actions.append(
                {
                    "op": op,
                    "targets": targets,
                    "result": result if result in object_ids else "",
                    "meaning": _wrap_fallback_text(
                        raw_action.get("meaning") or raw_scene.get("action") or op,
                        width=24,
                        max_lines=2,
                    ),
                }
            )
        if actions:
            scenes.append(
                {
                    "role": str(raw_scene.get("role") or "").lower(),
                    "teaching_line": _wrap_fallback_text(
                        raw_scene.get("teaching_line") or raw_scene.get("attention_target"),
                        width=30,
                        max_lines=2,
                    ),
                    "actions": actions,
                }
            )
    if len(scenes) < 2:
        return None
    return {"objects": objects, "scenes": scenes}


def _build_visual_ir_fallback_code(
    *, problem: str, answer: str, visual_ir: dict[str, Any]
) -> str:
    """Compile generic Visual IR into conservative, deterministic Manim code."""
    template = r'''from manim import *
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

    def repeated_body(self, primitive, params, color):
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
            rows=rows, cols=columns, buff=(0.11, 0.13),
        )
        return body

    def animate_create(self, object_id):
        item = self.objects[object_id]
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
            for index in range(per_unit):
                offset = (index - (per_unit - 1) / 2) * 0.075
                mark = Line(
                    center + [offset, -0.08, 0],
                    center + [offset, -0.27, 0],
                    color=color, stroke_width=2.5,
                )
                unit.add(mark)
                marks.add(mark)
        self.attached_ids.add(marker_id)
        self.attachment_hosts[marker_id] = host_id
        self.objects[marker_id] = marks
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
        axes_specs = [spec for spec in VISUAL_OBJECTS if spec["primitive"] == "axes"]
        self.axes_spec = axes_specs[0] if axes_specs else None
        if self.axes_spec is None:
            self.scan_tracker = None
            return
        self.coordinate_ids.add(self.axes_spec["id"])
        path_specs = []
        height_specs = []
        for spec in VISUAL_OBJECTS:
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
        for spec in VISUAL_OBJECTS:
            if spec["primitive"] == "dot" and (
                "交点" in spec.get("meaning", "") or "intersection" in spec["id"].lower()
            ):
                self.coordinate_ids.add(spec["id"])

    def make_visual(self, spec):
        primitive = spec["primitive"]
        params = spec.get("params") or {}
        color = self.color(spec.get("color"))
        repeated = self.repeated_body(primitive, params, color)
        if repeated is not None and spec["id"] not in self.coordinate_ids:
            body = repeated
            self.repeat_units[spec["id"]] = body
        elif primitive == "dot":
            if spec["id"] in self.coordinate_ids and hasattr(self, "primary_axes"):
                params = spec.get("params") or {}
                point_x = self.number(params.get("x"), self.scan_target_x)
                point_y = self.number(params.get("y"), self.scan_target_y)
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
            if spec["id"] in self.coordinate_segments and hasattr(self, "primary_axes"):
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
        elif primitive == "arrow":
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
            count = int(self.number(params.get("count", 12), 12, 1, 64))
            columns = int(self.number(params.get("columns", math.ceil(math.sqrt(count))), 4, 1, 8))
            cells = VGroup(*[
                Square(side_length=0.34, color=color, fill_color=color, fill_opacity=0.24)
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
            body = Axes(
                x_range=[x_start, x_end, max((x_end - x_start) / 5, 0.5)],
                y_range=[y_start, y_end, max((y_end - y_start) / 5, 0.5)],
                x_length=8.6, y_length=4.7,
                axis_config={"color": color, "include_tip": True},
            )
            body.move_to(UP * 0.15)
            self.primary_axes = body
            if len(self.coordinate_models) >= 2:
                x_mark = Text(f"{self.scan_target_x:g}", font_size=20, color=WHITE)
                y_mark = Text(f"{self.scan_target_y:g}", font_size=20, color=WHITE)
                x_mark.next_to(body.c2p(self.scan_target_x, 0), DOWN, buff=0.1)
                y_mark.next_to(body.c2p(0, self.scan_target_y), LEFT, buff=0.1)
                body.add(x_mark, y_mark)
        elif primitive == "polygon":
            sides = int(self.number(params.get("sides", 3), 3, 3, 8))
            vertices = [
                [0.9 * math.cos(TAU * i / sides), 0.9 * math.sin(TAU * i / sides), 0]
                for i in range(sides)
            ]
            body = Polygon(*vertices, color=color, fill_color=color, fill_opacity=0.18)
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
            if label_text and primitive in {"line", "dot"}:
                label = Text(label_text, font_size=20, color=color)
                label.next_to(body, UP, buff=0.12)
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
                        self.mapping_badges[result_id] = formula
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
                    self.mapping_badges[result_id] = formulas
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
                    self.mapping_badges[result_id] = formulas
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
                    self.mapping_badges[result_id] = formula
                    self.play(FadeIn(formula, shift=UP * 0.08))
                self.mapped_into[source_id] = (result_id, pair_count)
                return
            source_objects = [self.objects[item] for item in source_ids]
            source = source_objects[0] if len(source_objects) == 1 else VGroup(*source_objects)
            result = self.objects[result_id]
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
        elif op == "move":
            moving = [self.objects[item] for item in targets if item in visible]
            coordinate_heights = [item for item in targets if item in self.height_models]
            if coordinate_heights and self.scan_tracker is not None:
                self.play(
                    self.scan_tracker.animate.set_value(self.scan_target_x),
                    run_time=3,
                    rate_func=linear,
                )
            elif moving:
                self.play(*[item.animate.shift(UP * 0.35) for item in moving])
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
                    self.mapping_badges[result_id] = formula
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
            selected = [self.objects[item] for item in targets if item in visible]
            if selected:
                brace = Brace(VGroup(*selected), DOWN, color=YELLOW)
                self.play(
                    GrowFromCenter(brace),
                    *[Indicate(item, color=YELLOW) for item in selected],
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
                first_raw = first_params.get("value", first_params.get("count"))
                second_raw = second_params.get("value", second_params.get("count"))
                if first_raw is not None and second_raw is not None:
                    first_value = self.number(first_raw, 0)
                    second_value = self.number(second_raw, 0)
                    greater = max(first_value, second_value)
                    smaller = min(first_value, second_value)
                    difference = greater - smaller
                    self.last_comparison_difference = difference
                    compare_badge = Text(
                        f"{greater:g} − {smaller:g} = {difference:g}",
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
                    self.comparison_badges[frozenset(targets[:2])] = compare_badge
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
        visible = []
        caption = None
        for scene in VISUAL_SCENES:
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
            self.wait(0.7)

        if caption is not None:
            self.play(FadeOut(caption))
        answer = self.fit(Text(ANSWER_TEXT, font_size=34, color=GREEN), 10.6, 1.0)
        answer.to_edge(DOWN, buff=0.3)
        self.play(FadeIn(answer))
        shown_ids = [
            item for item in visible
            if not (
                item in self.attached_ids
                and self.attachment_hosts.get(item) in visible
            )
        ]
        shown = [self.objects[item] for item in shown_ids]
        if shown:
            self.play(*[Indicate(item, color=GREEN, scale_factor=1.03) for item in shown])
        self.wait(3)
'''
    return (
        template.replace("__PROBLEM_JSON__", json.dumps(problem, ensure_ascii=False))
        .replace("__ANSWER_JSON__", json.dumps(answer, ensure_ascii=False))
        .replace(
            "__OBJECTS_JSON__", repr(visual_ir["objects"])
        )
        .replace(
            "__SCENES_JSON__", repr(visual_ir["scenes"])
        )
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
    models = [
        _fallback_relation_model(raw, index)
        for index, raw in enumerate(raw_steps, start=1)
    ]
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

    return f'''from manim import *

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
'''


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
                    "description": "是否由成片审查触发；该模式不再进行内部二次修复",
                },
                "visual_fallback_only": {
                    "type": "boolean",
                    "description": "跳过模型写码，直接渲染已验证关系图保底",
                },
                "model_codegen": {
                    "type": "boolean",
                    "description": "仅供实验：让模型自由写 Manim；生产默认编译 Visual IR",
                }
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        review_repair = bool(args.get("review_repair"))
        artifacts: list[ArtifactSpec] = []
        steps: list[dict[str, Any]] = []
        repair_count = 0
        if ctx.state.get("visual_plan") and not args.get("model_codegen"):
            return await self._compile_visual_ir(ctx, artifacts, steps)
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

        generated = await self._writer.execute({}, ctx)
        artifacts.extend(generated.artifacts)
        steps.append(self._step("write", generated))
        if not generated.success:
            if review_repair:
                return await self._fallback_or_failed(
                    "成片修复写码失败",
                    generated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
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
            if review_repair or repair_count >= 1:
                return await self._fallback_or_failed(
                    "代码门禁未通过",
                    validated,
                    steps,
                    artifacts,
                    repair_count,
                    ctx,
                    review_repair=review_repair,
                )
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
            if not validated.success:
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
            if review_repair or repair_count >= 1:
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
            if not validated.success:
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
