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
    return "\n".join(lines)


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

    def prepare_coordinate_system(self):
        self.specs = {spec["id"]: spec for spec in VISUAL_OBJECTS}
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
                path_specs.append(spec)
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
        if primitive == "dot":
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
            width = min(3.2, 1.0 + 0.18 * units)
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
        if spec["id"] in self.coordinate_ids:
            label_text = str(spec.get("label") or "").strip()
            if label_text and primitive in {"line", "dot"}:
                label = Text(label_text, font_size=20, color=color)
                label.next_to(body, UP, buff=0.12)
                label.shift_onto_screen(buff=0.25)
                return VGroup(body, label)
            return body
        return self.labeled(body, spec)

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
        free_ids = [item for item in ids if item not in self.coordinate_ids]
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
        caption = Text(str(text or "观察图形关系的变化"), font_size=25, color=WHITE)
        self.fit(caption, 11.0, 0.9)
        caption.to_edge(DOWN, buff=0.3)
        if old_caption is None:
            self.play(FadeIn(caption))
        else:
            self.play(FadeOut(old_caption), FadeIn(caption))
        return caption

    def execute_action(self, action, visible):
        op = action["op"]
        targets = [item for item in action.get("targets", []) if item in self.objects]
        result_id = action.get("result")
        if op == "create":
            new_ids = [item for item in targets if item not in visible]
            animations = self.relayout(visible, new_ids)
            animations.extend(FadeIn(self.objects[item], shift=UP * 0.12) for item in new_ids)
            if animations:
                self.play(*animations)
            visible.extend(new_ids)
        elif op in {"transform", "map"} and targets and result_id in self.objects:
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
            if selected:
                self.play(*[
                    item.animate.scale(0.88).shift((LEFT if index % 2 == 0 else RIGHT) * 0.32)
                    for index, item in enumerate(selected)
                ])
        elif op == "merge":
            selected = [self.objects[item] for item in targets if item in visible]
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
                self.play(
                    GrowArrow(connector),
                    *[Indicate(item, color=YELLOW) for item in selected[:2]],
                )
                self.play(FadeOut(connector))
            elif selected:
                self.play(Indicate(selected[0], color=YELLOW))
        elif op == "verify":
            selected = [self.objects[item] for item in targets if item in visible]
            if selected:
                frame = SurroundingRectangle(VGroup(*selected), color=GREEN, buff=0.18)
                check = Text("✓", font_size=42, color=GREEN).next_to(frame, RIGHT, buff=0.22)
                self.play(
                    Create(frame), FadeIn(check),
                    *[Indicate(item, color=GREEN) for item in selected],
                )
                self.play(FadeOut(frame), FadeOut(check))
        elif op == "highlight":
            missing = [item for item in targets if item not in visible]
            if missing:
                self.play(*[FadeIn(self.objects[item]) for item in missing])
                visible.extend(missing)
            selected = [self.objects[item] for item in targets if item in visible]
            if selected:
                self.play(*[Indicate(item, color=YELLOW) for item in selected])
        else:
            selected = [self.objects[item] for item in targets if item in visible]
            if selected:
                self.play(*[Indicate(item, color=YELLOW) for item in selected])

    def construct(self):
        problem_card = self.fit(Text(PROBLEM_TEXT, font_size=39, color=WHITE), 11.0, 5.4)
        self.play(Write(problem_card))
        self.wait(3)
        self.play(FadeOut(problem_card))

        self.prepare_coordinate_system()
        self.objects = {spec["id"]: self.make_visual(spec) for spec in VISUAL_OBJECTS}
        heading = Text("用图形观察数学关系", font_size=31, color=BLUE).to_edge(UP, buff=0.28)
        self.play(FadeIn(heading))
        visible = []
        caption = None
        for scene in VISUAL_SCENES:
            caption = self.show_caption(caption, scene.get("teaching_line"))
            for action in scene.get("actions", []):
                self.execute_action(action, visible)
            self.wait(0.7)

        if caption is not None:
            self.play(FadeOut(caption))
        answer = self.fit(Text(ANSWER_TEXT, font_size=34, color=GREEN), 10.6, 1.0)
        answer.to_edge(DOWN, buff=0.3)
        self.play(FadeIn(answer))
        shown = [self.objects[item] for item in visible]
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
                }
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        review_repair = bool(args.get("review_repair"))
        artifacts: list[ArtifactSpec] = []
        steps: list[dict[str, Any]] = []
        repair_count = 0
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
