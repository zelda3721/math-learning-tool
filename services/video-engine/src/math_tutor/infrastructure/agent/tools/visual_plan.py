"""Open-world visual direction for a verified mathematical solution.

The contract deliberately describes *semantics* (what changes, what stays
invariant, and where attention should move) instead of choosing a problem
type or a named animation template.  New and transformed problems therefore
use the same planner without extending an enum.
"""

from __future__ import annotations

import json
import logging
import math
import re
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from .. import markdown_extract as md
from ..math_runtime import (
    evaluate_real_expression_at,
    execute_math_request,
    extract_linear_balance_structure,
    extract_linear_mix_structure,
    sample_real_expression,
)
from ..occupancy_table import parse_zone
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)

_VALID_ROLES = {"setup", "transform", "reveal", "verify"}
_VISUAL_PRIMITIVES = {
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
    # A two-pan balance holding unknown boxes and unit dots; equality made
    # physical. params: coefficient/constant/total/solution/variable.
    "balance",
    # Calculus vocabulary.  math_runtime already differentiates, integrates
    # and takes limits; without drawable constructs those verified results
    # could only degrade into generic boxes.  Every one of these carries the
    # expression it is derived from, so a renderer recomputes the geometry
    # instead of receiving decorative shapes.
    # params: expression/variable/at_x/slope (+ grounded start/end).
    "tangent_line",
    # params: expression/variable/x0/h (+ grounded slope/start/end).
    "secant_line",
    # params: expression/variable/x_range/n/side ('left'|'right'|'mid').
    "riemann_rects",
    # params: expression/variable/target/from ('left'|'right'|'both').
    "limit_approach",
    # params: outer/inner/variable/x_range (x →(inner)→ u →(outer)→ y).
    "composition_chain",
}
# Calculus constructs are continuous relationships, not unit collections:
# they never carry a unit count and must not be pulled into the quantity
# ledger by a param named ``count``.
_CALCULUS_PRIMITIVES = {
    "tangent_line",
    "secant_line",
    "riemann_rects",
    "limit_approach",
    "composition_chain",
}
# Graphics that express a relationship between other objects rather than a
# standalone quantity; revealing one against an existing object is itself a
# causal step in a visual argument.
_RELATIONSHIP_PRIMITIVES = {
    "line",
    "arrow",
    "function_curve",
    *_CALCULUS_PRIMITIVES,
}
_VISUAL_ACTIONS = {
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
    # Quantity verbs (Visual IR v2): parameter-enforced operations whose
    # lowering must preserve unit-object continuity and conservation.
    "take_from",
    "combine",
    "count",
    "recount_verify",
    "replicate",
    "swap_units",
    # Balance verbs: the same operation applied to BOTH sides at once.
    "balance_remove",
    "balance_divide",
    "balance_verify",
}
_QUANTITY_ACTIONS = {
    "take_from",
    "combine",
    "count",
    "recount_verify",
    "replicate",
    "swap_units",
}
_MUTATING_VISUAL_ACTIONS = {
    "transform",
    "move",
    "partition",
    "merge",
    "map",
    "take_from",
    "combine",
    "replicate",
    "swap_units",
    "balance_remove",
    "balance_divide",
}
_VERIFY_VISUAL_ACTIONS = {"compare", "measure", "verify", "recount_verify", "balance_verify"}
_TAKE_FROM_STYLES = {"cross_out", "fade", "fly"}
# Typed axis destination for coordinate-scan moves, e.g. "x=2.5".
_AXIS_DESTINATION_RE = re.compile(r"^x\s*=\s*[-+]?\d+(?:\.\d+)?$")
_SECTION_ALIASES = ("视觉计划", "视觉规划", "Visual Plan", "visual_plan", "计划")
_BACKTICKS = "`'\"‘’“”"
_ZONE_LIKE_RE = re.compile(r"[A-Fa-f][1-6]\s*[-–—~～to至]\s*[A-Fa-f][1-6]")
_SINGLE_ANCHOR_RE = re.compile(r"\b([A-Fa-f][1-6])\b")
_COORDINATE_PAIR_RE = re.compile(r"[（(]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[)）]")
_WHY_SIGNAL_WORDS = (
    "为什么",
    "因为",
    "揭示",
    "本质",
    "看到",
    "看见",
    "对应",
    "守恒",
    "等量",
    "不变",
    "原理",
    "让学生",
    "意味着",
    "保持",
    "变化",
    "等价",
)
_AUDIT_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_])[-+]?\d+(?:\.\d+)?")
_AUDIT_EQUALITY_RE = re.compile(
    r"([-+]?\d+(?:\.\d+)?)\s*([+\-×xX*÷/])\s*"
    r"([-+]?\d+(?:\.\d+)?)\s*=\s*([-+]?\d+(?:\.\d+)?)"
)
_AUDIT_OPERATION_RE = re.compile(
    r"([-+]?\d+(?:\.\d+)?)\s*([+\-×xX*÷/])\s*"
    r"([-+]?\d+(?:\.\d+)?)"
)

_VISUAL_PLAN_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "open_world_visual_plan",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "visual_thesis": {"type": "string"},
                "essence_rationale": {"type": "string"},
                "symbol_ledger": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "visual_objects": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "primitive": {
                                "type": "string",
                                "enum": sorted(_VISUAL_PRIMITIVES),
                            },
                            "meaning": {"type": "string"},
                            "label": {"type": "string"},
                            "color": {"type": "string"},
                            "params": {
                                "type": "object",
                                "additionalProperties": True,
                            },
                        },
                        "required": [
                            "id",
                            "primitive",
                            "meaning",
                            "label",
                            "color",
                            "params",
                        ],
                        "additionalProperties": False,
                    },
                },
                "scenes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "role": {
                                "type": "string",
                                "enum": sorted(_VALID_ROLES),
                            },
                            "anchor_zone": {"type": "string"},
                            "key_objects": {"type": "string"},
                            "action": {"type": "string"},
                            "invariant": {"type": "string"},
                            "attention_target": {"type": "string"},
                            "exit_condition": {"type": "string"},
                            "teaching_line": {"type": "string"},
                            "duration_s": {"type": "number"},
                            "actions": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    # Flat nullable fields instead of a per-op
                                    # discriminated union: local constrained
                                    # decoders compile flat grammars reliably;
                                    # per-op presence is enforced by
                                    # _validate_plan with targeted messages.
                                    "properties": {
                                        "op": {
                                            "type": "string",
                                            "enum": sorted(_VISUAL_ACTIONS),
                                        },
                                        "targets": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "result": {"type": "string"},
                                        "meaning": {"type": "string"},
                                        "source": {"type": ["string", "null"]},
                                        "destination": {"type": ["string", "null"]},
                                        "count": {"type": ["integer", "null"]},
                                        "style": {"type": ["string", "null"]},
                                        "parts": {
                                            "type": ["array", "null"],
                                            "items": {"type": "integer"},
                                        },
                                        "expect": {"type": ["integer", "null"]},
                                        "expect_total": {"type": ["integer", "null"]},
                                    },
                                    "required": [
                                        "op",
                                        "targets",
                                        "result",
                                        "meaning",
                                        "source",
                                        "destination",
                                        "count",
                                        "style",
                                        "parts",
                                        "expect",
                                        "expect_total",
                                    ],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": [
                            "role",
                            "anchor_zone",
                            "key_objects",
                            "action",
                            "invariant",
                            "attention_target",
                            "exit_condition",
                            "teaching_line",
                            "duration_s",
                            "actions",
                        ],
                        "additionalProperties": False,
                    },
                },
                "forbidden": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": [
                "visual_thesis",
                "essence_rationale",
                "symbol_ledger",
                "visual_objects",
                "scenes",
                "forbidden",
            ],
            "additionalProperties": False,
        },
    },
}


def _raw_plan_artifact(done: Any, ctx: ToolContext) -> ArtifactSpec:
    text = getattr(done, "text", "") or ""
    reasoning = getattr(done, "reasoning", "") or ""
    content = text
    if reasoning and reasoning != text:
        content = f"## visible\n{text}\n\n## reasoning\n{reasoning}"
    return ArtifactSpec(
        kind="planner_raw",
        filename=f"visual-plan-raw-turn{ctx.turn_index:02d}.txt",
        content=content,
        meta={
            "finish_reason": getattr(done, "finish_reason", ""),
            "visible_chars": len(text),
            "reasoning_chars": len(reasoning),
        },
    )


def archetype_to_code_pattern_names(archetype: str) -> list[str]:
    """Compatibility shim for old callers; production no longer maps types."""
    return []


def _parse_plan_audit(
    text: str,
) -> tuple[bool, list[str], list[str], dict[str, Any] | None] | None:
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
        payload.get("corrected_plan") if isinstance(payload.get("corrected_plan"), dict) else None,
    )


_FULL_EQUALITY_RE = re.compile(
    # The left expression must start at a true boundary: a fragment beginning
    # right after a letter, digit, operator or closing paren is a slice of a
    # longer (possibly symbolic) expression such as "2x+5" and must not be
    # evaluated as literal arithmetic.
    r"(?P<left>(?<![0-9A-Za-z).+\-*/.])[\d\s+\-*/().]+?)=\s*(?P<right>-?\d+(?:\.\d+)?)"
)


def _false_literal_equality(text: str) -> bool:
    """True when the text contains a FULL literal equality that is false.

    The naive three-token pattern used to slice sub-expressions out of longer
    ones ("2*4+5=13" matched as "4+5=13") and veto correct plans; evaluate
    whole literal expressions instead, and treat unparseable fragments as
    not machine-checkable.
    """
    normalized = (
        text.replace("×", "*").replace("÷", "/").replace("−", "-").replace("^", "**")
    )
    from fractions import Fraction as _Fraction

    for match in _FULL_EQUALITY_RE.finditer(normalized):
        left_expression = match.group("left").strip()
        if not re.search(r"\d", left_expression):
            continue
        try:
            import ast as _ast

            def evaluate(node: Any) -> _Fraction:
                if isinstance(node, _ast.Expression):
                    return evaluate(node.body)
                if isinstance(node, _ast.Constant) and isinstance(
                    node.value, (int, float)
                ):
                    return _Fraction(str(node.value))
                if isinstance(node, _ast.UnaryOp) and isinstance(
                    node.op, (_ast.UAdd, _ast.USub)
                ):
                    value = evaluate(node.operand)
                    return value if isinstance(node.op, _ast.UAdd) else -value
                if isinstance(node, _ast.BinOp):
                    left, right = evaluate(node.left), evaluate(node.right)
                    operators = {
                        _ast.Add: lambda: left + right,
                        _ast.Sub: lambda: left - right,
                        _ast.Mult: lambda: left * right,
                        _ast.Div: lambda: left / right,
                        _ast.Pow: lambda: left ** int(right),
                    }
                    if type(node.op) in operators:
                        return operators[type(node.op)]()
                raise ValueError("non-literal")

            actual = evaluate(_ast.parse(left_expression, mode="eval"))
            expected = _Fraction(match.group("right"))
        except (ValueError, SyntaxError, ZeroDivisionError, OverflowError):
            continue
        if actual != expected:
            return True
    return False


def _machine_checkable_blocking_issue(issue: str) -> bool:
    """Accept only falsifiable arithmetic/scalar conflicts as blockers."""
    text = str(issue or "")
    if not (text.startswith("BLOCKING:") and "observed=" in text and "expected=" in text):
        return False
    if _false_literal_equality(text):
        return True
    observed_tail = text.split("observed=", 1)[1]
    # Audit prose is model-authored and may place ``expected=`` before
    # ``observed=``. That is not a machine-checkable blocker and must never
    # crash the production pipeline.
    if "expected=" not in observed_tail:
        return False
    observed, expected = observed_tail.split("expected=", 1)
    observed_numbers = _AUDIT_NUMBER_RE.findall(observed)
    expected_numbers = _AUDIT_NUMBER_RE.findall(expected)
    return (
        len(observed_numbers) == 1
        and len(expected_numbers) == 1
        and float(observed_numbers[0]) != float(expected_numbers[0])
    )


def _strip_decorations(value: str) -> str:
    text = str(value or "").strip()
    # JSON accepts sequences such as \f and \t. Local models frequently emit
    # LaTeX with a single backslash inside JSON, so ``\frac`` and ``\text``
    # arrive as control characters plus trailing letters. Recover only exact
    # command spellings; ordinary whitespace remains untouched.
    escaped_math_commands = {
        "\x0crac": r"\frac",
        "\text": r"\text",
        "\times": r"\times",
        "\theta": r"\theta",
        "\to": r"\to",
        "\right": r"\right",
        "\begin": r"\begin",
        "\neq": r"\neq",
        "\nabla": r"\nabla",
        "\not": r"\not",
    }
    for damaged, restored in escaped_math_commands.items():
        text = text.replace(damaged, restored)
    while len(text) >= 2 and text[0] in _BACKTICKS and text[-1] in _BACKTICKS:
        text = text[1:-1].strip()
    return text


def _clean_zone(value: str) -> str:
    text = _strip_decorations(value)
    match = _ZONE_LIKE_RE.search(text)
    if match:
        return match.group(0).replace(" ", "")
    match = _SINGLE_ANCHOR_RE.search(text)
    return match.group(1).upper() if match else text


def _normalize_quantity_verb_near_misses(plan: dict[str, Any]) -> None:
    """Repair mechanical near-misses in quantity-verb usage in place.

    Shape tolerance only, mathematics untouched: an invalid take_from style
    falls back to the default migration; a RESULT id that was never declared
    (results are new outputs by definition) gets a neutral container
    declaration so a 97%-correct plan is not discarded over one omission.
    """
    objects = plan.get("visual_objects")
    if not isinstance(objects, list):
        return
    declared = {
        str(item.get("id"))
        for item in objects
        if isinstance(item, dict) and item.get("id")
    }
    for scene in plan.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        for action in scene.get("actions") or []:
            if not isinstance(action, dict):
                continue
            op = str(action.get("op") or "")
            if op == "take_from":
                style = str(action.get("style") or "").strip()
                if style and style not in _TAKE_FROM_STYLES:
                    action["style"] = "fly"
            result = str(action.get("result") or "").strip()
            if (
                result
                and result not in declared
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", result)
                and op in {"transform", "partition", "map", "combine", "replicate", "take_from"}
            ):
                objects.append(
                    {
                        "id": result,
                        "primitive": "rectangle",
                        "meaning": str(action.get("meaning") or "承接结果的容器")[:60],
                        "label": "",
                        "color": "gray",
                        "params": {},
                    }
                )
                declared.add(result)


def _normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(plan, dict):
        return plan
    _normalize_quantity_verb_near_misses(plan)

    # Backward-compatible read of stored plans.  The legacy value is treated
    # as free prose; it is never matched against or converted to an enum.
    thesis = plan.get("visual_thesis") or plan.get("primary_pattern") or ""
    plan["visual_thesis"] = _strip_decorations(thesis)
    plan.pop("primary_pattern", None)
    plan.pop("secondary_pattern", None)
    plan["essence_rationale"] = _strip_decorations(plan.get("essence_rationale") or "")

    ledger = plan.get("symbol_ledger") or []
    if isinstance(ledger, str):
        ledger = [x.strip() for x in re.split(r"[\n;；]+", ledger) if x.strip()]
    if isinstance(ledger, list) and len(ledger) == 1:
        # Presentation infrastructure may supply the universal focus mapping;
        # the model still has to define at least one content-specific meaning.
        ledger = [*ledger, "高亮描边 = 当前 beat 的唯一注意焦点"]
    plan["symbol_ledger"] = ledger if isinstance(ledger, list) else []

    visual_objects = plan.get("visual_objects") or []
    if isinstance(visual_objects, list):
        for item in visual_objects:
            if not isinstance(item, dict):
                continue
            item["id"] = _strip_decorations(item.get("id") or "")
            item["primitive"] = _strip_decorations(item.get("primitive") or "").lower()
            item["meaning"] = _strip_decorations(item.get("meaning") or "")
            item["label"] = _strip_decorations(item.get("label") or "")
            item["color"] = _strip_decorations(item.get("color") or "blue").lower()
            params = item.get("params") if isinstance(item.get("params"), dict) else {}
            # Canonicalize semantic quantity names without knowing the
            # problem domain. Local models often emit count_per_head,
            # count_per_item, etc.; the renderer only needs the universal
            # relation "marks per repeated unit".
            if "count_per_unit" not in params:
                per_unit_key = next(
                    (key for key in params if str(key).startswith("count_per_")),
                    None,
                )
                if per_unit_key is not None:
                    params["count_per_unit"] = params[per_unit_key]
            primitive = item["primitive"]
            if (
                primitive == "quantity_bar"
                and isinstance(params.get("start"), list)
                and isinstance(params.get("end"), list)
            ):
                # A planner may name a coordinate-height indicator a "bar".
                # Its two coordinate endpoints are stronger evidence than the
                # loose primitive name, so render the exact segment instead
                # of an unrelated aggregate-value rectangle.
                item["primitive"] = "line"
                primitive = "line"
                params["points"] = [params["start"], params["end"]]
            if primitive == "dot" and not all(key in params for key in ("x", "y")):
                coordinate = _COORDINATE_PAIR_RE.search(f"{item['meaning']} {item['label']}")
                if coordinate is not None:
                    params["x"] = float(coordinate.group(1))
                    params["y"] = float(coordinate.group(2))
            function_name = str(params.get("func") or "").strip().lower()
            if (
                primitive == "line"
                and "points" not in params
                and isinstance(params.get("start"), list)
                and isinstance(params.get("end"), list)
            ):
                params["points"] = [params["start"], params["end"]]
            elif (
                primitive == "line"
                and "points" not in params
                and all(key in params for key in ("x1", "y1", "x2", "y2"))
            ):
                params["points"] = [
                    [params["x1"], params["y1"]],
                    [params["x2"], params["y2"]],
                ]
            if primitive == "line" and function_name == "linear":
                params.setdefault("slope", 1)
                params.setdefault("intercept", 0)
                params.pop("func", None)
            elif primitive == "line" and (function_name or params.get("expression")):
                item["primitive"] = "function_curve"
                if not params.get("expression"):
                    params["expression"] = f"{function_name}(x)" if function_name else "x"
                params.setdefault("variable", "x")
            total = params.get("total")
            if primitive == "quantity_bar" and "value" not in params and total is not None:
                params["value"] = total
            elif (
                primitive in {"dot", "circle", "rectangle", "line", "arrow", "polygon", "unit_grid"}
                and "count" not in params
            ):
                try:
                    numeric_total = int(round(float(total)))
                except (TypeError, ValueError):
                    numeric_total = 0
                if 1 < numeric_total <= 64:
                    params["count"] = numeric_total
            item["params"] = params
    plan["visual_objects"] = visual_objects if isinstance(visual_objects, list) else []

    # Close any four-vertex polygon that is explicitly anchored by two vector
    # arrows with a shared origin.  The three shared points determine the
    # fourth affine point exactly: p12 = p1 + p2 - origin.  This repairs a
    # common coordinate transcription error without knowing what problem
    # produced the vectors or inventing a new visual template.
    vector_pairs: list[tuple[list[float], list[float], list[float]]] = []
    arrows = [
        item
        for item in visual_objects
        if isinstance(item, dict) and item.get("primitive") == "arrow"
    ]
    for index, first in enumerate(arrows):
        first_params = first.get("params") or {}
        first_start = first_params.get("start")
        first_end = first_params.get("end")
        if not (
            isinstance(first_start, list)
            and len(first_start) >= 2
            and isinstance(first_end, list)
            and len(first_end) >= 2
        ):
            continue
        for second in arrows[index + 1 :]:
            second_params = second.get("params") or {}
            second_start = second_params.get("start")
            second_end = second_params.get("end")
            if not (
                isinstance(second_start, list)
                and len(second_start) >= 2
                and isinstance(second_end, list)
                and len(second_end) >= 2
            ):
                continue
            try:
                origin = [float(first_start[0]), float(first_start[1])]
                other_origin = [float(second_start[0]), float(second_start[1])]
                first_point = [float(first_end[0]), float(first_end[1])]
                second_point = [float(second_end[0]), float(second_end[1])]
            except (TypeError, ValueError):
                continue
            if all(abs(left - right) <= 1e-8 for left, right in zip(origin, other_origin)):
                vector_pairs.append((origin, first_point, second_point))

    def same_point(left: Any, right: list[float]) -> bool:
        if not isinstance(left, list) or len(left) < 2:
            return False
        try:
            return all(abs(float(left[index]) - right[index]) <= 1e-8 for index in range(2))
        except (TypeError, ValueError):
            return False

    for item in visual_objects:
        if not isinstance(item, dict) or item.get("primitive") != "polygon":
            continue
        params = item.get("params") or {}
        vertices = params.get("vertices")
        if not isinstance(vertices, list) or len(vertices) != 4:
            continue
        for origin, first_point, second_point in vector_pairs:
            if not all(
                any(same_point(vertex, required) for vertex in vertices)
                for required in (origin, first_point, second_point)
            ):
                continue
            expected = [
                first_point[0] + second_point[0] - origin[0],
                first_point[1] + second_point[1] - origin[1],
            ]
            params["vertices"] = [origin, first_point, expected, second_point]
            item["params"] = params
            break

    repeat_counts: dict[str, int] = {}
    for item in visual_objects:
        if not isinstance(item, dict):
            continue
        try:
            count = int(round(float((item.get("params") or {}).get("count") or 0)))
        except (TypeError, ValueError):
            continue
        if 1 < count <= 64 and item.get("id"):
            repeat_counts[str(item["id"])] = count

    scenes = plan.get("scenes") or []
    if isinstance(scenes, list):
        declared_object_ids = {
            str(item.get("id"))
            for item in visual_objects
            if isinstance(item, dict) and item.get("id")
        }
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            for field in (
                "role",
                "key_objects",
                "action",
                "invariant",
                "attention_target",
                "exit_condition",
                "teaching_line",
            ):
                scene[field] = _strip_decorations(scene.get(field) or "")
            scene["role"] = scene["role"].lower()
            scene["anchor_zone"] = _clean_zone(scene.get("anchor_zone") or "")
            # Preserve semantic safety without spending another LLM call on
            # omitted boilerplate fields. Core objects/action/attention and
            # teaching_line remain mandatory and are never synthesized.
            if not scene["invariant"]:
                scene["invariant"] = "已验证解答中的数学关系、对象含义和符号账本映射保持不变"
            if not scene["exit_condition"] and scene["attention_target"]:
                scene["exit_condition"] = (
                    "当前动作完成，且学生能够清楚观察：" + scene["attention_target"]
                )
            try:
                scene["duration_s"] = float(scene.get("duration_s") or 0)
            except (TypeError, ValueError):
                scene["duration_s"] = 0.0
            actions = scene.get("actions") or []
            if isinstance(actions, list):
                normalized_actions: list[dict[str, Any]] = []
                for raw_action in actions:
                    if not isinstance(raw_action, dict):
                        continue
                    action = dict(raw_action)
                    action["op"] = _strip_decorations(action.get("op") or "").lower()
                    targets = action.get("targets") or []
                    if isinstance(targets, str):
                        targets = [targets]
                    action["targets"] = [
                        _strip_decorations(target)
                        for target in targets
                        if isinstance(target, str) and target.strip()
                    ]
                    # A planner may address a geometric feature such as
                    # ``axes.origin`` even though Visual IR deliberately keeps
                    # only drawable object identities.  If the root is a
                    # declared object, lower the feature reference to that
                    # object. Unknown roots remain untouched for validation.
                    action["targets"] = [
                        target.split(".", 1)[0]
                        if "." in target and target.split(".", 1)[0] in declared_object_ids
                        else target
                        for target in action["targets"]
                    ]
                    raw_result = action.get("result") or ""
                    result_values = (
                        [
                            _strip_decorations(item)
                            for item in raw_result
                            if isinstance(item, str) and item.strip()
                        ]
                        if isinstance(raw_result, list)
                        else []
                    )
                    action["result"] = (
                        result_values[0]
                        if len(result_values) == 1
                        else _strip_decorations(raw_result)
                        if not isinstance(raw_result, list)
                        else ""
                    )
                    # `result` has schema meaning only when an action creates a
                    # successor state. Local models often put a prose status
                    # such as "坐标系建立" on create/highlight; discarding that
                    # unused decoration avoids a pointless repair turn.
                    if action["op"] not in {"transform", "partition", "map"}:
                        action["result"] = ""
                    action["meaning"] = _strip_decorations(action.get("meaning") or "")
                    if (
                        action["op"] in {"transform", "partition", "map"}
                        and action["result"] in action["targets"]
                    ):
                        # A successor action cannot replace an object with
                        # itself. Preserve the intended attention cue locally
                        # and let the role-level repair below supply any
                        # delayed relation reveal; never animate a fake state
                        # change or spend another whole-plan generation.
                        action["op"] = "highlight"
                        action["result"] = ""
                    # Some planners express exact grouping as a multi-source
                    # map: total units + units per group -> group count. When
                    # the declared counts close exactly, lower it to the
                    # renderer's structural partition operation. This is
                    # algebra on the Visual IR, not a topic-specific rule.
                    if (
                        action["op"] == "map"
                        and len(action["targets"]) >= 2
                        and action["result"] in repeat_counts
                    ):
                        counted_targets = [
                            target for target in action["targets"] if target in repeat_counts
                        ]
                        if len(counted_targets) >= 2:
                            source = max(counted_targets, key=repeat_counts.get)
                            divisor = min(counted_targets, key=repeat_counts.get)
                            source_count = repeat_counts[source]
                            divisor_count = repeat_counts[divisor]
                            result_count = repeat_counts[action["result"]]
                            if divisor_count > 0 and source_count / divisor_count == result_count:
                                action["op"] = "partition"
                                action["targets"] = [source]
                    if (
                        action["op"] in {"transform", "partition", "map"}
                        and len(action["targets"]) == len(result_values)
                        and len(result_values) > 1
                    ):
                        normalized_actions.extend(
                            {
                                **action,
                                "targets": [target],
                                "result": result,
                            }
                            for target, result in zip(action["targets"], result_values)
                        )
                    else:
                        normalized_actions.append(action)
                actions = normalized_actions
            scene["actions"] = actions if isinstance(actions, list) else []

            # ``highlight`` and ``verify`` can describe the same visible act:
            # focus the student's attention on already-grounded evidence and
            # use it to check the conclusion.  The scene role supplies the
            # missing intent, so lower one final highlight to ``verify`` when
            # the planner otherwise produced no verification operation.  This
            # is a Visual-IR repair, independent of the mathematical topic.
            if scene["role"] == "verify" and not any(
                isinstance(action, dict) and action.get("op") in _VERIFY_VISUAL_ACTIONS
                for action in scene["actions"]
            ):
                highlight = next(
                    (
                        action
                        for action in reversed(scene["actions"])
                        if isinstance(action, dict)
                        and action.get("op") == "highlight"
                        and action.get("targets")
                    ),
                    None,
                )
                if highlight is not None:
                    highlight["op"] = "verify"
            if scene["role"] == "verify":
                evidence_targets = [
                    str(target)
                    for action in scene["actions"]
                    if isinstance(action, dict) and action.get("op") in {"measure", "compare"}
                    for target in action.get("targets") or []
                ]
                final_verify = next(
                    (
                        action
                        for action in reversed(scene["actions"])
                        if isinstance(action, dict) and action.get("op") == "verify"
                    ),
                    None,
                )
                if final_verify is not None:
                    final_verify["targets"] = list(
                        dict.fromkeys([*(final_verify.get("targets") or []), *evidence_targets])
                    )

        # Local planners sometimes put the only new relationship graphic in
        # the verify beat, after a transform beat made solely of self-
        # transforms/highlights. Promote that already-declared relationship
        # into the transform beat. This repairs temporal ordering only: no
        # mathematical object, value, or problem type is invented.
        primitive_by_id = {
            str(item.get("id")): str(item.get("primitive") or "")
            for item in visual_objects
            if isinstance(item, dict) and item.get("id")
        }
        verify_scenes = [
            scene for scene in scenes if isinstance(scene, dict) and scene.get("role") == "verify"
        ]
        for scene in scenes:
            if not isinstance(scene, dict) or scene.get("role") != "transform":
                continue
            actions = scene.get("actions") or []
            if any(
                isinstance(action, dict) and action.get("op") in _MUTATING_VISUAL_ACTIONS
                for action in actions
            ):
                continue
            promoted: list[dict[str, Any]] = []
            for verify_scene in verify_scenes:
                remaining: list[dict[str, Any]] = []
                for action in verify_scene.get("actions") or []:
                    targets = action.get("targets") or [] if isinstance(action, dict) else []
                    is_relationship_create = (
                        isinstance(action, dict)
                        and action.get("op") == "create"
                        and any(
                            primitive_by_id.get(str(target)) in {"line", "arrow", "function_curve"}
                            for target in targets
                        )
                    )
                    if is_relationship_create:
                        promoted.append(action)
                    else:
                        remaining.append(action)
                verify_scene["actions"] = remaining
            if promoted:
                first_focus = next(
                    (
                        index
                        for index, action in enumerate(actions)
                        if isinstance(action, dict)
                        and action.get("op") in {"highlight", "measure", "compare"}
                    ),
                    len(actions),
                )
                scene["actions"] = [
                    *actions[:first_focus],
                    *promoted,
                    *actions[first_focus:],
                ]

        # Some models correctly introduce successor graphics in a transform
        # beat but encode them as independent ``create`` actions.  Recover an
        # explicit causal transition only when source and successor identities
        # share a stable semantic token (for example ``curve_sin`` ->
        # ``tangent_sin`` or ``state_before`` -> ``state_after``). This is a
        # generic Visual-IR identity repair and does not classify the problem.
        visible_before_scene: set[str] = set()
        ignored_identity_tokens = {
            "curve",
            "line",
            "dot",
            "bar",
            "grid",
            "node",
            "shape",
            "before",
            "after",
            "old",
            "new",
            "source",
            "result",
        }

        def identity_tokens(object_id: str) -> set[str]:
            return {
                token
                for token in re.split(r"[^a-z0-9]+", object_id.lower())
                if token and token not in ignored_identity_tokens
            }

        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            actions = scene.get("actions") or []
            has_mutation = any(
                isinstance(action, dict) and action.get("op") in _MUTATING_VISUAL_ACTIONS
                for action in actions
            )
            if scene.get("role") == "transform" and not has_mutation:
                available_sources = set(visible_before_scene)
                for action in actions:
                    if not isinstance(action, dict) or action.get("op") != "create":
                        continue
                    targets = list(action.get("targets") or [])
                    if len(targets) != 1:
                        continue
                    result_id = str(targets[0])
                    result_tokens = identity_tokens(result_id)
                    ranked_sources = sorted(
                        (
                            (
                                len(identity_tokens(source_id) & result_tokens),
                                source_id,
                            )
                            for source_id in available_sources
                        ),
                        reverse=True,
                    )
                    if not ranked_sources or ranked_sources[0][0] <= 0:
                        continue
                    source_id = ranked_sources[0][1]
                    action["op"] = "transform"
                    action["targets"] = [source_id]
                    action["result"] = result_id
                    available_sources.discard(source_id)
            for action in actions:
                if not isinstance(action, dict):
                    continue
                op = str(action.get("op") or "")
                targets = list(action.get("targets") or [])
                if op == "create":
                    visible_before_scene.update(targets)
                elif op in {"transform", "partition", "map"} and action.get("result"):
                    visible_before_scene.difference_update(targets)
                    visible_before_scene.add(str(action["result"]))
                elif op == "remove":
                    visible_before_scene.difference_update(targets)

        # Preserve actions that reference an undeclared successor.  The
        # validator reports the referential defect, while the semantic action
        # remains useful to a Manim code generator (for example a continuously
        # shrinking geometric state).  Earlier code deleted these actions and
        # silently converted a rich plan into a static slideshow.

        # Track object identity across successor-producing actions. Local
        # planners often keep referring to a semantic source name after it
        # has been partitioned or transformed. Resolve that stale name to the
        # current visible successor so the next action cannot become a no-op.
        lineage: dict[str, str] = {}

        def current_id(object_id: str) -> str:
            seen: set[str] = set()
            while object_id in lineage and object_id not in seen:
                seen.add(object_id)
                object_id = lineage[object_id]
            return object_id

        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            for action in scene.get("actions") or []:
                if not isinstance(action, dict):
                    continue
                original_targets = list(action.get("targets") or [])
                resolved_targets = [current_id(target) for target in original_targets]
                action["targets"] = resolved_targets
                result = str(action.get("result") or "")
                if action.get("op") in {"transform", "partition", "map"} and result:
                    for original, resolved in zip(original_targets, resolved_targets):
                        lineage[original] = result
                        lineage[resolved] = result

        # Repair a bounded, unambiguous omission: a structurally mutating
        # action may reference a declared source before its create action.
        # Materialize that source immediately before the mutation. Results
        # and relationships are never inferred here, so this cannot turn a
        # listing-only plan into a causal one.
        object_meanings = {
            str(item.get("id")): str(item.get("meaning") or item.get("label") or "数学对象")
            for item in visual_objects
            if isinstance(item, dict) and item.get("id")
        }
        visible_ids: set[str] = set()
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            completed_actions: list[dict[str, Any]] = []
            for action in scene.get("actions") or []:
                if not isinstance(action, dict):
                    continue
                op = str(action.get("op") or "")
                targets = list(action.get("targets") or [])
                should_materialize = op in {"transform", "partition", "map"} or (
                    scene.get("role") == "verify" and op in _VERIFY_VISUAL_ACTIONS
                )
                if should_materialize:
                    missing = [
                        target
                        for target in targets
                        if target in object_meanings and target not in visible_ids
                    ]
                    if missing:
                        completed_actions.append(
                            {
                                "op": "create",
                                "targets": missing,
                                "result": "",
                                "meaning": "建立后续动作需要的可见对象："
                                + "、".join(object_meanings[target] for target in missing),
                            }
                        )
                        visible_ids.update(missing)
                completed_actions.append(action)
                if op == "create":
                    visible_ids.update(targets)
                elif op in {"transform", "partition", "map"} and action.get("result"):
                    for target in targets:
                        visible_ids.discard(target)
                    visible_ids.add(str(action["result"]))
                elif op == "remove":
                    for target in targets:
                        visible_ids.discard(target)
            scene["actions"] = completed_actions

        # Partition and map need addressable members. An aggregate bar can
        # compare totals but cannot show which units were grouped or mapped.
        # For bounded counts, lower such bars to a generic unit grid; large
        # totals remain compressed bars and must use aggregate operations.
        addressable_ids: set[str] = set()
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            for action in scene.get("actions") or []:
                if not isinstance(action, dict) or action.get("op") not in {"partition", "map"}:
                    continue
                addressable_ids.update(str(item) for item in action.get("targets") or [])
                if action.get("result"):
                    addressable_ids.add(str(action["result"]))
        for item in visual_objects:
            if not isinstance(item, dict) or item.get("id") not in addressable_ids:
                continue
            params = item.get("params") or {}
            try:
                count = int(round(float(params.get("count") or 0)))
            except (TypeError, ValueError):
                count = 0
            if count <= 1:
                try:
                    count = int(round(float(params.get("value", params.get("total_units")))))
                except (TypeError, ValueError):
                    count = 0
            if 1 < count <= 64:
                params["count"] = count
                if item.get("primitive") == "quantity_bar":
                    item["primitive"] = "unit_grid"
                    params.setdefault("columns", min(8, max(2, int(count**0.5 + 0.999))))
                item["params"] = params

    forbidden = plan.get("forbidden") or []
    if isinstance(forbidden, str):
        forbidden = [x.strip() for x in forbidden.splitlines() if x.strip()]
    plan["forbidden"] = [
        _strip_decorations(x) for x in forbidden if isinstance(x, str) and x.strip()
    ]
    return plan


def _md_to_plan(section: str) -> dict[str, Any]:
    thesis = md.get_field(
        section,
        "visual_thesis",
        "visual thesis",
        "视觉论点",
        "视觉主线",
        "primary_pattern",
        "primary pattern",
        "主模式",
    )
    rationale = md.get_field(section, "essence_rationale", "本质", "rationale", "为什么", "原理")
    ledger_raw = md.get_field(section, "symbol_ledger", "symbol ledger", "符号账本")

    scenes: list[dict[str, str]] = []
    for heading, body in md.find_subsections(section, level=3):
        if "场景" not in heading and not heading.lower().startswith("scene"):
            continue
        values = {k.lower(): v for k, v in md.get_kv_dict(body).items()}
        scenes.append(
            {
                "role": (values.get("role") or "").strip().lower(),
                "anchor_zone": (values.get("anchor_zone") or values.get("zone") or "").strip(),
                "key_objects": values.get("key_objects") or values.get("objects") or "",
                "action": values.get("action") or "",
                "invariant": values.get("invariant") or "",
                "attention_target": values.get("attention_target") or "",
                "exit_condition": values.get("exit_condition") or "",
                "teaching_line": values.get("teaching_line") or "",
                "duration_s": values.get("duration_s") or "",
            }
        )

    forbidden_section = md.find_section(section, "反模式禁用清单") or md.find_section(
        section, "forbidden"
    )
    return {
        "visual_thesis": thesis.strip(),
        "essence_rationale": rationale.strip(),
        "symbol_ledger": ledger_raw,
        "scenes": scenes,
        "forbidden": md.get_bullets(forbidden_section),
    }


def _parse_plan(done: Any) -> dict[str, Any] | None:
    for source in (getattr(done, "text", "") or "", getattr(done, "reasoning", "") or ""):
        if not source:
            continue
        payload = md.parse_json_anywhere(source)
        if isinstance(payload, dict):
            normalized = _normalize_plan(payload)
            if normalized.get("visual_thesis") and normalized.get("scenes"):
                return normalized
        for alias in _SECTION_ALIASES:
            section = md.find_section(source, alias, level=2) or md.find_section(source, alias)
            if section is None:
                continue
            normalized = _normalize_plan(_md_to_plan(section))
            if normalized.get("visual_thesis") and normalized.get("scenes"):
                return normalized
    return None


def _validate_essence_rationale(text: str) -> list[str]:
    value = (text or "").strip()
    errors: list[str] = []
    if len(value) < 20:
        errors.append("essence_rationale 至少 20 字，需解释画面为何能证明或解释结论")
    if len(value) > 400:
        errors.append("essence_rationale 超过 400 字，请聚焦一个核心数学关系")
    # The rationale must explain WHY the answer holds — an invariant, a
    # conservation, a correspondence — not merely describe the animation.
    # The signal list is reasoning vocabulary, not problem-type vocabulary.
    if value and not any(word in value for word in _WHY_SIGNAL_WORDS):
        errors.append(
            "essence_rationale 未指出决定性数学关系（守恒/不变量/对应/因为…所以）；"
            "它必须回答“学生看什么就能明白答案为什么成立”，不能只描述动画内容"
        )
    return errors


def _verified_arithmetic_candidate(ctx: ToolContext) -> dict[str, Any] | None:
    """Build Visual IR from literal equalities in independently verified steps."""
    if _quantity_semantics_refused(ctx):
        # Arithmetic appears inside almost every worked solution, including
        # solutions about a function's graph. Counting graphics would then
        # narrate "how many" about a question that asks "where did the curve
        # go", which is how a graph-transformation session ended up showing two
        # empty rectangles labelled "product". Abstaining hands the session to
        # the constructors and gates that can tell the truth about it.
        return None
    answer_text = _strip_decorations(str(ctx.state.get("solution_answer") or ""))
    answer_numbers = [float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", answer_text)]
    if not answer_numbers:
        return None
    answer_value = answer_numbers[-1]
    equations: list[tuple[float, str, float, float, str]] = []
    step_records: list[tuple[str, float, str]] = []
    for step in ctx.state.get("solution_steps") or []:
        if not isinstance(step, dict):
            continue
        operation_text = str(step.get("operation") or "")
        result_text = str(step.get("result") or "")
        text = " ".join((operation_text, result_text, str(step.get("description") or "")))
        for left, operator, right, output in _AUDIT_EQUALITY_RE.findall(text):
            a, b, c = float(left), float(right), float(output)
            if operator == "+":
                actual = a + b
            elif operator == "-":
                actual = a - b
            elif operator in {"×", "x", "X", "*"}:
                actual = a * b
            elif b != 0:
                actual = a / b
            else:
                continue
            if abs(actual - c) <= 1e-8:
                equations.append((a, operator, b, c, text[:100]))
        # Algebraic steps commonly write the equivalent operation as
        # ``2x + 5 - 5 = 13 - 5`` and put ``2x = 8`` in the result field.
        # Recover the literal arithmetic side only when its computed value is
        # explicitly present in that independently verified step result. This
        # is expression-level grounding and does not classify the problem.
        result_numbers = [float(item) for item in _AUDIT_NUMBER_RE.findall(result_text)]
        if result_numbers:
            step_records.append((operation_text, result_numbers[-1], text[:100]))
        normalized_operation = re.sub(
            r"\\(?:d?frac)\s*\{\s*([-+]?\d+(?:\.\d+)?)\s*\}"
            r"\s*\{\s*([-+]?\d+(?:\.\d+)?)\s*\}",
            r"\1/\2",
            operation_text,
        )
        normalized_operation = (
            normalized_operation.replace(r"\times", "*")
            .replace(r"\div", "/")
            .replace(r"\cdot", "*")
            .replace("−", "-")
        )
        for left, operator, right in _AUDIT_OPERATION_RE.findall(normalized_operation):
            a, b = float(left), float(right)
            if operator == "+":
                actual = a + b
            elif operator == "-":
                actual = a - b
            elif operator in {"×", "x", "X", "*"}:
                actual = a * b
            elif b != 0:
                actual = a / b
            else:
                continue
            if not any(abs(actual - item) <= 1e-8 for item in result_numbers):
                continue
            equation = (a, operator, b, actual, text[:100])
            if equation not in equations:
                equations.append(equation)
    answer_index = next(
        (
            index
            for index in range(len(equations) - 1, -1, -1)
            if abs(equations[index][3] - answer_value) <= 1e-8
        ),
        None,
    )
    if answer_index is None:
        # Some valid solutions express the operation verbally (for example,
        # "both sides subtract 5") and expose only the resulting state. Build
        # the chain by accepting an arithmetic edge iff it closes exactly on
        # that verified result. This searches finite arithmetic semantics, not
        # a catalogue of question forms.
        problem_numbers = [
            float(item) for item in re.findall(r"[-+]?\d+(?:\.\d+)?", ctx.problem or "")
        ]
        known_values = list(dict.fromkeys(problem_numbers))
        recovered: list[tuple[float, str, float, float, str]] = []
        previous_output: float | None = None
        for operation_text, output, evidence in step_records:
            normalized = operation_text.replace("−", "-")
            hints: list[str] = []
            for marker, operator in (
                (("减", "-"), "-"),
                (("除", "÷", "/", r"\frac"), "/"),
                (("加", "+"), "+"),
                (("乘", "×", "*", r"\times", r"\cdot"), "*"),
            ):
                if any(item in normalized for item in marker):
                    hints.append(operator)
            if not hints:
                hints = ["-", "/", "+", "*"]
            operation_numbers = [
                float(item) for item in re.findall(r"[-+]?\d+(?:\.\d+)?", normalized)
            ]
            candidates = list(dict.fromkeys([*operation_numbers, *known_values]))
            sources = [previous_output] if previous_output is not None else candidates
            recovered_edge: tuple[float, str, float, float, str] | None = None
            for operator in hints:
                for source in sources:
                    for operand in candidates:
                        if operator == "-":
                            actual = source - operand
                        elif operator == "/" and operand != 0:
                            actual = source / operand
                        elif operator == "+":
                            actual = source + operand
                        elif operator == "*":
                            actual = source * operand
                        else:
                            continue
                        if source != output and abs(actual - output) <= 1e-8:
                            recovered_edge = (
                                source,
                                operator,
                                operand,
                                output,
                                evidence,
                            )
                            break
                    if recovered_edge is not None:
                        break
                if recovered_edge is not None:
                    break
            if recovered_edge is None:
                recovered = []
                break
            recovered.append(recovered_edge)
            known_values.append(output)
            previous_output = output
        if recovered and abs(recovered[-1][3] - answer_value) <= 1e-8:
            equations = recovered
            answer_index = len(equations) - 1
    if answer_index is None:
        return None
    equations = equations[: answer_index + 1]

    def number_label(value: float) -> str:
        return f"{value:g}"

    def small_natural(value: float) -> int | None:
        if abs(value - round(value)) <= 1e-8 and 1 <= round(value) <= 24:
            return int(round(value))
        return None

    # value → object id currently holding that quantity on screen. Quantity
    # verbs mutate a group in place (5-grid minus 2 units IS the 3), so an
    # output value aliases to the mutated object instead of a fresh object.
    alias: dict[float, str] = {}
    objects: list[dict[str, Any]] = []
    setup_ids: list[str] = []
    actions: list[dict[str, Any]] = []
    recount_groups: list[str] = []
    recount_total: int | None = None
    object_sequence = 0
    box_sequence = 0

    def ensure_value_object(value: float, *, in_setup: bool) -> str:
        nonlocal object_sequence
        if value in alias:
            return alias[value]
        count = small_natural(value)
        params: dict[str, Any] = {"value": value}
        primitive = "quantity_bar"
        if count is not None and count > 1:
            primitive = "unit_grid"
            params.update(
                {"count": count, "columns": min(8, max(2, int(count**0.5 + 0.999)))}
            )
        object_id = f"verified_value_{object_sequence}"
        object_sequence += 1
        objects.append(
            {
                "id": object_id,
                "primitive": primitive,
                "meaning": f"已验证运算链中的数量 {number_label(value)}",
                "label": number_label(value),
                "color": "green" if value == answer_value else "blue",
                "params": params,
            }
        )
        alias[value] = object_id
        if in_setup:
            setup_ids.append(object_id)
        return object_id

    def make_box(label: str, color: str) -> str:
        nonlocal box_sequence
        object_id = f"quantity_box_{box_sequence}"
        box_sequence += 1
        objects.append(
            {
                "id": object_id,
                "primitive": "rectangle",
                "meaning": f"承接单位迁移的容器：{label}",
                "label": label,
                "color": color,
                "params": {},
            }
        )
        return object_id

    for left, operator, right, output, step_text in equations:
        left_count = small_natural(left)
        right_count = small_natural(right)
        output_count = small_natural(output) if output > 0 else None
        meaning = step_text or (
            f"{number_label(left)} {operator} {number_label(right)}"
            f" = {number_label(output)}"
        )
        if operator == "-" and left_count and right_count and left_count - right_count >= 0:
            # Take-away subtraction disappears in place: the same units dim
            # and get crossed inside the whole, so the total stays readable
            # as "remaining + crossed" while the count shrinks.
            source_id = ensure_value_object(left, in_setup=True)
            box_id = make_box("划去", "gray")
            actions.append(
                {
                    "op": "take_from",
                    "targets": [source_id],
                    "result": "",
                    "source": source_id,
                    "destination": box_id,
                    "count": right_count,
                    "style": "cross_out",
                    "meaning": meaning,
                }
            )
            actions.append(
                {
                    "op": "count",
                    "targets": [source_id],
                    "result": "",
                    "expect": left_count - right_count,
                    "meaning": f"逐个数出剩余 {number_label(output)}",
                }
            )
            alias[output] = source_id
            recount_groups = [source_id, box_id]
            recount_total = left_count
        elif operator == "+" and left_count and right_count:
            source_id = ensure_value_object(left, in_setup=True)
            operand_id = ensure_value_object(right, in_setup=True)
            sum_box_id = make_box("合并", "green")
            actions.append(
                {
                    "op": "create",
                    "targets": [sum_box_id],
                    "result": "",
                    "meaning": "建立承接合并单位的容器",
                }
            )
            actions.append(
                {
                    "op": "combine",
                    "targets": [source_id, operand_id],
                    "result": sum_box_id,
                    "meaning": meaning,
                }
            )
            actions.append(
                {
                    "op": "count",
                    "targets": [sum_box_id],
                    "result": "",
                    "expect": left_count + right_count,
                    "meaning": f"逐个数出合计 {number_label(output)}",
                }
            )
            alias[output] = sum_box_id
            recount_groups = [sum_box_id]
            recount_total = left_count + right_count
        elif (
            operator in {"×", "x", "X", "*"}
            and left_count
            and right_count
            and left_count * right_count <= 64
        ):
            # Multiplication as visible stamping: one row of `right` units is
            # replicated `left` times; every new row is born on screen.
            row_id = ensure_value_object(right, in_setup=True)
            product_box_id = make_box("乘积", "green")
            total = left_count * right_count
            actions.append(
                {
                    "op": "create",
                    "targets": [product_box_id],
                    "result": "",
                    "meaning": "建立承接乘积行列的容器",
                }
            )
            actions.append(
                {
                    "op": "replicate",
                    "targets": [row_id],
                    "result": product_box_id,
                    "source": row_id,
                    "count": left_count,
                    "meaning": meaning,
                }
            )
            if total <= 12:
                actions.append(
                    {
                        "op": "count",
                        "targets": [product_box_id],
                        "result": "",
                        "expect": total,
                        "meaning": f"逐个数出乘积 {number_label(output)}",
                    }
                )
                recount_groups = [product_box_id]
                recount_total = total
            else:
                recount_groups = []
                recount_total = None
            alias[output] = product_box_id
        else:
            # Non-countable steps and division keep the legacy grid
            # regrouping, which preserves a visible row/group structure.
            source_id = ensure_value_object(left, in_setup=True)
            ensure_value_object(right, in_setup=True)
            result_id = ensure_value_object(output, in_setup=False)
            action_op = "partition" if operator in {"÷", "/"} else "transform"
            actions.append(
                {
                    "op": action_op,
                    "targets": [source_id],
                    "result": result_id,
                    "meaning": meaning,
                }
            )
            alias[output] = result_id
            recount_groups = []
            recount_total = None

    final_id = alias[answer_value]
    return {
        "grounding_source": "verified_solution_arithmetic",
        "visual_thesis": "让已验证运算链中的每个数量状态连续变化并最终落到答案",
        "essence_rationale": (
            "每次图形变化都对应已独立验证的一个等式，学生可以从初始数量、"
            "中间数量和最终数量的连续变化直接核对答案。"
        ),
        "symbol_ledger": [
            "蓝色单位 = 当前已知或中间数量",
            "绿色单位 = 已验证的最终答案数量",
        ],
        "visual_objects": objects,
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(setup_ids),
                "action": "建立已验证运算链的初始数量和操作量。",
                "invariant": "所有数量来自已验证解答",
                "attention_target": "初始数量及操作量",
                "exit_condition": "初始关系清楚可见",
                "teaching_line": "先把已知数量放到同一个画面中。",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "create",
                        "targets": setup_ids,
                        "result": "",
                        "meaning": "建立已验证运算链的初始数量",
                    }
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(item["id"] for item in objects),
                "action": "逐步执行已验证等式对应的图形变化。",
                "invariant": "单位总量守恒：迁移只改变分组，不改变单位个数",
                "attention_target": "数量在每一步如何改变",
                "exit_condition": "最终答案数量由连续变化得到",
                "teaching_line": "依次执行相同的运算，观察数量怎样到达答案。",
                "duration_s": max(6, min(16, 4 * len(equations))),
                "actions": actions,
            },
            {
                "role": "verify",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(recount_groups) if recount_groups else final_id,
                "action": "分组重新计数并核对答案。",
                "invariant": "最终数量满足已验证答案",
                "attention_target": "各组计数与合计算式",
                "exit_condition": "答案对象清楚可见并可计数",
                "teaching_line": f"最后核对：{answer_text}",
                "duration_s": 4,
                "actions": [
                    (
                        {
                            "op": "recount_verify",
                            "targets": recount_groups,
                            "result": "",
                            "expect_total": recount_total,
                            "meaning": "把各组重新数一遍，合计必须回到原总量",
                        }
                        if recount_groups and recount_total is not None
                        else {
                            "op": "verify",
                            "targets": [final_id],
                            "result": "",
                            "meaning": "核对已验证答案",
                        }
                    )
                ],
            },
        ],
        "forbidden": ["只显示文字等式", "跳过中间数量状态"],
    }


def _math_evidence_numbers(ctx: ToolContext) -> set[float]:
    """All numeric literals appearing in executed Math IR requests/results."""
    numbers: set[float] = set()
    for key in ("solve_math_request", "verify_math_request"):
        request = ctx.state.get(key)
        if not isinstance(request, dict):
            continue
        for operation in request.get("operations") or []:
            if not isinstance(operation, dict):
                continue
            for match in re.findall(
                r"-?\d+(?:\.\d+)?", str(operation.get("expression") or "")
            ):
                numbers.add(float(match))
            substitutions = operation.get("substitutions")
            if isinstance(substitutions, dict):
                for value in substitutions.values():
                    try:
                        numbers.add(float(value))
                    except (TypeError, ValueError):
                        continue
    for key in ("solve_math_evidence", "verify_math_evidence"):
        evidence = ctx.state.get(key)
        if not isinstance(evidence, dict):
            continue
        for operation in evidence.get("operations") or []:
            if isinstance(operation, dict):
                for match in re.findall(
                    r"-?\d+(?:\.\d+)?", str(operation.get("result") or "")
                ):
                    numbers.add(float(match))
    return numbers


_QUANTITY_STORY_RELATIONS = {"take_away", "add_to", "compare_more", "compare_fewer"}


def build_quantity_story_visual_plan(
    ctx: ToolContext, *, variant: str = "primary"
) -> dict[str, Any] | None:
    """Deterministically lower a verified small-natural quantity story.

    Activation is an observable structure predicate, not a problem-type
    label: a story extracted at solve time whose relation is in the closed
    relation set, whose values are small naturals reproduced exactly by the
    executed Math IR, and whose result covers the verified answer.  Anything
    else abstains and the open-world director takes over.
    """
    story = ctx.state.get("quantity_story")
    if not isinstance(story, dict):
        return None
    relation = str(story.get("relation") or "").strip().lower()
    if relation not in _QUANTITY_STORY_RELATIONS:
        return None
    entity = str(story.get("entity") or "").strip() or "单位"
    try:
        first = int(story.get("first"))
        second = int(story.get("second"))
        result = int(story.get("result"))
    except (TypeError, ValueError):
        return None
    if relation == "take_away":
        consistent = first - second == result and second >= 1 and result >= 0
    elif relation == "add_to":
        consistent = first + second == result and first >= 1 and second >= 1
    elif relation == "compare_more":
        consistent = first - second == result and result >= 1
    else:  # compare_fewer
        consistent = second - first == result and result >= 1
    if not consistent:
        return None
    if any(value < 0 or value > 24 for value in (first, second, result)):
        return None

    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if (
        not isinstance(evidence, dict)
        or not evidence.get("success")
        or evidence.get("all_claims_passed") is not True
    ):
        return None
    reproduced = _math_evidence_numbers(ctx)
    if not {float(first), float(second), float(result)}.issubset(reproduced):
        return None
    answer_numbers = [
        float(item)
        for item in re.findall(
            r"-?\d+(?:\.\d+)?", str(ctx.state.get("solution_answer") or "")
        )
    ]
    if float(result) not in answer_numbers:
        return None

    def columns_for(count: int) -> int:
        return min(8, max(2, int(count**0.5 + 0.999)))

    # Default representation for take-away: units disappear IN PLACE (dimmed
    # and crossed inside the whole), so 5 stays visible as "3 remaining + 2
    # crossed". The repair variant switches to physical migration.
    style = "fly" if variant == "repair" else "cross_out"
    pace = 1.35 if variant == "repair" else 1.0

    def duration(base: float) -> float:
        return max(2.0, min(20.0, round(base * pace, 1)))

    def unit_grid(object_id: str, count: int, meaning: str, label: str, color: str):
        return {
            "id": object_id,
            "primitive": "unit_grid",
            "meaning": meaning,
            "label": label,
            "color": color,
            "params": {"count": count, "columns": columns_for(count)},
        }

    def box(object_id: str, meaning: str, label: str, color: str):
        return {
            "id": object_id,
            "primitive": "rectangle",
            "meaning": meaning,
            "label": label,
            "color": color,
            "params": {},
        }

    def action(op: str, targets: list[str], **fields: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"op": op, "targets": targets, "result": ""}
        payload.update(fields)
        payload.setdefault("meaning", op)
        return payload

    if relation == "take_away":
        objects = [
            unit_grid("story_total", first, f"最初的 {entity}", entity, "blue"),
            box("story_removed", f"被拿走的 {entity} 的容器", "拿走", "gray"),
        ]
        scenes = [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "story_total",
                "action": f"摆出全部 {entity} 并逐个数一遍",
                "invariant": "无，当前建立初始状态",
                "attention_target": f"{entity} 的总数",
                "exit_condition": "总数已被逐个数出",
                "teaching_line": f"先把 {entity} 一个一个数清楚。",
                "duration_s": duration(5),
                "actions": [
                    action("create", ["story_total"], meaning=f"建立全部 {entity}"),
                    action("count", ["story_total"], expect=first, meaning="逐个数出总数"),
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "story_total, story_removed",
                "action": f"在总数里逐个划去 {second} 个{entity}，整体保持可见",
                "invariant": "单位总数守恒：划掉的与剩下的合计不变",
                "attention_target": "逐个消失的单位与完好的剩余部分",
                "exit_condition": "划掉部分被圈出标注，剩余部分完好",
                "teaching_line": f"在 {first} 个的基础上消失 {second} 个，剩下的就是答案。",
                "duration_s": duration(8),
                "actions": [
                    action(
                        "take_from",
                        ["story_total"],
                        source="story_total",
                        destination="story_removed",
                        count=second,
                        style=style,
                        meaning=f"在原地逐个划去 {second} 个{entity}",
                    ),
                    action(
                        "count",
                        ["story_total"],
                        expect=result,
                        meaning="逐个数出剩余数量",
                    ),
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "story_total, story_removed",
                "action": "分组重新计数，剩下的加上拿走的必须回到总数",
                "invariant": "剩余数 + 拿走数 = 总数",
                "attention_target": "两组的计数与合计算式",
                "exit_condition": "合计算式与总数一致",
                "teaching_line": "剩下的加上拿走的，应当还是原来的总数。",
                "duration_s": duration(5),
                "actions": [
                    action(
                        "recount_verify",
                        ["story_total", "story_removed"],
                        expect_total=first,
                        meaning="重新数两组并合计核对",
                    ),
                ],
            },
        ]
        thesis = f"在 {first} 个{entity}的整体中逐个划去 {second} 个，剩余数量由重新计数得到"
        rationale = (
            f"因为学生看到 {second} 个{entity}在原地逐个消失（变灰划掉），"
            "整体仍然保持为剩下的加上划掉的，重新计数就回到总数，减法的意义直接来自画面。"
        )
        ledger = [f"蓝色单位 = 剩下的{entity}", "灰色划掉部分 = 消失的部分"]
    elif relation == "add_to":
        objects = [
            unit_grid("story_first", first, f"第一组 {entity}", entity, "blue"),
            unit_grid("story_second", second, f"第二组 {entity}", entity, "yellow"),
            box("story_sum", f"合并后的 {entity} 的容器", "合并", "green"),
        ]
        scenes = [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "story_first, story_second",
                "action": "分别摆出两组并逐个数一遍",
                "invariant": "无，当前建立初始状态",
                "attention_target": "两组各自的数量",
                "exit_condition": "两组数量都被数出",
                "teaching_line": "先分别数清每一组。",
                "duration_s": duration(5),
                "actions": [
                    action(
                        "create",
                        ["story_first", "story_second"],
                        meaning="建立两组已知数量",
                    ),
                    action("count", ["story_first"], expect=first, meaning="数出第一组"),
                    action("count", ["story_second"], expect=second, meaning="数出第二组"),
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "story_first, story_second, story_sum",
                "action": "两组单位逐个滑入同一容器合并",
                "invariant": "单位总数守恒：合并只改变分组",
                "attention_target": "单位逐个进入容器的过程",
                "exit_condition": "全部单位进入容器",
                "teaching_line": "把两组合到一起，每个单位都还在。",
                "duration_s": duration(7),
                "actions": [
                    action("create", ["story_sum"], meaning="建立合并容器"),
                    action(
                        "combine",
                        ["story_first", "story_second"],
                        result="story_sum",
                        meaning="两组单位滑入同一容器",
                    ),
                    action("count", ["story_sum"], expect=result, meaning="逐个数出合计"),
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "story_sum",
                "action": "重新计数合并后的全部单位",
                "invariant": "合计等于两组之和",
                "attention_target": "合并容器的计数",
                "exit_condition": "合计算式成立",
                "teaching_line": "再数一遍，合计没有多也没有少。",
                "duration_s": duration(5),
                "actions": [
                    action(
                        "recount_verify",
                        ["story_sum"],
                        expect_total=result,
                        meaning="重新数合并结果核对",
                    ),
                ],
            },
        ]
        thesis = f"两组{entity}逐个进入同一容器，总数由重新计数得到"
        rationale = (
            "因为每个单位滑入容器的过程都可见，合并前后单位一个不多一个不少，"
            "学生看到加法就是把两组数量放到一起再数一遍。"
        )
        ledger = ["蓝色/黄色单位 = 两组来源", "绿色容器 = 合并后的总量"]
    else:
        bigger, smaller = (first, second) if first >= second else (second, first)
        objects = [
            unit_grid("story_bigger", bigger, f"较多的一组 {entity}", entity, "blue"),
            unit_grid("story_smaller", smaller, f"较少的一组 {entity}", entity, "yellow"),
            box("story_difference", "相差部分的容器", "相差", "green"),
        ]
        scenes = [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "story_bigger, story_smaller",
                "action": "上下摆出两组并各自数一遍",
                "invariant": "无，当前建立初始状态",
                "attention_target": "两组的数量差异",
                "exit_condition": "两组数量都被数出",
                "teaching_line": "先分别数清两组各有多少。",
                "duration_s": duration(5),
                "actions": [
                    action(
                        "create",
                        ["story_bigger", "story_smaller"],
                        meaning="建立参与比较的两组",
                    ),
                    action("count", ["story_bigger"], expect=bigger, meaning="数出较多的一组"),
                    action("count", ["story_smaller"], expect=smaller, meaning="数出较少的一组"),
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "story_bigger, story_difference",
                "action": "把较多一组中超出的部分逐个移进相差区，剩下的与较少一组一样多",
                "invariant": "移出后较多组剩余数量等于较少组数量",
                "attention_target": "被移出的相差部分",
                "exit_condition": "两组对齐，相差部分单独可数",
                "teaching_line": "多出来的部分移出去，剩下的和另一组一样多。",
                "duration_s": duration(8),
                "actions": [
                    action(
                        "take_from",
                        ["story_bigger"],
                        source="story_bigger",
                        destination="story_difference",
                        count=result,
                        # Comparison keeps physical extraction: the surplus
                        # becomes its own countable group beside the pair.
                        style="fly" if variant != "repair" else "cross_out",
                        meaning="逐个移出超出较少组的部分",
                    ),
                    action(
                        "count",
                        ["story_bigger"],
                        expect=smaller,
                        meaning="剩余与较少组一样多",
                    ),
                    action(
                        "count",
                        ["story_difference"],
                        expect=result,
                        meaning="逐个数出相差数量",
                    ),
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "story_bigger, story_difference",
                "action": "剩余部分加上相差部分必须回到较多一组的总数",
                "invariant": "较少组数量 + 相差 = 较多组数量",
                "attention_target": "两组计数与合计算式",
                "exit_condition": "合计算式与较多组总数一致",
                "teaching_line": "少的加上相差的，应当等于多的。",
                "duration_s": duration(5),
                "actions": [
                    action(
                        "recount_verify",
                        ["story_bigger", "story_difference"],
                        expect_total=bigger,
                        meaning="重新数剩余与相差并合计核对",
                    ),
                ],
            },
        ]
        thesis = f"把较多一组中超出的 {result} 个{entity}移出后两组对齐，相差由计数得到"
        rationale = (
            "因为学生看到两组先各自数清，再把超出的部分逐个移出直到两组一样多，"
            "相差的意义就是画面里那几个被移出的单位。"
        )
        ledger = ["蓝色/黄色单位 = 参与比较的两组", "绿色容器 = 相差部分"]

    plan = {
        "plan_version": 2,
        "grounding_source": "quantity_story",
        "visual_thesis": thesis,
        "essence_rationale": rationale,
        "symbol_ledger": ledger,
        "visual_objects": objects,
        "scenes": scenes,
        "forbidden": ["只显示文字等式", "数量变化不经过单位迁移"],
    }
    errors = _validate_plan(plan, ctx.grade)
    if errors:
        logger.warning("quantity story plan failed validation: %s", errors[:3])
        return None
    return plan


def build_mix_swap_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Deterministic first-shot plan for verified linear-mix structures.

    Assumption-and-adjustment made visible: assume every unit is the first
    kind, count the total value, then swap units one by one — each swap
    visibly changes the running total by the per-unit difference until the
    verified total is reached. Activation is the Math IR coefficient shape
    ([[1,1],[a,b]]), never the problem wording.
    """
    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if (
        not isinstance(evidence, dict)
        or not evidence.get("success")
        or evidence.get("all_claims_passed") is not True
    ):
        return None
    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    mix = extract_linear_mix_structure(request)
    if mix is None:
        return None
    total_units = mix["total_units"]
    value_a, value_b = mix["value_a"], mix["value_b"]
    total_value = mix["total_value"]
    count_a, count_b = mix["count_a"], mix["count_b"]
    assumed_total = total_units * value_a
    delta = value_b - value_a
    direction = "增加" if delta > 0 else "减少"

    plan = {
        "plan_version": 2,
        "grounding_source": "linear_mix_swap",
        "visual_thesis": (
            f"先假设全部 {total_units} 个单位都是每单位 {value_a} 的一类，"
            f"再逐个替换成每单位 {value_b} 的一类，看总量如何一步步从 "
            f"{assumed_total} 变到 {total_value}"
        ),
        "essence_rationale": (
            f"每替换一个单位，总量就{direction} {abs(delta)}；从假设总量 {assumed_total} 到实际总量 "
            f"{total_value} 需要替换 {count_b} 个，这个差额收拢过程就是答案的来源，"
            "学生从画面上直接看到假设法为什么成立。"
        ),
        "symbol_ledger": [
            f"蓝色圆圈 = 假设的一类个体（每个垂下 {value_a} 根竖线）",
            f"绿色圆圈 = 替换后的一类个体（每个垂下 {value_b} 根竖线）",
            "黄色计数 = 当前可见竖线总数",
        ],
        "visual_objects": [
            {
                "id": "mix_units",
                # Circles read as individuals ("heads"); the per-unit line
                # marks hang below them as countable appendages ("legs").
                "primitive": "circle",
                "meaning": f"全部 {total_units} 个个体，先假设同为一类",
                "label": f"{total_units} 个",
                "color": "blue",
                "params": {
                    "count": total_units,
                    "columns": min(8, max(2, int(total_units**0.5 + 0.999))),
                },
            },
            {
                "id": "mix_marks",
                "primitive": "line",
                "meaning": f"每个个体垂下的 {value_a} 根计数竖线",
                "label": "",
                "color": "blue",
                "params": {"count_per_unit": value_a},
            },
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "mix_units, mix_marks",
                "action": f"摆出 {total_units} 个圆圈并给每个垂下 {value_a} 根竖线",
                "invariant": "无，当前建立假设状态",
                "attention_target": f"假设总量 {assumed_total}",
                "exit_condition": "假设状态与其总量清楚可见",
                "teaching_line": (
                    f"每个圆圈是一个个体，下面垂 {value_a} 根线；"
                    f"先假设全部相同：{total_units} × {value_a} = {assumed_total}。"
                ),
                "duration_s": 6,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["mix_units"],
                        "result": "",
                        "meaning": "建立全部单位的假设状态",
                    },
                    {
                        "op": "create",
                        "targets": ["mix_marks"],
                        "result": "",
                        "meaning": "给每个单位挂上假设的数值标记",
                    },
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "mix_units",
                "action": (
                    f"逐个把单位替换为另一类（标记 {value_a}→{value_b}），"
                    f"总量每次{direction} {abs(delta)}"
                ),
                "invariant": f"单位总数保持 {total_units} 不变，只有类别和总量变化",
                "attention_target": f"总量计数逐步逼近 {total_value}",
                "exit_condition": f"总量达到 {total_value}，替换停止",
                "teaching_line": (
                    f"实际总量是 {total_value}，差 {abs(total_value - assumed_total)}；"
                    f"每换一个补 {abs(delta)}，要换 {count_b} 个。"
                ),
                "duration_s": max(6.0, min(18.0, 4 + count_b * 0.5)),
                "actions": [
                    {
                        "op": "swap_units",
                        "targets": ["mix_units"],
                        "result": "",
                        "source": "mix_units",
                        "count": count_b,
                        "expect": value_b,
                        "expect_total": total_value,
                        "meaning": (
                            f"逐个替换 {count_b} 个单位，总量从 {assumed_total} "
                            f"收拢到 {total_value}"
                        ),
                    },
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "mix_units",
                "action": "分组框选两类单位并核对总数与总量",
                "invariant": (
                    f"{count_a} × {value_a} + {count_b} × {value_b} = {total_value}，"
                    f"且 {count_a} + {count_b} = {total_units}"
                ),
                "attention_target": "两组的数量与合计算式",
                "exit_condition": "两组数量与总量同时成立",
                "teaching_line": (
                    f"核对：{count_a} × {value_a} + {count_b} × {value_b} = {total_value}。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "verify",
                        "targets": ["mix_units"],
                        "result": "",
                        "meaning": "框选两类单位并核对合计",
                    },
                ],
            },
        ],
        "forbidden": ["直接写方程求解", "总量数字不经过逐步替换直接出现"],
    }
    errors = _validate_plan(plan, ctx.grade)
    if errors:
        logger.warning("linear mix swap plan failed validation: %s", errors[:3])
        return None
    return plan


def build_linear_balance_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Deterministic balance-scale plan for middle-school linear equations.

    Equality made physical: unknown boxes and unit dots sit on two pans;
    every operation applies to BOTH pans at once and the beam stays level.
    Detection is the one-variable linear IR shape; representation policy
    keeps this for the middle grade (high school owns the curve view).
    """
    if ctx.grade != "middle":
        return None
    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if (
        not isinstance(evidence, dict)
        or not evidence.get("success")
        or evidence.get("all_claims_passed") is not True
    ):
        return None
    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    balance = extract_linear_balance_structure(request)
    if balance is None:
        return None
    variable = balance["variable"]
    coefficient = balance["coefficient"]
    constant = balance["constant"]
    total = balance["total"]
    solution = balance["solution"]
    remainder = total - constant

    def action(op: str, **fields: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"op": op, "targets": ["equation_balance"], "result": ""}
        payload.update(fields)
        payload.setdefault("meaning", op)
        return payload

    transform_actions: list[dict[str, Any]] = []
    if constant >= 1:
        transform_actions.append(
            action(
                "balance_remove",
                count=constant,
                meaning=(
                    f"两盘同时拿走 {constant} 个单位，天平保持平衡："
                    f"{coefficient}{variable} = {remainder}"
                ),
            )
        )
    if coefficient >= 2:
        transform_actions.append(
            action(
                "balance_divide",
                count=coefficient,
                meaning=(
                    f"把两盘同时分成 {coefficient} 份，每个 {variable} 方块对应一份："
                    f"{variable} = {remainder} ÷ {coefficient} = {solution}"
                ),
            )
        )
    if not transform_actions:
        return None

    plan = {
        "plan_version": 2,
        "grounding_source": "linear_balance",
        "visual_thesis": (
            f"把 {coefficient}{variable} + {constant} = {total} 放上天平，"
            "对两盘做完全相同的操作，平衡不破，未知数被逐步孤立"
        ),
        "essence_rationale": (
            "因为等式就是天平的平衡：两边同时拿走同样多、同时等分，平衡保持不变，"
            f"所以孤立出的每个 {variable} 方块必然对应 {solution} 个单位，"
            "学生看到的每一步都是等量同变原理本身。"
        ),
        "symbol_ledger": [
            f"蓝色方块 = 未知数 {variable}",
            "黄色圆点 = 1 个单位",
            "水平横梁 = 等式两边保持相等",
        ],
        "visual_objects": [
            {
                "id": "equation_balance",
                "primitive": "balance",
                "meaning": f"承载 {coefficient}{variable} + {constant} = {total} 的天平",
                "label": "",
                "color": "blue",
                "params": {
                    "coefficient": coefficient,
                    "constant": constant,
                    "total": total,
                    "solution": solution,
                    "variable": variable,
                },
            },
            {
                "id": "unit_reference",
                "primitive": "dot",
                "meaning": "单位圆点的图例参照",
                "label": "1 个单位",
                "color": "yellow",
                "params": {},
            },
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "equation_balance",
                "action": (
                    f"搭起天平：左盘 {coefficient} 个 {variable} 方块加 {constant} 个单位，"
                    f"右盘 {total} 个单位"
                ),
                "invariant": "天平水平 = 等式成立",
                "attention_target": "两盘内容与水平的横梁",
                "exit_condition": "天平及两盘内容清楚可见",
                "teaching_line": (
                    f"等式就是天平：左盘 {coefficient} 个 {variable} 加 {constant} 个单位，"
                    f"右盘 {total} 个单位，正好平衡。"
                ),
                "duration_s": 6,
                "actions": [
                    action("create", meaning="搭起代表等式的天平"),
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "equation_balance",
                "action": "对两盘执行完全相同的操作，逐步孤立未知数",
                "invariant": "每一步两盘同变，横梁始终水平",
                "attention_target": "被同时拿走/等分的对象与保持水平的横梁",
                "exit_condition": f"每个 {variable} 方块单独对应一组单位",
                "teaching_line": "对两边做同样的事，平衡就不会破——这是解方程唯一的规则。",
                "duration_s": max(6.0, 5 + constant * 0.4 + coefficient * 1.2),
                "actions": transform_actions,
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "equation_balance",
                "action": f"把每个 {variable} 方块换成 {solution} 个单位，重数两盘核对平衡",
                "invariant": f"{coefficient} × {solution} + {constant} = {total}",
                "attention_target": "替换后两盘的单位数量",
                "exit_condition": "两盘数量一致，平衡保持",
                "teaching_line": (
                    f"检验：{variable} = {solution}，替换后两盘各 {remainder} 个单位仍平衡；"
                    f"代回原式 {coefficient}×{solution}+{constant}={total}。"
                ),
                "duration_s": 5,
                "actions": [
                    action("balance_verify", expect=solution, meaning="代回并重数两盘"),
                ],
            },
        ],
        "forbidden": ["只写符号变形不动天平", "只操作一侧托盘"],
    }
    errors = _validate_plan(plan, ctx.grade)
    if errors:
        logger.warning("linear balance plan failed validation: %s", errors[:3])
        return None
    return plan


def build_minimal_narrative_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Absolute last-resort plan: verified quantities as bars, always valid.

    Built ONLY from independently verified numbers (steps + answer), it is a
    weaker visual argument by design — but a session must never end with no
    video because the director could not produce a richer contract. The plan
    is marked degraded so review warns instead of certifying quality.
    """
    answer_text = _strip_decorations(str(ctx.state.get("solution_answer") or ""))
    answer_numbers = [
        float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", answer_text)
    ]
    step_numbers: list[float] = []
    for step in ctx.state.get("solution_steps") or []:
        if isinstance(step, dict):
            step_numbers.extend(
                float(item)
                for item in re.findall(
                    r"-?\d+(?:\.\d+)?", str(step.get("result") or "")
                )
            )
    answer_value = answer_numbers[-1] if answer_numbers else None
    start_value = next(
        (value for value in step_numbers if answer_value is None or value != answer_value),
        None,
    )
    if answer_value is None:
        answer_value = 1.0
    if start_value is None:
        start_value = answer_value + 1 if answer_value else 1.0

    def bar(object_id: str, value: float, meaning: str, label: str, color: str):
        magnitude = abs(value)
        return {
            "id": object_id,
            "primitive": "quantity_bar",
            "meaning": meaning,
            "label": label,
            "color": color,
            "params": {"value": magnitude if magnitude > 1e-9 else 1.0},
        }

    plan = {
        "plan_version": 2,
        "grounding_source": "minimal_narrative",
        "degraded_plan": True,
        "visual_thesis": "用已验证的数量状态从已知量连续变化到答案量",
        "essence_rationale": (
            "学生看到代表已知量的条形连续变为代表答案的条形，"
            "两者同屏比较后核对最终结论，全部数值来自已验证解答。"
        ),
        "symbol_ledger": ["蓝色条 = 已验证的已知量", "绿色条 = 已验证的答案量"],
        "visual_objects": [
            bar("known_quantity", start_value, "解答中的已知数量", f"{start_value:g}", "blue"),
            bar("answer_quantity", answer_value, "已验证的最终答案", f"{answer_value:g}", "green"),
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "known_quantity",
                "action": "建立代表已知量的条形",
                "invariant": "无，当前建立初始状态",
                "attention_target": "已知量条形的长度",
                "exit_condition": "已知量可见",
                "teaching_line": "先看解答中出现的已知数量。",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["known_quantity"],
                        "result": "",
                        "meaning": "建立已验证的已知数量",
                    }
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "known_quantity, answer_quantity",
                "action": "已知量条形连续变化为答案量条形",
                "invariant": "数值均来自已验证解答",
                "attention_target": "条形长度的变化",
                "exit_condition": "答案量条形可见",
                "teaching_line": "沿着解答的运算，数量变化到最终答案。",
                "duration_s": 6,
                "actions": [
                    {
                        "op": "transform",
                        "targets": ["known_quantity"],
                        "result": "answer_quantity",
                        "meaning": "已知量按已验证运算变为答案量",
                    }
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "answer_quantity",
                "action": "框选答案量并显示核对结论",
                "invariant": "答案与独立验证一致",
                "attention_target": "答案量条形",
                "exit_condition": "答案清楚可见",
                "teaching_line": f"最终答案：{answer_text or '已验证'}。",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "verify",
                        "targets": ["answer_quantity"],
                        "result": "",
                        "meaning": "核对已验证答案",
                    }
                ],
            },
        ],
        "forbidden": ["只显示文字结论", "使用未经验证的数值"],
    }
    errors = _validate_plan(plan, ctx.grade)
    if errors:
        logger.warning("minimal narrative plan failed validation: %s", errors[:3])
        return None
    return plan


def build_grounded_math_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Lower executable one-variable math evidence into a visual argument.

    This is a capability fallback, not a question-type template. It activates
    only when the verified Math IR itself exposes a drawable expression, a
    finite observation point, and a scalar result. The resulting curve,
    neighborhood focus and reference value are all copied from deterministic
    evidence, so a malformed director response cannot invent new mathematics.
    """
    if str(ctx.grade or "").startswith("elementary"):
        # Abstraction ceiling by audience, not by problem type: coordinate
        # curves and zero-crossings exceed the elementary level. Quantity
        # graphics (story/arithmetic-chain builders) or the grade-guided
        # director own this audience.
        return None
    if _graph_transform_intent(ctx) and _graph_transform_target(ctx) is not None:
        # The question is about how a graph moved, not about the height this
        # generic lowering would draw. Abstain so the graph-transformation
        # constructor (or, if it declined, the director under the geometric
        # truth gate) owns the picture instead of a neighbourhood curve that
        # answers a question nobody asked.
        return None
    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if not isinstance(request, dict) or not isinstance(evidence, dict):
        return None
    if not evidence.get("success") or evidence.get("all_claims_passed") is not True:
        return None

    operations = [item for item in request.get("operations") or [] if isinstance(item, dict)]
    raw_evidence_by_id = {
        str(item.get("id")): item.get("result")
        for item in evidence.get("operations") or []
        if isinstance(item, dict) and item.get("id")
    }
    evidence_by_id = {
        operation_id: str(result or "") for operation_id, result in raw_evidence_by_id.items()
    }
    reference_pattern = re.compile(r"^\$(?P<id>[A-Za-z_][A-Za-z0-9_]*)(?:\[(?P<index>\d+)\])?$")

    def resolve_reference(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        match = reference_pattern.fullmatch(value.strip())
        if match is None:
            return value
        resolved = raw_evidence_by_id.get(match.group("id"))
        index = match.group("index")
        if index is not None:
            if not isinstance(resolved, list):
                return None
            try:
                return resolved[int(index)]
            except (IndexError, TypeError, ValueError):
                return None
        return resolved

    def contains_reference(value: Any, operation_id: str) -> bool:
        if isinstance(value, str):
            match = reference_pattern.fullmatch(value.strip())
            return bool(match and match.group("id") == operation_id)
        if isinstance(value, list):
            return any(contains_reference(item, operation_id) for item in value)
        if isinstance(value, dict):
            return any(contains_reference(item, operation_id) for item in value.values())
        return False

    # A solve operation may be an intermediate calculation (for example a
    # stationary point later substituted into the original expression).  It
    # represents the problem's roots only when the verified final claim
    # directly consumes that solve result.  This is data-flow analysis over
    # Math IR, not a classification of the natural-language question.
    final_claim_solve_ids = {
        str(operation.get("id"))
        for operation in operations
        if str(operation.get("op") or "").lower() == "solve"
        and operation.get("id")
        and any(
            contains_reference(claim, str(operation.get("id")))
            for claim in request.get("claims") or []
            if isinstance(claim, dict)
        )
    }

    resolved_results: dict[str, str] = {}
    candidate: tuple[str, str, float, float] | None = None
    for operation in operations:
        operation_id = str(operation.get("id") or "")
        expression = str(operation.get("expression") or "").strip()
        if expression.startswith("$"):
            resolved_expression = resolve_reference(expression)
            expression = str(resolved_expression or "")
        result = evidence_by_id.get(operation_id, "")
        if operation_id and result:
            resolved_results[operation_id] = result
        variable = str(operation.get("variable") or "x").strip()
        operation_name = str(operation.get("op") or "").lower()
        if operation_name == "solve" and operation_id in final_claim_solve_ids and expression:
            raw_roots = raw_evidence_by_id.get(operation_id)
            roots = raw_roots if isinstance(raw_roots, list) else []
            try:
                root_values = sorted({float(root) for root in roots})
            except (TypeError, ValueError):
                root_values = []
            if (
                root_values
                and len(root_values) <= 8
                and all(math.isfinite(root) and abs(root) < 1e6 for root in root_values)
            ):
                if ctx.grade == "middle" and len(root_values) == 1:
                    # Representation policy: a single-root (linear-shaped)
                    # equation at middle-school level reads better as a
                    # balance argument than as a curve zero-crossing, so the
                    # open-world director owns it (its prompt mandates the
                    # balance metaphor). Multi-root equations keep the curve.
                    try:
                        probe = [
                            evaluate_real_expression_at(
                                expression, variable=variable, point=root_values[0] + dx
                            )
                            for dx in (-1.0, 0.0, 1.0)
                        ]
                        second_difference = (
                            None
                            if any(value is None for value in probe)
                            else abs(probe[0] - 2 * probe[1] + probe[2])
                        )
                    except (TypeError, ValueError):
                        second_difference = None
                    if second_difference is not None and second_difference < 1e-8:
                        return None
                margin = max(2.2, (root_values[-1] - root_values[0]) * 0.35 + 1.4)
                x_start = root_values[0] - margin
                x_end = root_values[-1] + margin
                probe_values = []
                for root in root_values:
                    for offset in (-1.0, 0.0, 1.0):
                        try:
                            value = evaluate_real_expression_at(
                                expression,
                                variable=variable,
                                point=root + offset,
                            )
                        except (TypeError, ValueError):
                            value = None
                        if value is not None:
                            probe_values.append(value)
                y_radius = max(
                    3.0,
                    min(12.0, max((abs(value) for value in probe_values), default=2) * 1.25 + 1),
                )
                try:
                    sample_real_expression(
                        expression,
                        variable=variable,
                        start=x_start,
                        end=x_end,
                        y_min=-y_radius,
                        y_max=y_radius,
                    )
                except (TypeError, ValueError):
                    continue
                root_label = ", ".join(f"{value:g}" for value in root_values)
                guide_ids = [f"grounded_root_guide_{index}" for index in range(len(root_values))]
                plan = {
                    "visual_thesis": (
                        "把一元方程移到同一侧形成函数曲线，用曲线与 x 轴的交点直接定位全部实根。"
                    ),
                    "essence_rationale": (
                        "方程成立等价于同侧表达式的函数值为零；"
                        "学生看到曲线穿过 x 轴的位置，就能从坐标而非文字读取解。"
                    ),
                    "symbol_ledger": [
                        "蓝色曲线 = Math IR 中被求解的同侧表达式",
                        "绿色圆点 = 确定性求解得到的全部实根",
                        "黄色竖线 = 根到 x 轴交点的坐标投影",
                    ],
                    "visual_objects": [
                        {
                            "id": "grounded_solve_axes",
                            "primitive": "axes",
                            "meaning": "方程零点所在的共同坐标参照",
                            "label": "",
                            "color": "gray",
                            "params": {
                                "x_range": [x_start, x_end],
                                "y_range": [-y_radius, y_radius],
                            },
                        },
                        {
                            "id": "grounded_solve_curve",
                            "primitive": "function_curve",
                            "meaning": "Math IR 中被求解的同侧表达式",
                            "label": f"g({variable})",
                            "color": "blue",
                            "params": {
                                "expression": expression,
                                "variable": variable,
                                "x_range": [x_start, x_end],
                            },
                        },
                        {
                            "id": "grounded_solve_roots",
                            "primitive": "dot",
                            "meaning": "确定性求解得到的全部实根",
                            "label": f"{variable} = {root_label}",
                            "color": "green",
                            "params": {
                                "positions": [[root, 0] for root in root_values],
                            },
                        },
                        *[
                            {
                                "id": guide_id,
                                "primitive": "line",
                                "meaning": "实根在 x 轴上的坐标投影",
                                "label": "",
                                "color": "yellow",
                                "params": {
                                    "start": [root, -0.9],
                                    "end": [root, 0.9],
                                },
                            }
                            for guide_id, root in zip(guide_ids, root_values)
                        ],
                    ],
                    "scenes": [
                        {
                            "role": "setup",
                            "anchor_zone": "A1-F6",
                            "key_objects": "坐标系与同侧表达式曲线",
                            "action": "建立坐标参照并绘制待求零点的函数。",
                            "invariant": "曲线表达式来自已验证 Math IR",
                            "attention_target": "曲线相对 x 轴的位置",
                            "exit_condition": "曲线及 x 轴清楚可见",
                            "teaching_line": "把方程移到同一侧，解就是这条曲线的零点。",
                            "duration_s": 5,
                            "actions": [
                                {
                                    "op": "create",
                                    "targets": ["grounded_solve_axes", "grounded_solve_curve"],
                                    "result": "",
                                    "meaning": "显示确定性方程对应的函数曲线",
                                }
                            ],
                        },
                        {
                            "role": "transform",
                            "anchor_zone": "A1-F6",
                            "key_objects": "根的投影线与交点",
                            "action": "从每个已验证根投影到曲线与 x 轴的交点。",
                            "invariant": "每个标记位置的函数值都为零",
                            "attention_target": "曲线穿过 x 轴的位置",
                            "exit_condition": "全部实根均被图形标出",
                            "teaching_line": "曲线与 x 轴相交的位置给出全部实数解。",
                            "duration_s": 7,
                            "actions": [
                                {
                                    "op": "create",
                                    "targets": [*guide_ids, "grounded_solve_roots"],
                                    "result": "",
                                    "meaning": "把确定性求得的根落到 x 轴交点",
                                }
                            ],
                        },
                        {
                            "role": "verify",
                            "anchor_zone": "A1-F6",
                            "key_objects": "曲线与全部根标记",
                            "action": "框选曲线和 x 轴交点核对全部实根。",
                            "invariant": "根值来自独立 Math IR 验算",
                            "attention_target": f"{variable} = {root_label}",
                            "exit_condition": "每个根都与零点位置一致",
                            "teaching_line": f"交点横坐标为 {root_label}，代回后函数值为零。",
                            "duration_s": 5,
                            "actions": [
                                {
                                    "op": "verify",
                                    "targets": ["grounded_solve_roots"],
                                    "result": "",
                                    "meaning": "核对曲线零点与确定性解集",
                                }
                            ],
                        },
                    ],
                    "forbidden": ["用答案文字代替零点", "省略多根中的任意一个"],
                    "grounded_from_math_execution": True,
                }
                normalized = _normalize_plan(plan)
                if not _validate_plan(normalized, ctx.grade):
                    return normalized
        point = operation.get("point")
        if operation_name == "substitute":
            substitutions = operation.get("substitutions")
            if isinstance(substitutions, dict) and len(substitutions) == 1:
                substitution_variable, substitution_value = next(iter(substitutions.items()))
                resolved_point = resolve_reference(substitution_value)
                if resolved_point is not None:
                    variable = str(substitution_variable or variable)
                    point = resolved_point
        if not expression or point is None or not result:
            continue
        try:
            point_value = float(point)
            result_value = float(result)
        except (TypeError, ValueError):
            continue
        if not (-1e6 < point_value < 1e6 and -1e6 < result_value < 1e6):
            continue
        candidate = (expression, variable, point_value, result_value)

    if candidate is None:
        return None
    expression, variable, point_value, result_value = candidate
    wide_radius = 2.4
    focus_radius = 0.55
    x_start, x_end = point_value - wide_radius, point_value + wide_radius
    y_radius = max(2.0, min(8.0, abs(result_value) * 0.75 + 1.5))
    y_start, y_end = result_value - y_radius, result_value + y_radius
    try:
        if not sample_real_expression(
            expression,
            variable=variable,
            start=x_start,
            end=x_end,
            y_min=y_start,
            y_max=y_end,
        ):
            return None
        point_value_on_curve = evaluate_real_expression_at(
            expression,
            variable=variable,
            point=point_value,
        )
    except (TypeError, ValueError):
        return None
    open_result_point = (
        point_value_on_curve is None or abs(point_value_on_curve - result_value) > 1e-8
    )

    def curve_points(offsets: list[float]) -> list[list[float]]:
        points: list[list[float]] = []
        for offset in offsets:
            x = point_value + offset
            if not (x_start <= x <= x_end):
                continue
            try:
                y = evaluate_real_expression_at(
                    expression, variable=variable, point=x
                )
            except (TypeError, ValueError):
                continue
            if y is None or not (y_start <= y <= y_end):
                continue
            points.append([round(x, 4), round(float(y), 4)])
        return points

    # "Why this curve": a few honest sample points come first, then the curve
    # is drawn through them. "The approach": marker points march toward the
    # target from BOTH sides, heights visibly converging on the result.
    anchor_points = curve_points([-1.8, -0.9, 0.9, 1.8])
    approach_left = curve_points([-0.45, -0.22, -0.09])
    approach_right = curve_points([0.45, 0.22, 0.09])

    expression_label = f"f({variable}) = {expression}"
    result_label = f"y = {result_value:g}"
    return {
        "visual_thesis": (
            "把确定性计算中的函数画出来，逐步收紧到指定点附近，并与已验算的结果线直接比较。"
        ),
        "essence_rationale": (
            "学生同时看到函数在目标点附近的局部走势和固定结果线；"
            "观察范围收紧后两者贴合，数值结论由图形关系而不是字幕给出。"
        ),
        "symbol_ledger": [
            "蓝色曲线 = 确定性数学执行中的原表达式",
            "绿色曲线 = 收紧观察范围后的同一表达式",
            "黄色横线与圆点 = 独立验算得到的结果",
        ],
        "visual_objects": [
            {
                "id": "grounded_axes",
                "primitive": "axes",
                "meaning": "承载确定性表达式与结果的坐标系",
                "label": "",
                "color": "gray",
                "params": {
                    "x_range": [x_start, x_end],
                    "y_range": [y_start, y_end],
                },
            },
            {
                "id": "grounded_expression_wide",
                "primitive": "function_curve",
                "meaning": "确定性数学执行中的原表达式",
                "label": expression_label,
                "color": "blue",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "x_range": [x_start, x_end],
                },
            },
            {
                "id": "grounded_expression_focus",
                "primitive": "function_curve",
                "meaning": "只保留指定点邻域内的同一表达式",
                "label": "",
                "color": "green",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "x_range": [
                        point_value - focus_radius,
                        point_value + focus_radius,
                    ],
                },
            },
            {
                "id": "grounded_result_line",
                "primitive": "line",
                "meaning": "独立验算得到的固定结果",
                "label": result_label,
                "color": "yellow",
                "params": {"x_start": x_start, "x_end": x_end, "y": result_value},
            },
            {
                "id": "grounded_result_intersection",
                "primitive": "dot",
                "meaning": "目标位置与已验算结果的交点",
                "label": f"({point_value:g}, {result_value:g})",
                "color": "yellow",
                "params": {
                    "x": point_value,
                    "y": result_value,
                    "open": open_result_point,
                },
            },
            *(
                [
                    {
                        "id": "grounded_anchor_points",
                        "primitive": "dot",
                        "meaning": "取几个自变量值算出的真实函数值，解释曲线为何是这个形状",
                        "label": "",
                        "color": "blue",
                        "params": {"positions": anchor_points},
                    }
                ]
                if len(anchor_points) >= 2
                else []
            ),
            *(
                [
                    {
                        "id": "grounded_approach_left",
                        "primitive": "dot",
                        "meaning": "自变量从左侧逐步靠近目标时的函数值位置",
                        "label": "",
                        "color": "green",
                        "params": {"positions": approach_left},
                    }
                ]
                if len(approach_left) >= 2
                else []
            ),
            *(
                [
                    {
                        "id": "grounded_approach_right",
                        "primitive": "dot",
                        "meaning": "自变量从右侧逐步靠近目标时的函数值位置",
                        "label": "",
                        "color": "green",
                        "params": {"positions": approach_right},
                    }
                ]
                if len(approach_right) >= 2
                else []
            ),
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "坐标系与取值描点",
                "action": "建立坐标参照，先取几个自变量值算出函数值并描点。",
                "invariant": "无，当前建立初始状态",
                "attention_target": "几个描出的取值点的位置走势",
                "exit_condition": "取值点已经可见，走势初现",
                "teaching_line": "先取几个值算一算，把结果描成点。",
                "duration_s": 6,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["grounded_axes"],
                        "result": "",
                        "meaning": "建立统一坐标参照",
                    },
                    *(
                        [
                            {
                                "op": "create",
                                "targets": ["grounded_anchor_points"],
                                "result": "",
                                "meaning": "描出逐个计算得到的取值点",
                            }
                        ]
                        if len(anchor_points) >= 2
                        else []
                    ),
                ],
            },
            {
                "role": "reveal",
                "anchor_zone": "B2-E5",
                "key_objects": "过取值点的表达式曲线",
                "action": "沿着描出的点连成完整曲线，说明曲线形状的来源。",
                "invariant": "曲线经过每个已算出的取值点",
                "attention_target": "曲线如何贯穿已描的点",
                "exit_condition": "曲线与取值点贴合可见",
                "teaching_line": "把这些点连起来，就是函数的曲线。",
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["grounded_expression_wide"],
                        "result": "",
                        "meaning": "绘制经过取值点的确定性表达式曲线",
                    },
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "左右逼近点与逐步收紧的曲线",
                "action": "从两侧取越来越接近目标的自变量值并描点，再收紧观察范围。",
                "invariant": "函数表达式不变，只改变观察位置与范围",
                "attention_target": "两侧逼近点的高度越来越接近结果值",
                "exit_condition": "两侧逼近点与局部曲线走势清楚可见",
                "teaching_line": "从左右两侧一步步靠近目标，函数值也一步步靠近同一个高度。",
                "duration_s": 9,
                "actions": [
                    *(
                        [
                            {
                                "op": "create",
                                "targets": ["grounded_approach_left"],
                                "result": "",
                                "meaning": "左侧逐步逼近的取值点",
                            }
                        ]
                        if len(approach_left) >= 2
                        else []
                    ),
                    *(
                        [
                            {
                                "op": "create",
                                "targets": ["grounded_approach_right"],
                                "result": "",
                                "meaning": "右侧逐步逼近的取值点",
                            }
                        ]
                        if len(approach_right) >= 2
                        else []
                    ),
                    {
                        "op": "transform",
                        "targets": ["grounded_expression_wide"],
                        "result": "grounded_expression_focus",
                        "meaning": "收紧到指定点邻域而不改变表达式",
                    },
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "局部曲线、结果线与目标圆点",
                "action": "显示独立验算结果线并与局部曲线直接核对。",
                "invariant": "结果值来自独立 Math IR 验算",
                "attention_target": "局部曲线与黄色结果标记的贴合",
                "exit_condition": "画面中的曲线和结果值完成同屏核对",
                "teaching_line": f"局部曲线贴近 {result_label}，与独立验算一致。",
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": [
                            "grounded_result_line",
                            "grounded_result_intersection",
                        ],
                        "result": "",
                        "meaning": "显示确定性计算得到的结果",
                    },
                    {
                        "op": "compare",
                        "targets": [
                            "grounded_expression_focus",
                            "grounded_result_line",
                        ],
                        "result": "",
                        "meaning": "比较局部函数值与固定结果",
                    },
                    {
                        "op": "verify",
                        "targets": [
                            "grounded_expression_focus",
                            "grounded_result_line",
                            "grounded_result_intersection",
                        ],
                        "result": "",
                        "meaning": "用同屏图形核对结论",
                    },
                ],
            },
        ],
        "forbidden": ["用字幕代替曲线变化", "使用未经确定性执行验证的表达式或数值"],
        "grounded_from_math_execution": True,
    }


# --------------------------------------------------------------------------
# Calculus constructors.
#
# math_runtime executes diff/integrate/limit exactly, but until now a verified
# calculus result had no drawable vocabulary, so those sessions fell through to
# generic boxes.  Everything below is derived from *already verified* Math IR:
# expressions are copied from the request, derivative/limit/area values are
# copied from the evidence, and every coordinate is recomputed from those
# expressions with the same safe evaluator.  No number is authored by a model.
# --------------------------------------------------------------------------

_EVIDENCE_REFERENCE_RE = re.compile(
    r"^\$(?P<id>[A-Za-z_][A-Za-z0-9_]*)(?:\[(?P<index>\d+)\])?$"
)
_EVIDENCE_TOKEN_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
_CALCULUS_OP_ALIASES = {
    "derivative": "differentiate",
    "diff": "differentiate",
    "integral": "integrate",
    "subs": "substitute",
    "define": "evaluate",
}
_COMPOSITION_OUTER_FUNCTIONS = (
    "sin",
    "cos",
    "tan",
    "exp",
    "log",
    "sqrt",
    "Abs",
    "asin",
    "acos",
    "atan",
)
_LIMIT_DIVERGENT_RESULTS = {"oo", "+oo", "-oo", "zoo", "inf", "-inf", "+inf"}


def _resolve_evidence_reference(value: Any, results: dict[str, Any]) -> Any:
    """Replace a ``$id`` / ``$id[k]`` token with the executed result."""
    if not isinstance(value, str):
        return value
    match = _EVIDENCE_REFERENCE_RE.fullmatch(value.strip())
    if match is None:
        return value
    resolved = results.get(match.group("id"))
    index = match.group("index")
    if index is None:
        return resolved
    if not isinstance(resolved, list):
        return None
    try:
        return resolved[int(index)]
    except (IndexError, TypeError, ValueError):
        return None


def _referenced_operation_ids(value: Any) -> set[str]:
    if isinstance(value, str):
        return set(_EVIDENCE_TOKEN_RE.findall(value))
    if isinstance(value, list):
        return {item for element in value for item in _referenced_operation_ids(element)}
    if isinstance(value, dict):
        return {item for element in value.values() for item in _referenced_operation_ids(element)}
    return set()


def _constant_evidence_number(value: Any) -> float | None:
    """Parse a verified scalar (``2``, ``"8/3"``, ``"pi/2"``) exactly.

    Anything still carrying a free symbol is rejected, so an expression can
    never be silently read as a number.
    """
    if isinstance(value, bool) or isinstance(value, (list, dict)):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value or "").strip()
    if not text:
        return None
    probes: list[float] = []
    for point in (0.0, 1.0):
        try:
            probe = evaluate_real_expression_at(text, variable="_probe_symbol", point=point)
        except (ArithmeticError, AttributeError, TypeError, ValueError):
            return None
        if probe is None or not math.isfinite(probe):
            return None
        probes.append(float(probe))
    if abs(probes[0] - probes[1]) > 1e-12:
        return None
    return probes[0]


def _verified_math_operations(ctx: ToolContext) -> list[dict[str, Any]]:
    """Rows of independently verified Math IR, with references resolved.

    Returns an empty list unless the executed evidence reports success and all
    claims passed, so no builder can start from unverified mathematics.
    """
    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if not isinstance(request, dict) or not isinstance(evidence, dict):
        return []
    if not evidence.get("success") or evidence.get("all_claims_passed") is not True:
        return []
    results: dict[str, Any] = {
        str(item.get("id")): item.get("result")
        for item in evidence.get("operations") or []
        if isinstance(item, dict) and item.get("id")
    }
    rows: list[dict[str, Any]] = []
    for operation in request.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        operation_id = str(operation.get("id") or "")
        raw_expression = _resolve_evidence_reference(operation.get("expression"), results)
        expression = (
            "" if isinstance(raw_expression, (list, dict)) else str(raw_expression or "").strip()
        )
        raw_result = results.get(operation_id)
        raw_op = str(operation.get("op") or "").strip().lower()
        substitutions: dict[str, float] = {}
        raw_substitutions = operation.get("substitutions")
        if isinstance(raw_substitutions, dict):
            for name, raw in raw_substitutions.items():
                number = _constant_evidence_number(_resolve_evidence_reference(raw, results))
                if number is not None:
                    substitutions[str(name)] = number
        rows.append(
            {
                "id": operation_id,
                "op": _CALCULUS_OP_ALIASES.get(raw_op, raw_op),
                "expression": expression,
                "variable": str(operation.get("variable") or "").strip(),
                "result": (
                    "" if isinstance(raw_result, (list, dict)) else str(raw_result or "").strip()
                ),
                "raw_result": raw_result,
                "substitutions": substitutions,
                "references": _referenced_operation_ids(operation.get("expression")),
                "operation": operation,
            }
        )
    return rows


def _format_number(value: float) -> str:
    return f"{round(float(value), 4):g}"


def _real_value_at(expression: str, variable: str, point: float) -> float | None:
    """A finite real function value, or ``None`` when it does not exist."""
    if not expression or not variable.isidentifier() or not math.isfinite(float(point)):
        return None
    try:
        value = evaluate_real_expression_at(
            expression, variable=variable, point=float(point)
        )
    except (ArithmeticError, AttributeError, TypeError, ValueError):
        return None
    if value is None or not math.isfinite(float(value)):
        return None
    return float(value)


def _real_curve_points(
    expression: str, variable: str, xs: list[float]
) -> list[list[float]]:
    points: list[list[float]] = []
    for x in xs:
        y = _real_value_at(expression, variable, x)
        if y is None:
            continue
        points.append([round(float(x), 4), round(y, 4)])
    return points


def _linear_space(start: float, end: float, count: int) -> list[float]:
    if count < 2 or end <= start:
        return [start]
    return [start + (end - start) * index / (count - 1) for index in range(count)]


def _value_frame(values: list[float], *, minimum_span: float = 1.0) -> tuple[float, float]:
    """A y-window that actually contains the computed values, with margin."""
    finite = [float(value) for value in values if math.isfinite(float(value))]
    if not finite:
        return (-1.0, 1.0)
    low, high = min(finite), max(finite)
    span = max(high - low, minimum_span)
    pad = span * 0.25 + 0.4
    return (round(low - pad, 4), round(high + pad, 4))


def _curve_is_drawable(
    expression: str,
    variable: str,
    x_start: float,
    x_end: float,
    y_start: float,
    y_end: float,
) -> bool:
    try:
        return bool(
            sample_real_expression(
                expression,
                variable=variable,
                start=x_start,
                end=x_end,
                y_min=y_start,
                y_max=y_end,
            )
        )
    except (ArithmeticError, TypeError, ValueError):
        return False


def _accepted_calculus_plan(
    plan: dict[str, Any], ctx: ToolContext, source: str
) -> dict[str, Any] | None:
    """Normalize, self-validate and stamp provenance on a calculus plan."""
    plan["grounded_from_math_execution"] = True
    plan["grounding_source"] = source
    # The Web player renders these primitives directly. The deterministic
    # Manim IR renderer only knows the finite legacy primitive set, so it
    # would silently drop every calculus construct and leave narration that
    # describes graphics nobody can see. The plan carries fully grounded
    # coordinates, so the code-writing stage can implement the continuous
    # geometry instead of rendering a contradiction.
    plan["compile_strategy"] = "model_codegen"
    normalized = _normalize_plan(plan)
    violations = _validate_plan(normalized, ctx.grade)
    if violations:
        logger.debug("calculus plan %s rejected by internal contract: %s", source, violations)
        return None
    return normalized


def _derivative_reading_point(rows: list[dict[str, Any]], row: dict[str, Any]) -> float:
    """Where the verified derivative is actually read, taken from evidence.

    Priority: an explicit point on the differentiate operation, then the
    substitution that a later verified operation applies to this derivative.
    Only when the evidence names no point at all does the builder fall back to
    a neutral viewing position, which is a framing choice, not a claim.
    """
    operation = row["operation"]
    for key in ("point", "at", "at_x"):
        value = _constant_evidence_number(operation.get(key))
        if value is not None:
            return value
    variable = row["variable"] or "x"
    for other in rows:
        if row["id"] and row["id"] in other["references"]:
            value = other["substitutions"].get(variable)
            if value is not None:
                return float(value)
    for other in rows:
        value = other["substitutions"].get(variable)
        if value is not None:
            return float(value)
    return 1.0


def build_derivative_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Turn a verified derivative into secants collapsing onto the tangent.

    The h-ladder, every secant slope and the tangent slope are recomputed from
    the verified expression and its verified derivative, so the picture is the
    proof: the student watches the average rate of change stabilize.
    """
    if str(ctx.grade or "").startswith("elementary"):
        return None
    rows = _verified_math_operations(ctx)
    for row in rows:
        if row["op"] != "differentiate":
            continue
        expression = row["expression"]
        derivative = row["result"]
        variable = row["variable"] or "x"
        if not expression or not derivative or not variable.isidentifier():
            continue
        at_x = _derivative_reading_point(rows, row)
        value_at = _real_value_at(expression, variable, at_x)
        slope = _real_value_at(derivative, variable, at_x)
        if value_at is None or slope is None:
            continue
        steps: list[tuple[float, float, float]] = []
        for offset in (1.0, 0.5, 0.25, 0.125, 0.0625):
            neighbour = _real_value_at(expression, variable, at_x + offset)
            if neighbour is None:
                continue
            steps.append((offset, neighbour, (neighbour - value_at) / offset))
            if len(steps) == 3:
                break
        if len(steps) < 2:
            continue
        widest = steps[0][0]
        radius = widest * 1.6 + 0.4
        x_start, x_end = round(at_x - radius, 4), round(at_x + radius, 4)
        reach = radius * 0.8
        tangent_start = [round(at_x - reach, 4), round(value_at - slope * reach, 4)]
        tangent_end = [round(at_x + reach, 4), round(value_at + slope * reach, 4)]
        frame_values = [
            value_at,
            tangent_start[1],
            tangent_end[1],
            *[neighbour for _, neighbour, _ in steps],
            *[
                point[1]
                for point in _real_curve_points(
                    expression, variable, _linear_space(x_start, x_end, 9)
                )
            ],
        ]
        y_start, y_end = _value_frame(frame_values)
        if not _curve_is_drawable(expression, variable, x_start, x_end, y_start, y_end):
            continue

        secant_ids = [f"derivative_secant_{index + 1}" for index in range(len(steps))]
        secant_objects = [
            {
                "id": secant_id,
                "primitive": "secant_line",
                "meaning": f"间隔 h={_format_number(offset)} 的两点割线，斜率是平均变化率",
                "label": (
                    f"h = {_format_number(offset)}，斜率 {_format_number(secant_slope)}"
                ),
                "color": "yellow",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "x0": round(at_x, 4),
                    "h": round(offset, 6),
                    "slope": round(secant_slope, 6),
                    "start": [round(at_x, 4), round(value_at, 4)],
                    "end": [round(at_x + offset, 4), round(neighbour, 4)],
                },
            }
            for secant_id, (offset, neighbour, secant_slope) in zip(secant_ids, steps)
        ]
        scenes: list[dict[str, Any]] = [
            {
                "role": "setup",
                "anchor_zone": "A1-F6",
                "key_objects": "坐标系、函数曲线与观察点",
                "action": "建立统一坐标参照，画出函数并固定要考察的那一点。",
                "invariant": "函数表达式来自已验证 Math IR，全程不变",
                "attention_target": f"曲线在 {variable} = {_format_number(at_x)} 处的位置",
                "exit_condition": "曲线与观察点同屏可见",
                "teaching_line": (
                    f"先看函数本身：在 {variable} = {_format_number(at_x)} 处，"
                    f"函数值是 {_format_number(value_at)}。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": [
                            "derivative_axes",
                            "derivative_curve",
                            "derivative_point",
                        ],
                        "result": "",
                        "meaning": "建立坐标参照与考察点",
                    }
                ],
            },
            {
                "role": "reveal",
                "anchor_zone": "A1-F6",
                "key_objects": "第一条割线",
                "action": "连接考察点与右侧间隔 h 的点，显出这段的平均变化率。",
                "invariant": "割线始终经过考察点",
                "attention_target": "割线相对曲线的倾斜程度",
                "exit_condition": "割线与两个端点清楚可见",
                "teaching_line": (
                    f"取 h = {_format_number(steps[0][0])}，"
                    f"两点连线的斜率是 {_format_number(steps[0][2])}，"
                    "这是这一段的平均变化率。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": [secant_ids[0]],
                        "result": "",
                        "meaning": "显示间隔最大的一条割线",
                    }
                ],
            },
        ]
        for index in range(1, len(steps)):
            previous_offset, _, previous_slope = steps[index - 1]
            offset, _, secant_slope = steps[index]
            scenes.append(
                {
                    "role": "transform",
                    "anchor_zone": "A1-F6",
                    "key_objects": "正在变短的割线",
                    "action": "把间隔 h 缩小一半，割线跟着转到新的位置。",
                    "invariant": "割线仍然经过同一个考察点，函数没有变",
                    "attention_target": "割线斜率的变化量越来越小",
                    "exit_condition": "新的割线取代旧割线并保持可见",
                    "teaching_line": (
                        f"h 从 {_format_number(previous_offset)} 缩到 "
                        f"{_format_number(offset)}，斜率从 "
                        f"{_format_number(previous_slope)} 变成 "
                        f"{_format_number(secant_slope)}，越来越靠近一个固定值。"
                    ),
                    "duration_s": 6,
                    "actions": [
                        {
                            "op": "transform",
                            "targets": [secant_ids[index - 1]],
                            "result": secant_ids[index],
                            "meaning": "把割线的间隔缩小到下一档",
                        }
                    ],
                }
            )
        scenes.append(
            {
                "role": "reveal",
                "anchor_zone": "A1-F6",
                "key_objects": "割线的极限位置：切线",
                "action": "让间隔继续趋于 0，割线停在唯一的极限位置上。",
                "invariant": "极限位置只与考察点处的函数走势有关",
                "attention_target": "切线与曲线在考察点处贴合的方向",
                "exit_condition": "切线取代最后一条割线",
                "teaching_line": (
                    "当 h 趋于 0，割线的极限位置就是切线；"
                    f"它的斜率 {_format_number(slope)} 就是导数在这一点的值。"
                ),
                "duration_s": 6,
                "actions": [
                    {
                        "op": "transform",
                        "targets": [secant_ids[-1]],
                        "result": "derivative_tangent",
                        "meaning": "割线趋于极限位置成为切线",
                    }
                ],
            }
        )
        scenes.append(
            {
                "role": "verify",
                "anchor_zone": "A1-F6",
                "key_objects": "切线与考察点",
                "action": "量出切线的陡峭程度，并与独立求导的结果核对。",
                "invariant": "导数表达式由确定性求导独立得到",
                "attention_target": f"切线斜率 {_format_number(slope)}",
                "exit_condition": "图上的斜率与求导结果同屏一致",
                "teaching_line": (
                    f"导数 {derivative} 在 {variable} = {_format_number(at_x)} 处等于 "
                    f"{_format_number(slope)}，正是这条切线的陡峭程度。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "measure",
                        "targets": ["derivative_tangent"],
                        "result": "",
                        "meaning": "量取切线斜率",
                    },
                    {
                        "op": "verify",
                        "targets": ["derivative_tangent", "derivative_point"],
                        "result": "",
                        "meaning": "核对图上斜率与确定性求导结果",
                    },
                ],
            }
        )
        plan = {
            "visual_thesis": (
                "让割线随间隔缩小转成切线，把导数显示为曲线在一点的瞬时陡峭程度。"
            ),
            "essence_rationale": (
                "因为割线斜率就是两点之间的平均变化率，间隔不断缩小时它稳定地趋向同一个数；"
                "学生看到割线转到切线的位置，就明白导数是瞬时变化率，而不是一条求导规则。"
            ),
            "symbol_ledger": [
                "蓝色曲线 = 已验证 Math IR 中被求导的函数",
                "黄色割线 = 间隔 h 的平均变化率，h 每拍减半",
                "绿色切线 = h 趋于 0 的极限位置，其斜率等于导数值",
            ],
            "visual_objects": [
                {
                    "id": "derivative_axes",
                    "primitive": "axes",
                    "meaning": "承载函数、割线与切线的同一坐标参照",
                    "label": "",
                    "color": "gray",
                    "params": {
                        "x_range": [x_start, x_end],
                        "y_range": [y_start, y_end],
                    },
                },
                {
                    "id": "derivative_curve",
                    "primitive": "function_curve",
                    "meaning": "已验证 Math IR 中被求导的函数",
                    "label": f"f({variable}) = {expression}",
                    "color": "blue",
                    "params": {
                        "expression": expression,
                        "variable": variable,
                        "x_range": [x_start, x_end],
                    },
                },
                {
                    "id": "derivative_point",
                    "primitive": "dot",
                    "meaning": "考察导数的那一点，割线始终经过它",
                    "label": f"{variable} = {_format_number(at_x)}",
                    "color": "green",
                    "params": {"x": round(at_x, 4), "y": round(value_at, 4)},
                },
                *secant_objects,
                {
                    "id": "derivative_tangent",
                    "primitive": "tangent_line",
                    "meaning": "割线在间隔趋于 0 时的极限位置，斜率等于导数值",
                    "label": (
                        f"f'({_format_number(at_x)}) = {_format_number(slope)}"
                    ),
                    "color": "green",
                    "params": {
                        "expression": expression,
                        "variable": variable,
                        "at_x": round(at_x, 4),
                        "slope": round(slope, 6),
                        "derivative": derivative,
                        "start": tangent_start,
                        "end": tangent_end,
                    },
                },
            ],
            "scenes": scenes,
            "forbidden": [
                "直接给出导数公式而不显示割线趋近过程",
                "画一条与函数无关的装饰性直线充当切线",
            ],
        }
        accepted = _accepted_calculus_plan(plan, ctx, "calculus_derivative")
        if accepted is not None:
            return accepted
    return None


def _riemann_sum(
    expression: str,
    variable: str,
    start: float,
    end: float,
    count: int,
    side: str = "mid",
) -> tuple[float, list[list[float]]] | None:
    """Exact Riemann sum plus the rectangles it is made of, or ``None``."""
    if count < 1 or end <= start:
        return None
    width = (end - start) / count
    total = 0.0
    rectangles: list[list[float]] = []
    for index in range(count):
        left = start + index * width
        if side == "left":
            sample = left
        elif side == "right":
            sample = left + width
        else:
            sample = left + width / 2
        height = _real_value_at(expression, variable, sample)
        if height is None:
            return None
        total += height * width
        rectangles.append([round(left, 6), round(left + width, 6), round(height, 6)])
    return round(total, 6), rectangles


def build_integral_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Turn a verified definite integral into an accumulating rectangle sum.

    The rectangle counts rise 4 → 8 → 16 and every partial sum printed in a
    beat is the sum actually computed from the verified integrand, converging
    on the verified exact value.
    """
    if str(ctx.grade or "").startswith("elementary"):
        return None
    for row in _verified_math_operations(ctx):
        if row["op"] != "integrate":
            continue
        expression = row["expression"]
        variable = row["variable"] or "x"
        if not expression or not variable.isidentifier():
            continue
        bounds = row["operation"].get("bounds")
        if not isinstance(bounds, list) or len(bounds) != 2:
            continue
        lower = _constant_evidence_number(bounds[0])
        upper = _constant_evidence_number(bounds[1])
        exact = _constant_evidence_number(row["result"])
        if lower is None or upper is None or exact is None or upper <= lower:
            continue
        sums = []
        for count in (4, 8, 16):
            computed = _riemann_sum(expression, variable, lower, upper, count, "mid")
            if computed is None:
                break
            sums.append((count, computed[0], computed[1]))
        if len(sums) < 2:
            continue
        pad = (upper - lower) * 0.25 + 0.3
        x_start, x_end = round(lower - pad, 4), round(upper + pad, 4)
        frame_values = [
            0.0,
            *[height for _, _, rectangles in sums for _, _, height in rectangles],
            *[
                point[1]
                for point in _real_curve_points(
                    expression, variable, _linear_space(x_start, x_end, 11)
                )
            ],
        ]
        y_start, y_end = _value_frame(frame_values)
        if not _curve_is_drawable(expression, variable, x_start, x_end, y_start, y_end):
            continue

        rect_ids = [f"integral_rects_{count}" for count, _, _ in sums]
        rect_objects = [
            {
                "id": rect_id,
                "primitive": "riemann_rects",
                "meaning": f"把区间等分成 {count} 份后，用矩形累积出的面积近似",
                "label": f"n = {count}，累积 ≈ {_format_number(approximate)}",
                "color": "yellow" if index < len(sums) - 1 else "green",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "x_range": [round(lower, 4), round(upper, 4)],
                    "n": count,
                    "side": "mid",
                    "approx_area": approximate,
                    "rects": rectangles,
                },
            }
            for index, (rect_id, (count, approximate, rectangles)) in enumerate(
                zip(rect_ids, sums)
            )
        ]
        scenes: list[dict[str, Any]] = [
            {
                "role": "setup",
                "anchor_zone": "A1-F6",
                "key_objects": "坐标系与被积函数曲线",
                "action": "建立坐标参照，画出被积函数并标出积分区间。",
                "invariant": "被积函数与积分区间来自已验证 Math IR",
                "attention_target": (
                    f"曲线与 {variable} 轴在 {_format_number(lower)} 到 "
                    f"{_format_number(upper)} 之间围出的区域"
                ),
                "exit_condition": "曲线与区间同屏可见",
                "teaching_line": (
                    f"定积分要量的是曲线与横轴在 {_format_number(lower)} 到 "
                    f"{_format_number(upper)} 之间围成的面积。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["integral_axes", "integral_curve"],
                        "result": "",
                        "meaning": "建立坐标参照并显示被积函数",
                    }
                ],
            },
            {
                "role": "reveal",
                "anchor_zone": "A1-F6",
                "key_objects": f"{sums[0][0]} 个近似矩形",
                "action": "把区间等分，用矩形先粗略地把这块面积堆出来。",
                "invariant": "矩形高度由被积函数在取样点的真实值决定",
                "attention_target": "矩形与曲线之间剩下的空隙",
                "exit_condition": "全部矩形与曲线同屏可见",
                "teaching_line": (
                    f"先分成 {sums[0][0]} 份，矩形面积加起来是 "
                    f"{_format_number(sums[0][1])}，还看得见空隙。"
                ),
                "duration_s": 6,
                "actions": [
                    {
                        "op": "create",
                        "targets": [rect_ids[0]],
                        "result": "",
                        "meaning": "用粗分割的矩形近似面积",
                    }
                ],
            },
        ]
        for index in range(1, len(sums)):
            previous_count, previous_sum, _ = sums[index - 1]
            count, approximate, _ = sums[index]
            scenes.append(
                {
                    "role": "transform",
                    "anchor_zone": "A1-F6",
                    "key_objects": f"细分成 {count} 份的矩形",
                    "action": "把每个矩形再对半分，重新按函数值贴合曲线。",
                    "invariant": "积分区间与被积函数不变，只有分割变细",
                    "attention_target": "矩形顶部与曲线之间的空隙在缩小",
                    "exit_condition": "更细的矩形取代原来的矩形",
                    "teaching_line": (
                        f"从 {previous_count} 份细分到 {count} 份，累积面积由 "
                        f"{_format_number(previous_sum)} 变成 {_format_number(approximate)}，"
                        f"正在逼近 {_format_number(exact)}。"
                    ),
                    "duration_s": 6,
                    "actions": [
                        {
                            "op": "transform",
                            "targets": [rect_ids[index - 1]],
                            "result": rect_ids[index],
                            "meaning": "把分割加密一倍",
                        }
                    ],
                }
            )
        scenes.append(
            {
                "role": "verify",
                "anchor_zone": "A1-F6",
                "key_objects": "最细的矩形堆与曲线",
                "action": "量出最细分割的累积面积，与确定性积分结果核对。",
                "invariant": "精确值由确定性积分独立得到",
                "attention_target": f"累积面积 {_format_number(sums[-1][1])}",
                "exit_condition": "近似值与精确值同屏比较完成",
                "teaching_line": (
                    f"分得越细越贴合：{_format_number(sums[-1][1])} 已经很接近确定性积分给出的 "
                    f"{_format_number(exact)}。"
                ),
                "duration_s": 6,
                "actions": [
                    {
                        "op": "measure",
                        "targets": [rect_ids[-1]],
                        "result": "",
                        "meaning": "量取最细分割的累积面积",
                    },
                    {
                        "op": "compare",
                        "targets": [rect_ids[-1], "integral_curve"],
                        "result": "",
                        "meaning": "比较矩形堆与曲线下方区域",
                    },
                    {
                        "op": "verify",
                        "targets": [rect_ids[-1], "integral_curve"],
                        "result": "",
                        "meaning": "核对近似面积与确定性积分结果",
                    },
                ],
            }
        )
        plan = {
            "visual_thesis": (
                "用越来越细的矩形把曲线下的面积堆出来，让定积分的数值从累积过程里长出来。"
            ),
            "essence_rationale": (
                "因为每个矩形的高都取自被积函数的真实值，所以它们的面积和就是这块区域的近似；"
                "分割越细空隙越小，学生看到累积值稳定地趋向同一个数，就明白积分是累积的极限。"
            ),
            "symbol_ledger": [
                "蓝色曲线 = 已验证 Math IR 中的被积函数",
                "黄色矩形 = 当前分割下的累积面积近似",
                "绿色矩形 = 最细分割，其累积值最接近确定性积分结果",
            ],
            "visual_objects": [
                {
                    "id": "integral_axes",
                    "primitive": "axes",
                    "meaning": "承载被积函数与全部矩形的同一坐标参照",
                    "label": "",
                    "color": "gray",
                    "params": {
                        "x_range": [x_start, x_end],
                        "y_range": [y_start, y_end],
                    },
                },
                {
                    "id": "integral_curve",
                    "primitive": "function_curve",
                    "meaning": "已验证 Math IR 中的被积函数",
                    "label": f"f({variable}) = {expression}",
                    "color": "blue",
                    "params": {
                        "expression": expression,
                        "variable": variable,
                        "x_range": [x_start, x_end],
                    },
                },
                *rect_objects,
            ],
            "scenes": scenes,
            "forbidden": [
                "直接写出积分数值而不显示累积过程",
                "让矩形高度脱离被积函数的真实取值",
            ],
        }
        accepted = _accepted_calculus_plan(plan, ctx, "calculus_integral")
        if accepted is not None:
            return accepted
    return None


def build_limit_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Show a verified limit as function values marching in from both sides.

    Convergence is drawn as heights settling onto one horizontal line;
    divergence is drawn as heights that never settle. Both readings come from
    real function values at the approach points, never from the answer text.
    """
    if str(ctx.grade or "").startswith("elementary"):
        return None
    for row in _verified_math_operations(ctx):
        if row["op"] != "limit":
            continue
        expression = row["expression"]
        variable = row["variable"] or "x"
        if not expression or not variable.isidentifier():
            continue
        target = _constant_evidence_number(row["operation"].get("point"))
        if target is None:
            continue
        limit_value = _constant_evidence_number(row["result"])
        divergent = (
            limit_value is None
            and row["result"].replace(" ", "") in _LIMIT_DIVERGENT_RESULTS
        )
        if limit_value is None and not divergent:
            continue
        direction = str(row["operation"].get("direction") or "+-").strip()
        side = {"+": "right", "-": "left"}.get(direction, "both")
        far_offsets = [0.8, 0.4]
        near_offsets = [0.2, 0.1, 0.05]

        def ladder(offsets: list[float]) -> dict[str, list[list[float]]]:
            approach: dict[str, list[list[float]]] = {}
            if side in {"left", "both"}:
                approach["left"] = _real_curve_points(
                    expression, variable, [target - offset for offset in offsets]
                )
            if side in {"right", "both"}:
                approach["right"] = _real_curve_points(
                    expression, variable, [target + offset for offset in offsets]
                )
            return approach

        far_points = ladder(far_offsets)
        near_points = ladder(near_offsets)
        if not far_points or not near_points:
            continue
        if any(len(points) < 2 for points in far_points.values()):
            continue
        if any(len(points) < 2 for points in near_points.values()):
            continue
        radius = max(far_offsets) * 1.8 + 0.2
        x_start, x_end = round(target - radius, 4), round(target + radius, 4)
        ladder_values = [
            point[1]
            for group in (far_points, near_points)
            for points in group.values()
            for point in points
        ]
        frame_values = [*ladder_values]
        if limit_value is not None:
            frame_values.append(limit_value)
        y_start, y_end = _value_frame(frame_values)
        if not _curve_is_drawable(expression, variable, x_start, x_end, y_start, y_end):
            continue
        value_at_target = _real_value_at(expression, variable, target)
        nearest = near_points.get("right") or near_points.get("left") or []
        nearest_value = nearest[-1][1] if nearest else None

        visual_objects: list[dict[str, Any]] = [
            {
                "id": "limit_axes",
                "primitive": "axes",
                "meaning": "承载函数与两侧逼近点的同一坐标参照",
                "label": "",
                "color": "gray",
                "params": {"x_range": [x_start, x_end], "y_range": [y_start, y_end]},
            },
            {
                "id": "limit_curve",
                "primitive": "function_curve",
                "meaning": "已验证 Math IR 中被取极限的函数",
                "label": f"f({variable}) = {expression}",
                "color": "blue",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "x_range": [x_start, x_end],
                },
            },
            {
                "id": "limit_far",
                "primitive": "limit_approach",
                "meaning": "离目标还较远时，自变量与对应函数值的位置",
                "label": f"{variable} → {_format_number(target)}（远处取样）",
                "color": "yellow",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "target": round(target, 4),
                    "from": side,
                    "offsets": far_offsets,
                    "points": far_points,
                },
            },
            {
                "id": "limit_near",
                "primitive": "limit_approach",
                "meaning": "自变量逼到目标近旁时，函数值实际停在哪里",
                "label": f"{variable} → {_format_number(target)}（近处取样）",
                "color": "green",
                "params": {
                    "expression": expression,
                    "variable": variable,
                    "target": round(target, 4),
                    "from": side,
                    "offsets": near_offsets,
                    "points": near_points,
                    "divergent": divergent,
                    **(
                        {"limit_value": round(limit_value, 6)}
                        if limit_value is not None
                        else {}
                    ),
                },
            },
        ]
        if limit_value is not None:
            visual_objects.extend(
                [
                    {
                        "id": "limit_line",
                        "primitive": "line",
                        "meaning": "两侧函数值共同压向的那个高度",
                        "label": f"y = {_format_number(limit_value)}",
                        "color": "green",
                        "params": {
                            "points": [
                                [x_start, round(limit_value, 4)],
                                [x_end, round(limit_value, 4)],
                            ],
                            "start": [x_start, round(limit_value, 4)],
                            "end": [x_end, round(limit_value, 4)],
                        },
                    },
                    {
                        "id": "limit_marker",
                        "primitive": "dot",
                        "meaning": "目标位置上的极限高度；空心表示该点函数值本身未定义",
                        "label": "",
                        "color": "green",
                        "params": {
                            "x": round(target, 4),
                            "y": round(limit_value, 4),
                            "open": value_at_target is None
                            or abs(value_at_target - limit_value) > 1e-8,
                        },
                    },
                ]
            )
        approach_words = {
            "left": "从左侧",
            "right": "从右侧",
            "both": "从左右两侧",
        }[side]
        scenes: list[dict[str, Any]] = [
            {
                "role": "setup",
                "anchor_zone": "A1-F6",
                "key_objects": "坐标系、函数曲线与远处取样点",
                "action": "建立坐标参照，先在离目标较远处取自变量并描出函数值。",
                "invariant": "函数表达式与目标位置来自已验证 Math IR",
                "attention_target": f"{approach_words}取样点的高度",
                "exit_condition": "远处取样点与曲线同屏可见",
                "teaching_line": (
                    f"先{approach_words}离 {variable} = {_format_number(target)} 还远的地方取值，"
                    "把函数值描出来。"
                ),
                "duration_s": 5,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["limit_axes", "limit_curve", "limit_far"],
                        "result": "",
                        "meaning": "建立坐标参照并显示远处取样",
                    }
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "A1-F6",
                "key_objects": "正在逼近目标的取样点",
                "action": "把自变量一步步挪到目标近旁，取样点跟着走。",
                "invariant": "函数没有变，只有自变量离目标越来越近",
                "attention_target": "取样点高度是否稳定下来",
                "exit_condition": "近处取样点取代远处取样点",
                "teaching_line": (
                    f"把 {variable} 一路挪到离 {_format_number(target)} 只差 0.05 的地方，"
                    + (
                        "函数值一路涨到 "
                        f"{_format_number(nearest_value)}，没有停下来的意思。"
                        if divergent and nearest_value is not None
                        else f"函数值稳定在 {_format_number(nearest_value)} 附近。"
                        if nearest_value is not None
                        else "看函数值往哪里走。"
                    )
                ),
                "duration_s": 7,
                "actions": [
                    {
                        "op": "transform",
                        "targets": ["limit_far"],
                        "result": "limit_near",
                        "meaning": "自变量继续逼近目标",
                    }
                ],
            },
        ]
        if limit_value is not None:
            scenes.append(
                {
                    "role": "reveal",
                    "anchor_zone": "A1-F6",
                    "key_objects": "极限高度线与目标点",
                    "action": "画出两侧共同压向的那条水平线并标出目标位置。",
                    "invariant": "极限值由确定性求极限独立得到",
                    "attention_target": f"高度 {_format_number(limit_value)}",
                    "exit_condition": "水平线与取样点贴合可见",
                    "teaching_line": (
                        f"{approach_words}挤过来的函数值都压向同一条水平线 y = "
                        f"{_format_number(limit_value)}，这就是极限。"
                    ),
                    "duration_s": 5,
                    "actions": [
                        {
                            "op": "create",
                            "targets": ["limit_line", "limit_marker"],
                            "result": "",
                            "meaning": "显示确定性求得的极限高度",
                        }
                    ],
                }
            )
            scenes.append(
                {
                    "role": "verify",
                    "anchor_zone": "A1-F6",
                    "key_objects": "近处取样点与极限线",
                    "action": "把近处取样点的高度与极限线直接比较。",
                    "invariant": "比较的两边分别来自图形取样与确定性计算",
                    "attention_target": "取样点与水平线的贴合",
                    "exit_condition": "两者同屏核对完成",
                    "teaching_line": (
                        f"越靠近 {_format_number(target)}，函数值与 "
                        f"{_format_number(limit_value)} 的差就越小，极限成立。"
                    ),
                    "duration_s": 5,
                    "actions": [
                        {
                            "op": "compare",
                            "targets": ["limit_near", "limit_line"],
                            "result": "",
                            "meaning": "比较逼近点高度与极限值",
                        },
                        {
                            "op": "verify",
                            "targets": ["limit_near", "limit_line", "limit_marker"],
                            "result": "",
                            "meaning": "核对图形逼近与确定性极限结果",
                        },
                    ],
                }
            )
        else:
            scenes.append(
                {
                    "role": "reveal",
                    "anchor_zone": "A1-F6",
                    "key_objects": "不断抬高的取样点",
                    "action": "继续逼近，让取样点冲出画面上沿。",
                    "invariant": "函数表达式不变",
                    "attention_target": "取样点没有停在任何固定高度",
                    "exit_condition": "取样点越过画面范围",
                    "teaching_line": "越靠近目标，函数值越大，没有停在任何高度上。",
                    "duration_s": 5,
                    "actions": [
                        {
                            "op": "highlight",
                            "targets": ["limit_near"],
                            "result": "",
                            "meaning": "强调取样点持续发散",
                        }
                    ],
                }
            )
            scenes.append(
                {
                    "role": "verify",
                    "anchor_zone": "A1-F6",
                    "key_objects": "取样点与曲线",
                    "action": "量出逼近过程中的函数值并与曲线走向核对。",
                    "invariant": "发散结论由确定性求极限独立得到",
                    "attention_target": "函数值持续增大的走向",
                    "exit_condition": "发散过程同屏核对完成",
                    "teaching_line": (
                        f"确定性计算给出的结果是 {row['result']}：函数值不收敛到任何有限高度。"
                    ),
                    "duration_s": 5,
                    "actions": [
                        {
                            "op": "measure",
                            "targets": ["limit_near"],
                            "result": "",
                            "meaning": "量取逼近点的函数值",
                        },
                        {
                            "op": "verify",
                            "targets": ["limit_near", "limit_curve"],
                            "result": "",
                            "meaning": "核对图形走向与确定性极限结果",
                        },
                    ],
                }
            )
        plan = {
            "visual_thesis": (
                "让自变量一步步逼近目标，用函数值的实际高度显示极限存在还是发散。"
            ),
            "essence_rationale": (
                "因为极限说的是自变量靠近目标时函数值的去向，而不是它在目标点的取值；"
                "学生看到两侧取样点的高度一起稳定下来，就明白极限为什么与该点是否有定义无关。"
            ),
            "symbol_ledger": [
                "蓝色曲线 = 已验证 Math IR 中被取极限的函数",
                "黄色取样点 = 离目标还远时的函数值",
                "绿色取样点与水平线 = 逼近目标时函数值的去向",
            ],
            "visual_objects": visual_objects,
            "scenes": scenes,
            "forbidden": [
                "直接写出极限值而不显示逼近过程",
                "把目标点的函数值当成极限值",
            ],
        }
        accepted = _accepted_calculus_plan(plan, ctx, "calculus_limit")
        if accepted is not None:
            return accepted
    return None


def _matching_parenthesis(text: str, start: int) -> int:
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _decompose_composition(expression: str, variable: str) -> tuple[str, str] | None:
    """Split ``f(g(x))`` into an outer form in ``u`` and an inner form in x.

    Structural, not textual pattern-matching on the problem: a whole-string
    function call with a non-atomic argument, or a parenthesized base raised
    to a power. ``sin(x)`` is not a composition and is rejected.
    """
    text = str(expression or "").strip().replace("^", "**")
    if not text or not variable.isidentifier() or variable not in text:
        return None
    for name in _COMPOSITION_OUTER_FUNCTIONS:
        if not text.startswith(f"{name}("):
            continue
        close = _matching_parenthesis(text, len(name))
        if close != len(text) - 1:
            continue
        inner = text[len(name) + 1 : close].strip()
        if inner and inner != variable and variable in inner:
            return f"{name}(u)", inner
    if text.startswith("("):
        close = _matching_parenthesis(text, 0)
        if close > 0:
            power = re.fullmatch(r"\*\*\s*(-?\d+)", text[close + 1 :].strip())
            inner = text[1:close].strip()
            if power and inner and inner != variable and variable in inner:
                return f"u**{power.group(1)}", inner
    return None


def build_composition_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Show a composite function as the two-step machine x → u → y.

    The inner curve, the outer curve over the *actual* range of u, and the
    composed curve share one coordinate frame, and the sampled chain triples
    are checked against the composed expression before they are emitted.
    """
    if str(ctx.grade or "").startswith("elementary"):
        return None
    rows = _verified_math_operations(ctx)
    if any(row["op"] == "solve" for row in rows):
        # The question is "where does this vanish", not "how is this function
        # built": the zero-crossing argument owns that evidence.
        return None
    center = 0.0
    for row in rows:
        for name, value in row["substitutions"].items():
            if name == (row["variable"] or "x"):
                center = value
        point = _constant_evidence_number(row["operation"].get("point"))
        if point is not None:
            center = point
    for row in rows:
        expression = row["expression"]
        variable = row["variable"] or "x"
        decomposed = _decompose_composition(expression, variable)
        if decomposed is None:
            continue
        outer, inner = decomposed
        x_start, x_end = round(center - 3.0, 4), round(center + 3.0, 4)
        sample_xs = _linear_space(x_start, x_end, 13)
        inner_points = _real_curve_points(inner, variable, sample_xs)
        composed_points = _real_curve_points(expression, variable, sample_xs)
        if len(inner_points) < 5 or len(composed_points) < 5:
            continue
        inner_values = [point[1] for point in inner_points]
        u_low, u_high = min(inner_values), max(inner_values)
        if u_high - u_low < 1e-9:
            continue
        u_pad = (u_high - u_low) * 0.1
        u_range = [round(u_low - u_pad, 4), round(u_high + u_pad, 4)]
        outer_points = _real_curve_points(
            outer, "u", _linear_space(u_range[0], u_range[1], 13)
        )
        if len(outer_points) < 5:
            continue
        chain: list[dict[str, float]] = []
        for ratio in (0.3, 0.5, 0.7):
            x = round(x_start + (x_end - x_start) * ratio, 4)
            u = _real_value_at(inner, variable, x)
            if u is None:
                continue
            y_outer = _real_value_at(outer, "u", u)
            y_composed = _real_value_at(expression, variable, x)
            if y_outer is None or y_composed is None:
                continue
            if abs(y_outer - y_composed) > 1e-6:
                # The two routes must agree; if they do not, this is not the
                # decomposition of that expression and nothing may be drawn.
                chain = []
                break
            chain.append(
                {"x": x, "u": round(u, 4), "y": round(y_composed, 4)}
            )
        if len(chain) < 2:
            continue
        axis_start = round(min(x_start, u_range[0]), 4)
        axis_end = round(max(x_end, u_range[1]), 4)
        frame_values = [
            *inner_values,
            *[point[1] for point in outer_points],
            *[point[1] for point in composed_points],
        ]
        y_start, y_end = _value_frame(frame_values)
        if not all(
            _curve_is_drawable(
                curve_expression, curve_variable, curve_start, curve_end, y_start, y_end
            )
            for curve_expression, curve_variable, curve_start, curve_end in (
                (inner, variable, x_start, x_end),
                (outer, "u", u_range[0], u_range[1]),
                (expression, variable, x_start, x_end),
            )
        ):
            continue
        check_points = [
            [item["x"], item["y"]] for item in chain if y_start <= item["y"] <= y_end
        ]
        if len(check_points) < 2:
            continue

        plan = {
            "visual_thesis": (
                "把复合函数拆成两台机器：先看内层把 x 变成 u，"
                "再看外层把 u 变成 y，最后合成同一条曲线。"
            ),
            "essence_rationale": (
                "因为复合函数的每个函数值都要走 x → u → y 两步，"
                "学生看到中间量 u 的高度被送进外层再变成 y，就明白合成曲线的形状是两步映射的结果，"
                "而不是一个需要背下来的新公式。"
            ),
            "symbol_ledger": [
                "蓝色曲线 = 内层 u = g(x)，把 x 变成中间量 u",
                "黄色曲线 = 外层 y = f(u)，横轴此刻读作中间量 u",
                "绿色曲线与链条 = 合成结果 y = f(g(x)) 及其 x→u→y 对应关系",
            ],
            "visual_objects": [
                {
                    "id": "composition_axes",
                    "primitive": "axes",
                    "meaning": "内层、外层与合成结果共用的同一坐标参照",
                    "label": "",
                    "color": "gray",
                    "params": {
                        "x_range": [axis_start, axis_end],
                        "y_range": [y_start, y_end],
                    },
                },
                {
                    "id": "composition_inner",
                    "primitive": "function_curve",
                    "meaning": "内层函数：把自变量 x 变成中间量 u",
                    "label": f"u = {inner}",
                    "color": "blue",
                    "params": {
                        "expression": inner,
                        "variable": variable,
                        "x_range": [x_start, x_end],
                    },
                },
                {
                    "id": "composition_outer",
                    "primitive": "function_curve",
                    "meaning": "外层函数：把中间量 u 变成最终值 y，横轴读作 u",
                    "label": f"y = {outer}",
                    "color": "yellow",
                    "params": {
                        "expression": outer,
                        "variable": "u",
                        "x_range": u_range,
                    },
                },
                {
                    "id": "composition_result",
                    "primitive": "function_curve",
                    "meaning": "两步接起来的合成函数",
                    "label": f"y = {expression}",
                    "color": "green",
                    "params": {
                        "expression": expression,
                        "variable": variable,
                        "x_range": [x_start, x_end],
                    },
                },
                {
                    "id": "composition_chain",
                    "primitive": "composition_chain",
                    "meaning": "取几个 x，显示 x →(内层)→ u →(外层)→ y 的完整对应",
                    "label": "x → u → y",
                    "color": "green",
                    "params": {
                        "outer": outer,
                        "inner": inner,
                        "variable": variable,
                        "x_range": [x_start, x_end],
                        "u_range": u_range,
                        "samples": chain,
                    },
                },
                {
                    "id": "composition_check",
                    "primitive": "dot",
                    "meaning": "沿链条算出的 y 值，落在合成曲线上",
                    "label": "",
                    "color": "green",
                    "params": {"positions": check_points},
                },
            ],
            "scenes": [
                {
                    "role": "setup",
                    "anchor_zone": "A1-F6",
                    "key_objects": "坐标系与内层曲线",
                    "action": "建立坐标参照，先只画内层：x 走进去，出来的是中间量 u。",
                    "invariant": "内层表达式来自已验证 Math IR",
                    "attention_target": "内层曲线的高度就是中间量 u",
                    "exit_condition": "内层曲线清楚可见",
                    "teaching_line": f"第一步：x 先经过内层，得到中间量 u = {inner}。",
                    "duration_s": 6,
                    "actions": [
                        {
                            "op": "create",
                            "targets": ["composition_axes", "composition_inner"],
                            "result": "",
                            "meaning": "建立坐标参照并显示内层函数",
                        }
                    ],
                },
                {
                    "role": "transform",
                    "anchor_zone": "A1-F6",
                    "key_objects": "外层曲线",
                    "action": "把内层输出的 u 交给外层，横轴改读作 u，画出外层函数。",
                    "invariant": "外层作用的自变量正是内层的输出 u",
                    "attention_target": "外层曲线在 u 取值范围上的走势",
                    "exit_condition": "外层曲线取代内层曲线并可见",
                    "teaching_line": f"第二步：把中间量 u 交给外层，得到 y = {outer}。",
                    "duration_s": 7,
                    "actions": [
                        {
                            "op": "map",
                            "targets": ["composition_inner"],
                            "result": "composition_outer",
                            "meaning": "把内层输出作为外层的自变量",
                        }
                    ],
                },
                {
                    "role": "reveal",
                    "anchor_zone": "A1-F6",
                    "key_objects": "合成曲线与 x→u→y 链条",
                    "action": "把两步接起来，画出合成曲线并标出每个 x 的两级映射。",
                    "invariant": "链条上的 u 与 y 都由内外层真实取值算出",
                    "attention_target": "链条从 x 到 u 再到 y 的走向",
                    "exit_condition": "合成曲线与链条同屏可见",
                    "teaching_line": (
                        f"第三步：两步接起来就是 y = {expression}；"
                        f"例如 x = {_format_number(chain[0]['x'])} 时先变成 u = "
                        f"{_format_number(chain[0]['u'])}，再变成 y = "
                        f"{_format_number(chain[0]['y'])}。"
                    ),
                    "duration_s": 7,
                    "actions": [
                        {
                            "op": "transform",
                            "targets": ["composition_outer"],
                            "result": "composition_result",
                            "meaning": "把两级映射合成为一条曲线",
                        },
                        {
                            "op": "create",
                            "targets": ["composition_chain"],
                            "result": "",
                            "meaning": "标出 x→u→y 的对应关系",
                        },
                    ],
                },
                {
                    "role": "verify",
                    "anchor_zone": "A1-F6",
                    "key_objects": "链条终点与合成曲线",
                    "action": "把沿链条算出的点描到合成曲线上核对。",
                    "invariant": "两条路径（先内后外 / 直接合成）必须给出同一个值",
                    "attention_target": "链条终点是否落在合成曲线上",
                    "exit_condition": "描点与曲线同屏核对完成",
                    "teaching_line": "沿着 x→u→y 一路算出的点，正好落在合成曲线上。",
                    "duration_s": 6,
                    "actions": [
                        {
                            "op": "create",
                            "targets": ["composition_check"],
                            "result": "",
                            "meaning": "描出沿链条算得的函数值",
                        },
                        {
                            "op": "measure",
                            "targets": ["composition_result"],
                            "result": "",
                            "meaning": "量取合成曲线在这些位置的高度",
                        },
                        {
                            "op": "verify",
                            "targets": ["composition_check", "composition_result"],
                            "result": "",
                            "meaning": "核对两条路径给出同一结果",
                        },
                    ],
                },
            ],
            "forbidden": [
                "只画最终曲线而不显示内层与外层两步",
                "让外层曲线脱离内层实际输出的 u 取值范围",
            ],
        }
        accepted = _accepted_calculus_plan(plan, ctx, "calculus_composition")
        if accepted is not None:
            return accepted
    return None


# --------------------------------------------------------------------------
# Graph transformation constructor.
#
# "How does y = f(ax + b) come from y = f(x)?" is a core high-school reading of
# a function, and it had no drawable vocabulary at all: the question declares
# no operation a solver can execute, so every structural constructor abstained
# and the session fell through to generic quantity boxes.  Everything below is
# recomputed here — the linear inner map is measured from the expression, the
# horizontal shift is derived as b/a (the exact place students go wrong), and
# every plotted point is evaluated with the same safe runtime.  No number and
# no direction is copied from a model sentence.
# --------------------------------------------------------------------------

_GRAPH_TRANSFORM_INTENT_WORDS = (
    "平移",
    "左移",
    "右移",
    "上移",
    "下移",
    "伸缩",
    "压缩",
    "拉伸",
    "伸长",
    "缩短",
    "横坐标",
    "纵坐标",
    "变换",
    "图像",
    "图象",
    "翻折",
    "对称",
    "shift",
    "translate",
    "stretch",
    "compress",
    "transform",
    "graph",
)
# Operations whose output is another expression rather than a measured amount.
# ``solve`` is deliberately absent: an equation's roots are still a numeric
# story and the quantity/balance constructors legitimately own it.
_SYMBOLIC_MATH_OPS = {
    "differentiate",
    "integrate",
    "limit",
    "simplify",
    "expand",
    "factor",
    "series",
}
_TEXT_FUNCTION_CALL_RE = re.compile(
    r"(?:" + "|".join(_COMPOSITION_OUTER_FUNCTIONS) + r")\s*\([^()]*\)"
)
_TEXT_ASSIGNED_EXPRESSION_RE = re.compile(
    r"(?:(?<![A-Za-z0-9_])y|f\s*\(\s*[A-Za-z]\s*\))\s*=\s*([^\n]+)"
)
_EXPRESSION_CHARS_RE = re.compile(r"[A-Za-z0-9_+\-*/^(). ]+")


def _graph_transform_intent(ctx: ToolContext) -> bool:
    """Whether the asked question is about moving/scaling a graph at all."""
    text = " ".join(
        (
            str(ctx.problem or ""),
            str(ctx.state.get("solution_answer") or ""),
        )
    ).lower()
    return any(word.lower() in text for word in _GRAPH_TRANSFORM_INTENT_WORDS)


def _balanced_expression_prefix(text: str) -> str:
    """The longest parenthesis-balanced expression-shaped prefix of ``text``."""
    match = _EXPRESSION_CHARS_RE.match(text.strip())
    if match is None:
        return ""
    candidate = match.group(0)
    depth = 0
    end = 0
    for index, char in enumerate(candidate):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                break
        if depth == 0:
            end = index + 1
    return candidate[:end].strip().rstrip("+-*/^ ")


def _text_expression_candidates(text: str) -> list[str]:
    """Expression spellings literally present in prose, never invented ones.

    Only two shapes are read: an explicit ``y = …`` / ``f(x) = …`` assignment
    and a whole named-function call such as ``sin(2x+1)``.  Anything that does
    not survive the safe parser later is dropped, so a sentence that merely
    mentions mathematics contributes nothing.
    """
    found: list[str] = []
    for raw in _TEXT_ASSIGNED_EXPRESSION_RE.findall(text or ""):
        candidate = _balanced_expression_prefix(str(raw))
        if candidate:
            found.append(candidate)
    for raw in _TEXT_FUNCTION_CALL_RE.findall(text or ""):
        candidate = str(raw).strip()
        if candidate:
            found.append(candidate)
    return list(dict.fromkeys(found))


def _linear_inner_transform(
    expression: str, variable: str
) -> tuple[str, float, float] | None:
    """Read ``expression`` as ``base(a*variable + b)``, or return ``None``.

    The outer/inner split is structural (the same one the composition builder
    uses); ``a`` and ``b`` are then *measured* from the inner expression and
    re-checked at several points, so a non-linear inner map can never be
    mistaken for a translation or a scaling.
    """
    decomposed = _decompose_composition(expression, variable)
    if decomposed is None:
        return None
    outer, inner = decomposed
    intercept = _real_value_at(inner, variable, 0.0)
    at_one = _real_value_at(inner, variable, 1.0)
    if intercept is None or at_one is None:
        return None
    scale = at_one - intercept
    if abs(scale) < 1e-9:
        return None
    for probe in (-2.3, -0.7, 1.7, 3.1):
        actual = _real_value_at(inner, variable, probe)
        if actual is None or abs(actual - (scale * probe + intercept)) > 1e-7:
            return None
    scale = round(scale, 6)
    intercept = round(intercept, 6)
    if abs(scale - 1.0) < 1e-9 and abs(intercept) < 1e-9:
        return None
    base = re.sub(r"(?<![A-Za-z0-9_])u(?![A-Za-z0-9_])", variable, outer)
    if base == outer and "u" in outer:
        return None
    if _computable_expression(base, variable) is None:
        return None
    for probe in (-1.9, -0.4, 0.6, 2.2):
        composed = _real_value_at(expression, variable, probe)
        through_base = _real_value_at(base, variable, scale * probe + intercept)
        if composed is None or through_base is None:
            continue
        if abs(composed - through_base) > 1e-7:
            return None
    return (base, float(scale), float(intercept))


def _graph_transform_target(
    ctx: ToolContext,
) -> tuple[str, str, str, float, float] | None:
    """(expression, variable, base, a, b) for the graph this session moves.

    Math IR first, prose second.  Prose is only ever used as a *spelling*
    source: the candidate must still parse in the safe runtime and must still
    reduce to ``base(a*x + b)`` numerically before anything is drawn.
    """
    candidates: list[tuple[str, str]] = []
    for row in _verified_math_operations(ctx):
        variable = row["variable"] or "x"
        for raw in (row["expression"], row["result"]):
            text = str(raw or "").strip()
            if text:
                candidates.append((text, variable))
    prose = " ".join(
        (str(ctx.problem or ""), str(ctx.state.get("solution_answer") or ""))
    )
    for text in _text_expression_candidates(prose):
        candidates.append((text, "x"))
    for raw_expression, variable in dict.fromkeys(candidates):
        if not variable.isidentifier():
            continue
        expression = _computable_expression(raw_expression, variable)
        if expression is None:
            continue
        decomposed = _linear_inner_transform(expression, variable)
        if decomposed is None:
            continue
        base, scale, intercept = decomposed
        return (expression, variable, base, scale, intercept)
    return None


def _symbolic_function_evidence(ctx: ToolContext) -> bool:
    """Whether the verified evidence operates on a function, not on an amount.

    Conservative on purpose: only a symbolic operation whose expression still
    carries its *free* variable counts.  Once the variable has been given a
    value the evidence is again a concrete number and the quantity vocabulary
    may legitimately claim it.
    """
    for row in _verified_math_operations(ctx):
        if row["op"] not in _SYMBOLIC_MATH_OPS:
            continue
        variable = row["variable"] or "x"
        expression = row["expression"]
        if not expression or not variable.isidentifier():
            continue
        if not re.search(
            rf"(?<![A-Za-z0-9_]){re.escape(variable)}(?![A-Za-z0-9_])", expression
        ):
            continue
        if row["substitutions"].get(variable) is not None:
            continue
        return True
    return False


def _quantity_semantics_refused(ctx: ToolContext) -> bool:
    """Whether counting graphics would misrepresent this session outright.

    Quantity bars and unit boxes narrate "how many". When the verified
    evidence is a function being reshaped (a graph transformation asked in
    prose, or a symbolic operation still carrying a free variable), that
    vocabulary has nothing true to say, and drawing it anyway produces the
    empty "product" rectangles this guard exists to prevent.
    """
    if _graph_transform_intent(ctx) and _graph_transform_target(ctx) is not None:
        return True
    return _symbolic_function_evidence(ctx)


def _ratio_text(value: float) -> str:
    """A small exact fraction when there is one, otherwise a decimal."""
    for denominator in (1, 2, 3, 4, 5, 6, 8, 10, 12):
        numerator = value * denominator
        if abs(numerator - round(numerator)) < 1e-9:
            whole = int(round(numerator))
            return f"{whole}" if denominator == 1 else f"{whole}/{denominator}"
    return _format_number(value)


def _signed_ratio_text(value: float) -> str:
    """``+ 1/2`` / ``- 1/2``: a term that can be pasted into an expression."""
    sign = "-" if value < 0 else "+"
    return f"{sign} {_ratio_text(abs(value))}"


def _substitute_variable(text: str, variable: str, replacement: str) -> str:
    """Replace the free variable token only, never a letter inside a name."""
    return re.sub(
        rf"(?<![A-Za-z0-9_]){re.escape(variable)}(?![A-Za-z0-9_])", replacement, text
    )


def _substituted_label(text: str, variable: str, replacement: str) -> str:
    """The same substitution, spelled for a human reader.

    The replacement stays parenthesized so precedence survives (``x**2`` must
    read ``(2x)**2``, never ``2x**2``); only the doubled bracket a function
    call produces (``sin((2x))``) is flattened, and only in display text.
    """
    result = _substitute_variable(text, variable, f"({replacement})")
    index = 0
    while index < len(result) - 1:
        if result[index] == "(" and result[index + 1] == "(":
            close = _matching_parenthesis(result, index + 1)
            if close != -1 and close + 1 < len(result) and result[close + 1] == ")":
                result = result[:index] + result[index + 1 : close + 1] + result[close + 2 :]
                continue
        index += 1
    return result


def build_graph_transform_visual_plan(ctx: ToolContext) -> dict[str, Any] | None:
    """Show how y = f(ax + b) is built by moving the graph of y = f(x).

    The drawn route is *scale first, then slide*, because that is where the
    decisive subtlety lives: after the horizontal scaling the remaining slide
    is b/a, not b.  That number is computed here from the identity
    ``f(ax + b) = f(a(x + b/a))``, every curve is a real sample of a real
    expression, and each tracked point is carried across the two steps so the
    student sees which point went where.
    """
    if str(ctx.grade or "").startswith("elementary"):
        return None
    rows = _verified_math_operations(ctx)
    if any(row["op"] == "solve" for row in rows):
        # "Where does it vanish" is a different question about the same
        # expression; the zero-crossing argument owns that evidence.
        return None
    target = _graph_transform_target(ctx)
    if target is None:
        return None
    expression, variable, base, scale, intercept = target
    shift = round(intercept / scale, 6)
    scaled_expression = _substitute_variable(
        base, variable, f"(({_format_number(scale)})*{variable})"
    )
    if _computable_expression(scaled_expression, variable) is None:
        return None
    scaling = abs(round(scale, 6)) != 1.0 or scale < 0
    if scaling:
        for probe in (-1.4, 0.3, 1.9):
            direct = _real_value_at(scaled_expression, variable, probe)
            through_base = _real_value_at(base, variable, scale * probe)
            if direct is None or through_base is None:
                continue
            if abs(direct - through_base) > 1e-7:
                return None

    half_width = round(3.0 + abs(shift), 4)
    x_start, x_end = -half_width, half_width

    def _interval_of_base_window() -> tuple[float, float]:
        low = (x_start - intercept) / scale
        high = (x_end - intercept) / scale
        return (min(low, high), max(low, high))

    base_low, base_high = _interval_of_base_window()
    window_low = max(x_start, base_low, x_start - shift)
    window_high = min(x_end, base_high, x_end - shift)
    if window_high - window_low < 0.5:
        return None
    tracked: list[tuple[float, float, float, float]] = []
    for ratio in (0.2, 0.5, 0.8):
        final_x = round(window_low + (window_high - window_low) * ratio, 4)
        source_x = round(scale * final_x + intercept, 4)
        middle_x = round(final_x + shift, 4)
        height = _real_value_at(base, variable, source_x)
        if height is None:
            continue
        through_final = _real_value_at(expression, variable, final_x)
        if through_final is None or abs(through_final - height) > 1e-6:
            continue
        if scaling:
            through_middle = _real_value_at(scaled_expression, variable, middle_x)
            if through_middle is None or abs(through_middle - height) > 1e-6:
                continue
        tracked.append((source_x, middle_x, final_x, round(height, 4)))
    if len(tracked) < 2:
        return None

    sample_xs = _linear_space(x_start, x_end, 21)
    frame_values = [height for *_, height in tracked]
    for curve_expression in (
        [base, scaled_expression, expression] if scaling else [base, expression]
    ):
        points = _real_curve_points(curve_expression, variable, sample_xs)
        if len(points) < 8:
            return None
        frame_values.extend(point[1] for point in points)
    y_start, y_end = _value_frame(frame_values)
    curve_specs = (
        [base, scaled_expression, expression] if scaling else [base, expression]
    )
    if not all(
        _curve_is_drawable(item, variable, x_start, x_end, y_start, y_end)
        for item in curve_specs
    ):
        return None

    direction = "左" if shift > 0 else "右"
    shift_text = _ratio_text(abs(shift))
    intercept_text = _ratio_text(abs(intercept))
    scale_text = _ratio_text(scale)
    factor_text = _ratio_text(abs(1.0 / scale))
    flip_text = "并关于 y 轴翻折" if scale < 0 else ""
    stretch_word = "压缩" if abs(scale) > 1 else "拉伸"
    # ``f(ax + b) = f(a(x + b/a))``: the identity the whole beat turns on,
    # spelled out with the *computed* shift so the picture and the sentence
    # can never disagree about which number moves the graph.
    scaled_label = _substituted_label(base, variable, f"{scale_text}{variable}")
    inner_shift_label = _substituted_label(
        base, variable, f"{scale_text}({variable} {_signed_ratio_text(shift)})"
    )
    slide_first_label = _substituted_label(
        base, variable, f"{variable} {_signed_ratio_text(intercept)}"
    )
    argument_label = f"{scale_text}{variable} {_signed_ratio_text(intercept)}"

    objects: list[dict[str, Any]] = [
        {
            "id": "graph_transform_axes",
            "primitive": "axes",
            "meaning": "基本函数与变换后函数共用的同一坐标参照",
            "label": "",
            "color": "gray",
            "params": {
                "x_range": [x_start, x_end],
                "y_range": [y_start, y_end],
            },
        },
        {
            "id": "graph_transform_base",
            "primitive": "function_curve",
            "meaning": "变换的起点：基本函数的图像",
            "label": f"y = {base}",
            "color": "blue",
            "params": {
                "expression": base,
                "variable": variable,
                "x_range": [x_start, x_end],
            },
        },
        {
            "id": "graph_transform_base_points",
            "primitive": "dot",
            "meaning": "基本函数曲线上被全程跟踪的代表点",
            "label": "",
            "color": "blue",
            "params": {
                "positions": [[source_x, height] for source_x, _, _, height in tracked]
            },
        },
    ]
    if scaling:
        objects.append(
            {
                "id": "graph_transform_scaled",
                "primitive": "function_curve",
                "meaning": (
                    f"只做横向{stretch_word}后的中间图像：横坐标变为原来的 {factor_text}"
                ),
                "label": f"y = {scaled_label}",
                "color": "yellow",
                "params": {
                    "expression": scaled_expression,
                    "variable": variable,
                    "x_range": [x_start, x_end],
                    "scale": scale,
                },
            }
        )
        objects.append(
            {
                "id": "graph_transform_scaled_points",
                "primitive": "dot",
                "meaning": "同一批代表点在中间曲线上的位置，纵坐标不变",
                "label": "",
                "color": "yellow",
                "params": {
                    "positions": [
                        [middle_x, height] for _, middle_x, _, height in tracked
                    ]
                },
            }
        )
    objects.append(
        {
            "id": "graph_transform_result",
            "primitive": "function_curve",
            "meaning": "变换终点：题目给出的函数图像",
            "label": f"y = {expression}",
            "color": "green",
            "params": {
                "expression": expression,
                "variable": variable,
                "x_range": [x_start, x_end],
                "scale": scale,
                "shift": shift,
            },
        }
    )
    objects.append(
        {
            "id": "graph_transform_result_points",
            "primitive": "dot",
            "meaning": "代表点最终落在结果曲线上的位置",
            "label": "",
            "color": "green",
            "params": {
                "positions": [[final_x, height] for _, _, final_x, height in tracked],
                "shift": shift,
            },
        }
    )
    suffixes = ("a", "b", "c")
    scale_arrow_ids: list[str] = []
    slide_arrow_ids: list[str] = []
    for index, (source_x, middle_x, final_x, height) in enumerate(tracked):
        suffix = suffixes[index] if index < len(suffixes) else f"p{index}"
        # A fixed point (the scaling centre, or a point the slide happens to
        # return) really does not move; drawing a zero-length arrow there
        # would claim a displacement that the mathematics denies.
        if scaling and abs(middle_x - source_x) > 1e-6:
            arrow_id = f"graph_transform_squeeze_{suffix}"
            scale_arrow_ids.append(arrow_id)
            objects.append(
                {
                    "id": arrow_id,
                    "primitive": "arrow",
                    "meaning": (
                        f"横坐标 {_format_number(source_x)} → "
                        f"{_format_number(middle_x)}，高度保持 "
                        f"{_format_number(height)}"
                    ),
                    "label": "",
                    "color": "yellow",
                    "params": {
                        "start": [source_x, height],
                        "end": [middle_x, height],
                    },
                }
            )
        slide_from = middle_x if scaling else source_x
        if abs(final_x - slide_from) <= 1e-6:
            continue
        arrow_id = f"graph_transform_slide_{suffix}"
        slide_arrow_ids.append(arrow_id)
        objects.append(
            {
                "id": arrow_id,
                "primitive": "arrow",
                "meaning": (
                    f"整体向{direction}平移 {shift_text}：横坐标 "
                    f"{_format_number(slide_from)} → {_format_number(final_x)}"
                ),
                "label": "",
                "color": "green",
                "params": {
                    "start": [slide_from, height],
                    "end": [final_x, height],
                    "shift": shift,
                },
            }
        )

    scenes: list[dict[str, Any]] = [
        {
            "role": "setup",
            "anchor_zone": "A1-F6",
            "key_objects": "坐标系、基本函数曲线与三个代表点",
            "action": "建立坐标参照，画出基本函数并标出几个被全程跟踪的点。",
            "invariant": "基本函数表达式全片不变，代表点的纵坐标始终是它的函数值",
            "attention_target": f"曲线 y = {base} 上被标记的代表点",
            "exit_condition": "基本函数曲线与代表点同屏可见",
            "teaching_line": (
                f"先看出发点：y = {base} 的图像。"
                f"在它上面盯住几个点，接下来看它们各自跑到哪里去。"
            ),
            "duration_s": 6,
            "actions": [
                {
                    "op": "create",
                    "targets": [
                        "graph_transform_axes",
                        "graph_transform_base",
                        "graph_transform_base_points",
                    ],
                    "result": "",
                    "meaning": "建立坐标参照与被跟踪的代表点",
                }
            ],
        }
    ]
    if scaling:
        scenes.append(
            {
                "role": "transform",
                "anchor_zone": "A1-F6",
                "key_objects": "横向伸缩中的曲线与代表点",
                "action": (
                    f"把每个点的横坐标变为原来的 {factor_text}，纵坐标保持不变，"
                    f"曲线整体横向{stretch_word}。"
                ),
                "invariant": "每个代表点的纵坐标不变，只有横坐标被同一个倍数改写",
                "attention_target": "代表点沿水平方向移动的距离",
                "exit_condition": f"中间曲线 y = {scaled_label} 与新点位同屏可见",
                "teaching_line": (
                    f"第一步只做横向{stretch_word}：把 {variable} 换成 "
                    f"{scale_text}{variable}，得到 y = {scaled_label}；"
                    f"每个点的横坐标变成原来的 {factor_text}，高度一点没变{flip_text}。"
                ),
                "duration_s": 7,
                "actions": [
                    {
                        "op": "transform",
                        "targets": ["graph_transform_base"],
                        "result": "graph_transform_scaled",
                        "meaning": "把基本函数横向伸缩成中间曲线",
                    },
                    {
                        "op": "create",
                        "targets": [
                            "graph_transform_scaled_points",
                            *scale_arrow_ids,
                        ],
                        "result": "",
                        "meaning": "显示每个代表点横坐标的真实去向",
                    },
                ],
            }
        )
    scenes.append(
        {
            "role": "transform",
            "anchor_zone": "A1-F6",
            "key_objects": "整体平移中的曲线与代表点",
            "action": (
                f"把整条曲线沿横轴向{direction}平移 {shift_text} 个单位，形状不变。"
            ),
            "invariant": "平移不改变曲线形状，只改变它在横轴上的位置",
            "attention_target": f"平移量 {shift_text} 对应的水平位移",
            "exit_condition": "结果曲线与代表点的最终位置同屏可见",
            "teaching_line": (
                (
                    f"第二步向{direction}平移 {shift_text} 个单位。"
                    f"为什么平移量是 b ÷ a = {intercept_text} ÷ "
                    f"{_ratio_text(abs(scale))} = {shift_text}，而不是 b = "
                    f"{intercept_text}？因为 {expression} = {inner_shift_label}："
                    f"括号里对 {variable} 的平移量本来就是 {shift_text}，"
                    f"横坐标此刻已经被{stretch_word}成原来的 {factor_text}，"
                    f"平移量当然要跟着除以 {_ratio_text(abs(scale))}。"
                    f"等价的另一条路是先向{direction}平移 {intercept_text} 个单位"
                    f"得到 y = {slide_first_label}，再横向{stretch_word}，"
                    f"结果同样是 {expression}。"
                )
                if scaling
                else (
                    f"把整条曲线向{direction}平移 {shift_text} 个单位，"
                    f"每个点的横坐标都加了同一个数，形状完全没变。"
                )
            ),
            "duration_s": 8,
            "actions": [
                {
                    "op": "transform",
                    "targets": [
                        "graph_transform_scaled" if scaling else "graph_transform_base"
                    ],
                    "result": "graph_transform_result",
                    "meaning": "把中间曲线整体平移到结果位置",
                },
                {
                    "op": "create",
                    "targets": [
                        "graph_transform_result_points",
                        *slide_arrow_ids,
                    ],
                    "result": "",
                    "meaning": "显示平移后每个代表点的落点",
                },
            ],
        }
    )
    scenes.append(
        {
            "role": "verify",
            "anchor_zone": "A1-F6",
            "key_objects": "结果曲线与落点",
            "action": "逐点核对：变换后的落点是否正好落在题目函数的图像上。",
            "invariant": "每个落点的纵坐标始终等于最初那个点的函数值",
            "attention_target": "落点与结果曲线是否重合",
            "exit_condition": "落点与结果曲线在同屏完成核对",
            "teaching_line": (
                f"核对一下：横坐标 {_format_number(tracked[0][2])} 处，"
                f"y = {expression} 的值是 {_format_number(tracked[0][3])}，"
                f"正是出发点 {variable} = {_format_number(tracked[0][0])} 时的高度——"
                "点没有被改高度，只是被搬了位置。"
            ),
            "duration_s": 6,
            "actions": [
                {
                    "op": "measure",
                    "targets": ["graph_transform_result_points"],
                    "result": "",
                    "meaning": "读出落点的坐标",
                },
                {
                    "op": "compare",
                    "targets": [
                        "graph_transform_result",
                        "graph_transform_result_points",
                    ],
                    "result": "",
                    "meaning": "比较落点与结果曲线的位置",
                },
                {
                    "op": "verify",
                    "targets": [
                        "graph_transform_result",
                        "graph_transform_result_points",
                    ],
                    "result": "",
                    "meaning": "确认落点确实在结果曲线上",
                },
            ],
        }
    )

    plan = {
        "visual_thesis": (
            f"盯住 y = {base} 上的几个点，看它们先被横向{stretch_word}、"
            f"再整体平移 {shift_text} 个单位，最后落到 y = {expression} 上。"
        ),
        "essence_rationale": (
            f"因为 {expression} 就是把 {variable} 换成 {argument_label} 的结果，"
            f"而 {expression} = {inner_shift_label}，所以它等价于先横向伸缩、"
            f"再平移 b ÷ a = {shift_text}；学生看到每个代表点的高度自始至终没变、"
            "只有横坐标被改写，就明白图像变换是对自变量做替换，"
            f"平移量因此要除以伸缩倍数，而不是照抄 {intercept_text}。"
        ),
        "symbol_ledger": [
            f"蓝色曲线与蓝点 = 出发的基本函数 y = {base} 及其代表点",
            (
                f"黄色曲线与黄点 = 只做横向{stretch_word}后的中间状态"
                if scaling
                else f"黄色箭头 = 每个代表点的水平位移 {shift_text}"
            ),
            f"绿色曲线与绿点 = 结果函数 y = {expression} 及代表点的落点",
            "箭头 = 同一个点在每一步中横坐标的真实去向（纵坐标不变）",
        ],
        "visual_objects": objects,
        "scenes": scenes,
        "forbidden": [
            "只写出平移伸缩的结论而不显示点的真实位移",
            f"把平移量画成 {intercept_text} 而不是 b/a = {shift_text}",
        ],
    }
    return _accepted_calculus_plan(plan, ctx, "graph_transform")


def ground_visual_plan_from_math_execution(
    plan: dict[str, Any], ctx: ToolContext
) -> dict[str, Any]:
    """Make drawable geometry agree with already verified Math IR.

    This is deliberately driven by executable operation semantics rather than
    natural-language problem labels. Whenever a verified 2×2 linear map is
    followed by a polygon transform, the mapped vertices and basis vectors are
    fully determined. The director may choose the story and styling, but it
    may not invent those coordinates.
    """
    request = ctx.state.get("verify_math_request") or ctx.state.get("solve_math_request")
    evidence = ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence")
    if not isinstance(request, dict) or not isinstance(evidence, dict):
        return plan
    if not evidence.get("success") or evidence.get("all_claims_passed") is not True:
        return plan

    result_by_id = {
        str(item.get("id")): item.get("result")
        for item in evidence.get("operations") or []
        if isinstance(item, dict) and item.get("id")
    }

    def finite_number(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None

    matrix_contracts: list[tuple[list[list[float]], float]] = []
    for operation in request.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        if str(operation.get("op") or "").lower() != "determinant":
            continue
        expression = operation.get("expression")
        if (
            not isinstance(expression, list)
            or len(expression) != 2
            or not all(isinstance(row, list) and len(row) == 2 for row in expression)
        ):
            continue
        flattened = [finite_number(value) for row in expression for value in row]
        determinant = finite_number(result_by_id.get(str(operation.get("id") or "")))
        if determinant is None or any(value is None for value in flattened):
            continue
        a, b, c, d = (float(value) for value in flattened if value is not None)
        matrix_contracts.append(([[a, b], [c, d]], determinant))
    if len(matrix_contracts) != 1:
        return plan

    matrix, determinant = matrix_contracts[0]
    objects = {
        str(item.get("id")): item
        for item in plan.get("visual_objects") or []
        if isinstance(item, dict) and item.get("id")
    }
    transforms: list[tuple[dict[str, Any], str, str]] = []
    for scene in plan.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        for action in scene.get("actions") or []:
            if not isinstance(action, dict) or action.get("op") != "transform":
                continue
            targets = [str(item) for item in action.get("targets") or []]
            result_id = str(action.get("result") or "")
            source_id = next(
                (
                    item
                    for item in targets
                    if (objects.get(item) or {}).get("primitive") == "polygon"
                ),
                "",
            )
            if (
                source_id
                and result_id
                and (objects.get(result_id) or {}).get("primitive") == "polygon"
            ):
                transforms.append((scene, source_id, result_id))
    if len(transforms) != 1:
        return plan

    transform_scene, source_id, result_id = transforms[0]
    source = objects[source_id]
    result = objects[result_id]
    source_vertices = (source.get("params") or {}).get("vertices")
    if (
        not isinstance(source_vertices, list)
        or len(source_vertices) < 3
        or not all(isinstance(point, list) and len(point) >= 2 for point in source_vertices)
    ):
        return plan

    mapped_vertices: list[list[float]] = []
    for point in source_vertices:
        x = finite_number(point[0])
        y = finite_number(point[1])
        if x is None or y is None:
            return plan
        mapped_vertices.append(
            [
                matrix[0][0] * x + matrix[0][1] * y,
                matrix[1][0] * x + matrix[1][1] * y,
            ]
        )
    result_params = result.get("params") or {}
    old_vertices = result_params.get("vertices")
    result_params["vertices"] = mapped_vertices
    result_params["verified_measure"] = abs(determinant)
    result["params"] = result_params

    existing_ids = set(objects)
    arrow_ids: list[str] = []
    for index, endpoint in enumerate(
        ([matrix[0][0], matrix[1][0]], [matrix[0][1], matrix[1][1]]),
        start=1,
    ):
        existing_arrow_id = next(
            (
                object_id
                for object_id, item in objects.items()
                if object_id not in arrow_ids
                and item.get("primitive") == "arrow"
                and (item.get("params") or {}).get("start") == [0, 0]
                and (item.get("params") or {}).get("end") == endpoint
            ),
            "",
        )
        if existing_arrow_id:
            arrow_ids.append(existing_arrow_id)
            continue
        base = f"verified_basis_{index}"
        arrow_id = base
        suffix = 2
        while arrow_id in existing_ids:
            arrow_id = f"{base}_{suffix}"
            suffix += 1
        existing_ids.add(arrow_id)
        arrow_ids.append(arrow_id)
        arrow = {
            "id": arrow_id,
            "primitive": "arrow",
            "meaning": f"已验证线性映射的第 {index} 个列向量",
            "label": f"e{index} → ({endpoint[0]:g}, {endpoint[1]:g})",
            "color": "yellow" if index == 1 else "green",
            "params": {"start": [0, 0], "end": endpoint},
        }
        plan["visual_objects"].append(arrow)
        objects[arrow_id] = arrow
    transform_actions = transform_scene.get("actions") or []
    transform_actions.insert(
        0,
        {
            "op": "create",
            "targets": arrow_ids,
            "result": "",
            "meaning": "先显示由已验证矩阵列决定的两个基向量",
        },
    )
    transform_scene["actions"] = transform_actions

    # A scalar conclusion that merely repeats the measured polygon is not a
    # second visual proof. Remove that decorative bar and let the renderer
    # compute and display the polygon's coordinate area at the measure action.
    redundant_ids = {
        object_id
        for object_id, item in objects.items()
        if object_id not in {source_id, result_id, *arrow_ids}
        and item.get("primitive") == "quantity_bar"
        and finite_number((item.get("params") or {}).get("value")) is not None
        and math.isclose(
            float((item.get("params") or {}).get("value")),
            abs(determinant),
            rel_tol=1e-9,
            abs_tol=1e-9,
        )
    }
    if redundant_ids:
        plan["visual_objects"] = [
            item
            for item in plan.get("visual_objects") or []
            if str(item.get("id")) not in redundant_ids
        ]
        for scene in plan.get("scenes") or []:
            if not isinstance(scene, dict):
                continue
            kept_actions = []
            for action in scene.get("actions") or []:
                if not isinstance(action, dict):
                    continue
                action["targets"] = [
                    item for item in action.get("targets") or [] if str(item) not in redundant_ids
                ]
                if action.get("targets") or action.get("result"):
                    kept_actions.append(action)
            scene["actions"] = kept_actions

    adjustments = plan.setdefault("math_grounding_adjustments", [])
    if old_vertices != mapped_vertices:
        adjustments.append(f"{result_id} 顶点已由已验证 2×2 线性映射重新计算")
    adjustments.append("基向量端点已由已验证矩阵列生成")
    if redundant_ids:
        adjustments.append("删除了与确定性面积测量重复的装饰性数量条")
    plan["grounded_from_math_execution"] = True
    return _normalize_plan(plan)


def build_safe_visual_plan(candidate: Any, ctx: ToolContext) -> dict[str, Any] | None:
    """Keep valid graphical objects while discarding an unsafe directing story.

    The plan is composed from Visual IR primitives plus the independently
    verified solution. It does not infer or enumerate a problem type.
    """
    if not isinstance(candidate, dict):
        candidate = _verified_arithmetic_candidate(ctx)
        if candidate is None:
            return None
    elif candidate.get("grounding_source") != "verified_solution_arithmetic":
        # This function is reached only after the model plan failed its
        # contract. Prefer a complete chain reconstructed from verified steps
        # over salvaging attractive but semantically ungrounded objects (such
        # as an arrow or a pan that merely happens to lead to an answer label).
        verified_candidate = _verified_arithmetic_candidate(ctx)
        if verified_candidate is not None:
            candidate = verified_candidate
    if (
        isinstance(candidate, dict)
        and candidate.get("grounding_source") == "verified_solution_arithmetic"
    ):
        # The verified-arithmetic chain is already a complete canonical plan
        # authored in quantity verbs; deconstructing it into generic
        # transitions would strip take_from/count parameters and reintroduce
        # the destroy-and-redraw representation. Validate and use it as-is.
        arithmetic_errors = _validate_plan(candidate, ctx.grade)
        if not arithmetic_errors:
            return candidate
        logger.warning(
            "verified arithmetic plan failed validation, falling back to "
            "generic salvage: %s",
            arithmetic_errors[:3],
        )
    normalized = _normalize_plan(candidate)
    # Salvage keeps drawings, but never a fabricated one.  A curve computed
    # from a real expression is worth preserving; the "tangent" whose slope the
    # mathematics contradicts is dropped here, so the degraded plan shows the
    # true curve and says less, instead of showing a false picture.
    fabricated = _geometrically_false_object_ids(normalized)
    if fabricated:
        logger.warning("dropping geometrically false objects from salvage: %s", sorted(fabricated))
    objects = [
        item
        for item in (normalized.get("visual_objects") or [])
        if isinstance(item, dict)
        and item.get("id")
        and item.get("primitive") in _VISUAL_PRIMITIVES
        and item.get("meaning")
        and str(item.get("id")) not in fabricated
    ]
    if len(objects) < 2:
        # Never recurse when we already hold the verified-arithmetic candidate:
        # _verified_arithmetic_candidate builds a fresh dict on every call, so
        # an identity check cannot break the cycle and salvage would loop
        # forever on the same unusable plan.
        if candidate.get("grounding_source") == "verified_solution_arithmetic":
            return None
        verified_candidate = _verified_arithmetic_candidate(ctx)
        if verified_candidate is None:
            return None
        return build_safe_visual_plan(verified_candidate, ctx)
    object_ids = [str(item["id"]) for item in objects]
    object_by_id = {str(item["id"]): item for item in objects}

    def repeated_count(object_id: str) -> int:
        params = object_by_id[object_id].get("params") or {}
        try:
            value = int(round(float(params.get("count") or 0)))
        except (TypeError, ValueError):
            return 0
        return value if 1 < value <= 64 else 0

    answer = _strip_decorations(str(ctx.state.get("solution_answer") or "已验证结论"))
    answer_numbers = [float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", answer)]
    answer_object_id: str | None = None
    answer_value: float | None = answer_numbers[-1] if answer_numbers else None
    if answer_value is not None:
        for object_id in reversed(object_ids):
            item = object_by_id[object_id]
            label_numbers = [
                float(value)
                for value in re.findall(r"-?\d+(?:\.\d+)?", str(item.get("label") or ""))
            ]
            params = item.get("params") or {}
            try:
                param_value = float(params.get("value"))
            except (TypeError, ValueError):
                param_value = None
            # A verification formula such as ``2(4)+5=13`` mentions the
            # answer but is not an addressable answer state. Accept a label
            # only when it denotes one numeric value; structured objects can
            # also ground the answer explicitly through params.value.
            if (
                len(label_numbers) == 1 and label_numbers[0] == answer_value
            ) or param_value == answer_value:
                answer_object_id = object_id
                break
    if (
        answer_object_id is None
        and candidate.get("grounding_source") != "verified_solution_arithmetic"
    ):
        # Escalate to the verified-arithmetic chain at most once (recursion
        # depth <= 1). If that chain itself lacks an addressable answer state
        # we fall through to generic salvage instead of recursing forever.
        verified_candidate = _verified_arithmetic_candidate(ctx)
        if verified_candidate is not None:
            return build_safe_visual_plan(verified_candidate, ctx)

    # Preserve every causal transition that survived parsing. Keeping only
    # the first one used to truncate multi-step arguments (for example, an
    # intermediate quantity was shown but never transformed into the verified
    # answer). If the model omitted all actions, derive one solely from
    # addressable visual objects. This is Visual-IR continuity, not a topic
    # or problem-archetype branch.
    transitions: list[dict[str, Any]] = []
    preserved_comparisons: list[dict[str, Any]] = []
    for scene in normalized.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        for action in scene.get("actions") or []:
            if not isinstance(action, dict):
                continue
            targets = [item for item in action.get("targets") or [] if item in object_by_id]
            result = str(action.get("result") or "")
            if action.get("op") == "compare" and len(targets) >= 2:
                comparison = {
                    "op": "compare",
                    "targets": targets,
                    "result": "",
                    "meaning": action.get("meaning") or "把已验证数量放在同一参照下直接比较",
                }
                if comparison not in preserved_comparisons:
                    preserved_comparisons.append(comparison)
            if (
                action.get("op") in {"transform", "partition", "map"}
                and targets
                and result in object_by_id
                and result not in targets
            ):
                transitions.append(
                    {
                        "op": action["op"],
                        "targets": targets,
                        "result": result,
                        "meaning": action.get("meaning") or "显示来源对象如何产生结果对象",
                    }
                )

    repeated_ids = [item for item in object_ids if repeated_count(item)]
    if not transitions:
        if len(repeated_ids) >= 2:
            source_id = max(repeated_ids, key=repeated_count)
            result_id = min(
                (item for item in repeated_ids if item != source_id),
                key=repeated_count,
            )
        else:
            non_axes = [
                item for item in object_ids if object_by_id[item].get("primitive") != "axes"
            ]
            if len(non_axes) < 2:
                return None
            source_id, result_id = non_axes[0], non_axes[-1]
        transitions = [
            {
                "op": "transform",
                "targets": [source_id],
                "result": result_id,
                "meaning": "让来源图形逐步变为已验证关系中的结果图形",
            }
        ]

    if answer_object_id is not None and transitions[-1]["result"] != answer_object_id:
        previous_result = str(transitions[-1]["result"])
        if transitions[-1]["op"] == "partition":
            transitions[-1] = {**transitions[-1], "result": answer_object_id}
        else:
            transitions.append(
                {
                    "op": "transform",
                    "targets": [previous_result],
                    "result": answer_object_id,
                    "meaning": "把最后一个已验证中间状态变为题目所求结果",
                }
            )
        if answer_value is not None and answer_value.is_integer() and 1 < answer_value <= 64:
            answer_params = object_by_id[answer_object_id].get("params") or {}
            try:
                current_count = int(round(float(answer_params.get("count") or 0)))
            except (TypeError, ValueError):
                current_count = 0
            if current_count <= 1:
                answer_params["count"] = int(answer_value)
                object_by_id[answer_object_id]["params"] = answer_params

    setup_ids: list[str] = []
    produced_ids: set[str] = set()
    for transition in transitions:
        for target in transition["targets"]:
            if target not in produced_ids and target not in setup_ids:
                setup_ids.append(target)
        produced_ids.add(str(transition["result"]))
    for comparison in preserved_comparisons:
        for target in comparison["targets"]:
            if target not in produced_ids and target not in setup_ids:
                setup_ids.append(target)
    source_ids = list(setup_ids)
    result_id = str(transitions[-1]["result"])

    # A pair of scalar magnitudes supplies a stable visible comparison before
    # the collection changes. The compiler derives the exact difference and
    # only displays a division formula when another declared relation closes
    # it exactly, so no new mathematical claim is invented here.
    scalar_ids = []
    for item in object_ids:
        params = object_by_id[item].get("params") or {}
        try:
            value = float(params.get("value"))
        except (TypeError, ValueError):
            continue
        if value >= 0 and item not in setup_ids and item not in produced_ids:
            scalar_ids.append(item)
    comparison_ids = scalar_ids[:2] if len(scalar_ids) >= 2 else []
    for item in comparison_ids:
        if item not in setup_ids:
            setup_ids.append(item)

    transform_actions: list[dict[str, Any]] = list(preserved_comparisons)
    if comparison_ids and not preserved_comparisons:
        transform_actions.append(
            {
                "op": "compare",
                "targets": comparison_ids,
                "result": "",
                "meaning": "先把两个已验证数量的差异直接标在同一画面",
            }
        )
    transform_actions.extend(transitions)

    verify_ids = [result_id]
    source_count = repeated_count(source_ids[0]) if len(source_ids) == 1 else 0
    result_count = repeated_count(result_id)
    companion_id = next(
        (
            item
            for item in repeated_ids
            if item not in {*source_ids, result_id}
            and source_count > 0
            and repeated_count(item) + result_count == source_count
        ),
        None,
    )
    if companion_id is not None:
        verify_ids.append(companion_id)
    elif comparison_ids:
        verify_ids.append(comparison_ids[-1])
    verify_creates = [item for item in verify_ids if item not in setup_ids and item != result_id]
    steps = ctx.state.get("solution_steps") or []
    verified_line = "观察图形对象如何在共同参照中建立已验证关系。"
    if steps and isinstance(steps[0], dict):
        step = steps[0]
        verified_line = _strip_decorations(
            str(step.get("description") or step.get("result") or verified_line)
        )[:80]
    ledger = [
        f"{item.get('color') or 'blue'} {item['id']} = {item['meaning']}" for item in objects[:4]
    ]
    plan = {
        "visual_thesis": "让题目中的数学对象在共同参照中逐步出现，并由图形关系核对已验证结论",
        "essence_rationale": (
            "学生先看到题目对象和共同参照，再看到由已验证解答确定的结果对象，"
            "最后直接在同一画面核对对象之间的对应与不变量。"
        ),
        "symbol_ledger": ledger,
        "visual_objects": objects,
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(setup_ids),
                "action": "建立承载题目关系的共同视觉参照。",
                "invariant": "题目条件和对象含义保持不变",
                "attention_target": "共同参照及其数学含义",
                "exit_condition": "共同参照在画面中清晰可见",
                "teaching_line": "先建立题目中所有对象共用的参照。",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "create",
                        "targets": setup_ids,
                        "result": "",
                        "meaning": "建立共同视觉参照",
                    }
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(
                    dict.fromkeys(
                        [
                            *source_ids,
                            *(str(item["result"]) for item in transitions),
                        ]
                    )
                ),
                "action": "在同一参照中展示来源对象到结果对象的决定性变化。",
                "invariant": "图形参数来自题目与已验证解答，不改变其数学含义",
                "attention_target": "来源集合中实际发生变化并产生结果的单位",
                "exit_condition": "决定性图形关系完整可见",
                "teaching_line": verified_line,
                "duration_s": 7,
                "actions": transform_actions,
            },
            {
                "role": "verify",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(verify_ids),
                "action": "保留图形证据并核对已验证答案。",
                "invariant": "所有题目条件同时成立",
                "attention_target": "结果对象与原条件的共同满足关系",
                "exit_condition": "学生能从图形直接定位并核对结论",
                "teaching_line": f"最后在图形中核对：{answer}"[:100],
                "duration_s": 5,
                "actions": [
                    *(
                        [
                            {
                                "op": "create",
                                "targets": verify_creates,
                                "result": "",
                                "meaning": "补全与结果共同满足原条件的图形对象",
                            }
                        ]
                        if verify_creates
                        else []
                    ),
                    {
                        "op": "verify",
                        "targets": verify_ids,
                        "result": "",
                        "meaning": "用结果对象核对已验证结论",
                    },
                ],
            },
        ],
        "forbidden": ["用文字页替代图形关系", "改变题目对象的数学含义"],
        "safe_plan_from_verified_objects": True,
    }
    plan = _normalize_plan(plan)
    return plan if not _validate_plan(plan, ctx.grade) else None


def store_visual_plan(ctx: ToolContext, plan: dict[str, Any]) -> None:
    """Install an accepted plan and invalidate artifacts derived from an older plan."""
    plan.setdefault("plan_version", 2)
    ctx.state["visual_plan_last_violations"] = []
    ctx.state["visual_plan"] = plan
    ctx.state["visual_thesis"] = plan["visual_thesis"]
    ctx.state["visual_pattern"] = plan["visual_thesis"]
    ctx.state["essence_rationale"] = plan.get("essence_rationale") or ""
    ctx.state["last_visual_failed"] = False
    ctx.state.pop("force_visual_replan", None)
    ctx.state.pop("visual_local_fix_attempted", None)
    for key in (
        "latest_manim_code",
        "latest_video_path",
        "latest_video_url",
        "last_visual_review",
        "last_validation_issues",
        "last_validation_passed",
        "last_run_error",
        "last_visual_issues",
        "last_inspect_payload",
        "last_error_source",
        "fix_attempt_count",
        "last_fix_scope",
        "quality_degraded",
        "delivery_warning",
        "delivery_fallback",
        "delivery_fallback_reason",
    ):
        ctx.state.pop(key, None)


def _declared_count(item: dict[str, Any] | None) -> int | None:
    """Unit count declared by a count-bearing object (unit_grid etc.)."""
    if not isinstance(item, dict):
        return None
    params = item.get("params") or {}
    raw = params.get("count")
    if isinstance(raw, bool) or raw is None:
        return None
    try:
        return int(round(float(raw)))
    except (TypeError, ValueError):
        return None


_MEMBER_SERIES_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*?)_(\d+)$")


_MEMBER_UNIT_PRIMITIVES = {"dot", "circle", "rectangle", "line", "arrow", "polygon"}


def _member_series_violations(visual_objects: list[Any]) -> list[str]:
    """Steer per-member declarations (apple_1..apple_5) toward count groups.

    Individually declared members disconnect the unit machinery (repeat_units,
    take_from ledger), so quantity verbs cannot engage.  Only interchangeable
    units count as a series: same primitive with no distinguishing params.
    Distinct quantities that happen to share an id prefix (verified_value_0,
    verified_value_1 with different counts) are legitimate.
    """
    series: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in visual_objects:
        if not isinstance(item, dict):
            continue
        primitive = str(item.get("primitive") or "")
        if primitive not in _MEMBER_UNIT_PRIMITIVES:
            continue
        match = _MEMBER_SERIES_RE.fullmatch(str(item.get("id") or ""))
        if match:
            series.setdefault((match.group(1), primitive), []).append(item)
    violations: list[str] = []
    for (prefix, _primitive), members in series.items():
        if len(members) < 3:
            continue
        first_params = json.dumps(members[0].get("params") or {}, sort_keys=True)
        if all(
            json.dumps(item.get("params") or {}, sort_keys=True) == first_params
            for item in members[1:]
        ):
            violations.append(
                f"成员逐个声明：{prefix}_* 共 {len(members)} 个同质对象应改为一个带 "
                f"params.count={len(members)} 的计数组对象（如 unit_grid），"
                "数量动词才能逐单位执行"
            )
    return violations


# --------------------------------------------------------------------------
# Geometric truth gate
#
# Structural validation above proves a plan is well formed; it cannot prove
# the drawing is true.  A plan may declare a curve, mark a point that lies on
# neither curve, and label a horizontal segment "tangent" where the real slope
# is 0.878 — every field present, every id resolved, and a child who reads the
# slope learns something false.  The checks below recompute each geometric
# claim from the very expression the plan carries, using the whitelisted SymPy
# runtime (never eval).  They are source-agnostic: a deterministic constructor
# and an LLM draft are held to the same standard.
#
# Asymmetry is deliberate: a claim that cannot be recomputed (unparsable
# expression, undefined value) is skipped, never reported.  The gate only ever
# fires on geometry it has actually contradicted.
# --------------------------------------------------------------------------

_ON_CURVE_HINTS = (
    "曲线",
    "曲線",
    "图像",
    "图象",
    "函数上",
    "切点",
    "交点",
    "curve",
    "graph",
    "tangency",
    "intersection",
)
_TANGENT_HINTS = ("切线", "切線", "tangent")
_SECANT_HINTS = ("割线", "割線", "secant")
# "2x+1" / "3(x-1)" are frequent director spellings that the strict AST parser
# rejects.  Rewriting them for the *check* only ever widens coverage: the
# rewritten form still goes through the same whitelist, and a form that stays
# unparsable is skipped rather than blamed.
_IMPLICIT_PRODUCT_RE = re.compile(r"(?<=\d)\s*(?=[A-Za-z_(])")
_EXPRESSION_FORM_CACHE: dict[tuple[str, str], str | None] = {}
_DERIVATIVE_CACHE: dict[tuple[str, str], str | None] = {}
_GEOMETRY_CACHE_LIMIT = 512


def _params_of(item: dict[str, Any]) -> dict[str, Any]:
    params = item.get("params")
    return params if isinstance(params, dict) else {}


def _finite_float(value: Any) -> float | None:
    if isinstance(value, bool) or isinstance(value, (list, tuple, dict)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _point_pair(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    x = _finite_float(value[0])
    y = _finite_float(value[1])
    if x is None or y is None:
        return None
    return (x, y)


def _expression_probe(expression: str, variable: str) -> bool:
    """Can the safe runtime parse this expression in this variable at all?"""
    try:
        result = execute_math_request(
            {
                "engine": "sympy",
                "symbols": {variable: {"domain": "real"}},
                "operations": [
                    {
                        "id": "geometry_probe",
                        "op": "evaluate",
                        "expression": expression,
                        "variable": variable,
                    }
                ],
            }
        )
    except Exception:  # pragma: no cover - defensive around the runtime
        return False
    return bool(result.success and result.operations)


def _computable_expression(expression: Any, variable: Any) -> str | None:
    """A spelling of ``expression`` the safe runtime can evaluate, or None."""
    text = str(expression or "").strip()
    name = str(variable or "x").strip() or "x"
    if not text or not name.isidentifier() or len(text) > 400:
        return None
    key = (text, name)
    if key in _EXPRESSION_FORM_CACHE:
        return _EXPRESSION_FORM_CACHE[key]
    resolved: str | None = None
    candidates = [text]
    relaxed = _IMPLICIT_PRODUCT_RE.sub("*", text)
    if relaxed != text:
        candidates.append(relaxed)
    for candidate in candidates:
        if _expression_probe(candidate, name):
            resolved = candidate
            break
    if len(_EXPRESSION_FORM_CACHE) > _GEOMETRY_CACHE_LIMIT:
        _EXPRESSION_FORM_CACHE.clear()
    _EXPRESSION_FORM_CACHE[key] = resolved
    return resolved


def _derivative_expression(expression: str, variable: str) -> str | None:
    """Exact d/dvariable through the deterministic runtime, or None."""
    key = (expression, variable)
    if key in _DERIVATIVE_CACHE:
        return _DERIVATIVE_CACHE[key]
    derivative: str | None = None
    try:
        result = execute_math_request(
            {
                "engine": "sympy",
                "symbols": {variable: {"domain": "real"}},
                "operations": [
                    {
                        "id": "geometry_derivative",
                        "op": "differentiate",
                        "expression": expression,
                        "variable": variable,
                    }
                ],
            }
        )
    except Exception:  # pragma: no cover - defensive around the runtime
        result = None
    if result is not None and result.success and result.operations:
        raw = result.operations[0].get("result")
        if isinstance(raw, str) and raw.strip():
            derivative = raw.strip()
    if len(_DERIVATIVE_CACHE) > _GEOMETRY_CACHE_LIMIT:
        _DERIVATIVE_CACHE.clear()
    _DERIVATIVE_CACHE[key] = derivative
    return derivative


def _slope_value_at(expression: str, variable: str, point: float) -> float | None:
    derivative = _derivative_expression(expression, variable)
    if derivative is None:
        return None
    return _real_value_at(derivative, variable, point)


def _plan_curves(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Every function_curve whose expression can actually be recomputed."""
    curves: list[dict[str, Any]] = []
    for index, item in enumerate(plan.get("visual_objects") or [], start=1):
        if not isinstance(item, dict) or item.get("primitive") != "function_curve":
            continue
        params = _params_of(item)
        variable = str(params.get("variable") or "x").strip() or "x"
        expression = _computable_expression(params.get("expression"), variable)
        if expression is None:
            continue
        span = params.get("x_range")
        x_range = None
        if isinstance(span, (list, tuple)) and len(span) >= 2:
            low, high = _finite_float(span[0]), _finite_float(span[1])
            if low is not None and high is not None and high > low:
                x_range = (low, high)
        curves.append(
            {
                "index": index,
                "id": str(item.get("id") or f"curve_{index}"),
                "expression": expression,
                "variable": variable,
                "x_range": x_range,
                "label": f"{item.get('label') or ''} {item.get('meaning') or ''}".strip(),
            }
        )
    return curves


def _curve_covers(curve: dict[str, Any], x: float) -> bool:
    span = curve.get("x_range")
    if span is None:
        return True
    return bool(span[0] - 1e-9 <= x <= span[1] + 1e-9)


def _plan_value_scale(plan: dict[str, Any], curves: list[dict[str, Any]]) -> float:
    """The vertical span the picture actually occupies (at least 1.0)."""
    values: list[float] = []

    def collect(value: Any) -> None:
        number = _finite_float(value)
        if number is not None and abs(number) < 1e9:
            values.append(number)

    for item in plan.get("visual_objects") or []:
        if not isinstance(item, dict):
            continue
        params = _params_of(item)
        span = params.get("y_range")
        if isinstance(span, (list, tuple)) and len(span) >= 2:
            collect(span[0])
            collect(span[1])
        collect(params.get("y"))
        for key in ("start", "end"):
            point = _point_pair(params.get(key))
            if point is not None:
                collect(point[1])
        for key in ("positions", "points", "samples"):
            for entry in params.get(key) or []:
                point = _point_pair(entry)
                if point is not None:
                    collect(point[1])
        for rect in params.get("rects") or []:
            if isinstance(rect, (list, tuple)) and len(rect) >= 3:
                collect(rect[2])
    for curve in curves:
        span = curve.get("x_range") or (-3.0, 3.0)
        for x in _linear_space(span[0], span[1], 5):
            collect(_real_value_at(curve["expression"], curve["variable"], x))
    if not values:
        return 1.0
    return max(max(values) - min(values), 1.0)


def _geometric_truth_findings(plan: dict[str, Any]) -> list[tuple[str, str]]:
    """(object_id, message) for every geometric claim contradicted by math."""
    if not isinstance(plan, dict):
        return []
    objects = [item for item in plan.get("visual_objects") or [] if isinstance(item, dict)]
    curves = _plan_curves(plan)
    scale = _plan_value_scale(plan, curves)
    tol = max(1e-6, 0.02 * scale)
    findings: list[tuple[str, str]] = []
    for index, item in enumerate(objects, start=1):
        primitive = str(item.get("primitive") or "")
        params = _params_of(item)
        text = f"{item.get('label') or ''} {item.get('meaning') or ''}"

        if primitive == "dot" and curves:
            findings.extend(_dot_violations(item, index, curves, tol, text))
        elif primitive == "tangent_line":
            findings.extend(_tangent_primitive_violations(item, index, tol))
        elif primitive == "secant_line":
            findings.extend(_secant_primitive_violations(item, index, tol))
        elif primitive == "riemann_rects":
            findings.extend(_riemann_violations(item, index, tol))
        elif primitive == "line" and curves:
            points = _line_points(params)
            if points is None:
                continue
            if any(word in text for word in _TANGENT_HINTS):
                findings.extend(_line_tangent_violations(item, index, points, curves, tol))
            elif any(word in text for word in _SECANT_HINTS):
                findings.extend(_line_secant_violations(item, index, points, curves, tol))
    return findings


def _dot_violations(
    item: dict[str, Any],
    index: int,
    curves: list[dict[str, Any]],
    tol: float,
    text: str,
) -> list[tuple[str, str]]:
    """A point that claims the curve must sit on it, within tolerance."""
    params = _params_of(item)
    if params.get("open"):
        # A hollow marker deliberately states "the function is not this value
        # here" (removable discontinuity, limit height).  Checking it against
        # the curve would punish an honest drawing.
        return []
    points: list[tuple[float, float]] = []
    x = _finite_float(params.get("x"))
    y = _finite_float(params.get("y"))
    if x is not None and y is not None:
        points.append((x, y))
    for entry in params.get("positions") or []:
        point = _point_pair(entry)
        if point is not None:
            points.append(point)
    if not points:
        return []
    object_id = str(item.get("id") or f"dot_{index}")
    hinted = any(word in text for word in _ON_CURVE_HINTS)
    # A count-bearing dot is a group of interchangeable units laid out for
    # counting, not a coordinate reading; only an explicit claim makes it one.
    counted = (_declared_count(item) or 0) > 1
    violations: list[tuple[str, str]] = []
    for x0, y0 in points:
        candidates = [curve for curve in curves if _curve_covers(curve, x0)]
        if not candidates:
            continue
        # A dot claims the curve when it says so, or when the picture holds a
        # single curve and the dot carries a non-zero height in that frame.
        # A y=0 marker without such a claim is an x-axis annotation.
        if not hinted and (counted or not (len(curves) == 1 and abs(y0) > tol)):
            continue
        readings: list[tuple[float, dict[str, Any]]] = []
        for curve in candidates:
            value = _real_value_at(curve["expression"], curve["variable"], x0)
            if value is None:
                continue
            if abs(value - y0) <= tol:
                readings = []
                break
            readings.append((value, curve))
        if not readings:
            continue
        detail = "；".join(
            f"{curve['id']} 在 {curve['variable']}={_format_number(x0)} 处的真实值是 "
            f"{_format_number(value)}"
            for value, curve in readings[:3]
        )
        violations.append(
            (
                object_id,
                f"visual_objects[{index}]（{object_id}）标注的点 "
                f"({_format_number(x0)}, {_format_number(y0)}) 不在任何函数曲线上："
                f"{detail}（容差 {_format_number(tol)}）。"
                "图上标注的坐标必须由函数本身算出，不能凑位置",
            )
        )
    return violations


def _line_points(params: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]] | None:
    raw = params.get("points")
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        first, second = _point_pair(raw[0]), _point_pair(raw[-1])
        if first is not None and second is not None:
            return (first, second)
    first, second = _point_pair(params.get("start")), _point_pair(params.get("end"))
    if first is not None and second is not None:
        return (first, second)
    coordinates = [_finite_float(params.get(key)) for key in ("x1", "y1", "x2", "y2")]
    if all(value is not None for value in coordinates):
        return ((coordinates[0], coordinates[1]), (coordinates[2], coordinates[3]))  # type: ignore[return-value]
    return None


def _segment_slope(
    points: tuple[tuple[float, float], tuple[float, float]],
) -> float | None:
    (x1, y1), (x2, y2) = points
    if abs(x2 - x1) <= 1e-9:
        return None
    return (y2 - y1) / (x2 - x1)


def _tangent_primitive_violations(
    item: dict[str, Any], index: int, tol: float
) -> list[tuple[str, str]]:
    params = _params_of(item)
    variable = str(params.get("variable") or "x").strip() or "x"
    expression = _computable_expression(params.get("expression"), variable)
    at_x = _finite_float(params.get("at_x"))
    if expression is None or at_x is None:
        return []
    value = _real_value_at(expression, variable, at_x)
    true_slope = _slope_value_at(expression, variable, at_x)
    if value is None or true_slope is None:
        return []
    object_id = str(item.get("id") or f"tangent_{index}")
    slope_tol = max(tol, 1e-6)
    violations: list[tuple[str, str]] = []
    declared = _finite_float(params.get("slope"))
    if declared is not None and abs(declared - true_slope) > slope_tol:
        violations.append(
            (
                object_id,
                f"visual_objects[{index}]（{object_id}）切线斜率是编的："
                f"声称 {_format_number(declared)}，而 {expression} 在 "
                f"{variable}={_format_number(at_x)} 处的导数是 "
                f"{_format_number(true_slope)}",
            )
        )
    points = _line_points(params)
    if points is not None:
        drawn_slope = _segment_slope(points)
        if drawn_slope is None:
            violations.append(
                (
                    object_id,
                    f"visual_objects[{index}]（{object_id}）切线画成了竖直线段，"
                    "无法表示有限斜率",
                )
            )
        else:
            if abs(drawn_slope - true_slope) > slope_tol:
                violations.append(
                    (
                        object_id,
                        f"visual_objects[{index}]（{object_id}）切线端点画出的斜率是 "
                        f"{_format_number(drawn_slope)}，真实导数是 "
                        f"{_format_number(true_slope)}；孩子照着读斜率会读到假的数",
                    )
                )
            (x1, y1), _ = points
            drawn_at_x = y1 + drawn_slope * (at_x - x1)
            if abs(drawn_at_x - value) > tol:
                violations.append(
                    (
                        object_id,
                        f"visual_objects[{index}]（{object_id}）切线没有经过切点 "
                        f"({_format_number(at_x)}, {_format_number(value)})："
                        f"它在该处的高度是 {_format_number(drawn_at_x)}",
                    )
                )
    return violations


def _secant_primitive_violations(
    item: dict[str, Any], index: int, tol: float
) -> list[tuple[str, str]]:
    params = _params_of(item)
    variable = str(params.get("variable") or "x").strip() or "x"
    expression = _computable_expression(params.get("expression"), variable)
    x0 = _finite_float(params.get("x0"))
    h = _finite_float(params.get("h"))
    if expression is None or x0 is None or h is None or abs(h) <= 1e-12:
        return []
    start_value = _real_value_at(expression, variable, x0)
    end_value = _real_value_at(expression, variable, x0 + h)
    if start_value is None or end_value is None:
        return []
    true_slope = (end_value - start_value) / h
    object_id = str(item.get("id") or f"secant_{index}")
    slope_tol = max(tol, 1e-6)
    violations: list[tuple[str, str]] = []
    declared = _finite_float(params.get("slope"))
    if declared is not None and abs(declared - true_slope) > slope_tol:
        violations.append(
            (
                object_id,
                f"visual_objects[{index}]（{object_id}）割线斜率是编的："
                f"声称 {_format_number(declared)}，而两点平均变化率 "
                f"(f({_format_number(x0 + h)})-f({_format_number(x0)}))/"
                f"{_format_number(h)} = {_format_number(true_slope)}",
            )
        )
    for key, expected_x, expected_y in (
        ("start", x0, start_value),
        ("end", x0 + h, end_value),
    ):
        point = _point_pair(params.get(key))
        if point is None:
            continue
        if abs(point[0] - expected_x) > tol or abs(point[1] - expected_y) > tol:
            violations.append(
                (
                    object_id,
                    f"visual_objects[{index}]（{object_id}）割线端点 {key} 画在 "
                    f"({_format_number(point[0])}, {_format_number(point[1])})，"
                    f"真实曲线点是 ({_format_number(expected_x)}, "
                    f"{_format_number(expected_y)})",
                )
            )
    return violations


def _riemann_violations(
    item: dict[str, Any], index: int, tol: float
) -> list[tuple[str, str]]:
    params = _params_of(item)
    variable = str(params.get("variable") or "x").strip() or "x"
    expression = _computable_expression(params.get("expression"), variable)
    if expression is None:
        return []
    side = str(params.get("side") or "mid").strip().lower()
    if side not in {"left", "right", "mid"}:
        side = "mid"
    object_id = str(item.get("id") or f"riemann_{index}")
    violations: list[tuple[str, str]] = []
    rects = [
        rect
        for rect in params.get("rects") or []
        if isinstance(rect, (list, tuple)) and len(rect) >= 3
    ]
    total = 0.0
    checked = False
    for order, rect in enumerate(rects, start=1):
        left = _finite_float(rect[0])
        right = _finite_float(rect[1])
        height = _finite_float(rect[2])
        if left is None or right is None or height is None or right <= left:
            continue
        sample = {"left": left, "right": right, "mid": (left + right) / 2}[side]
        expected = _real_value_at(expression, variable, sample)
        if expected is None:
            continue
        checked = True
        total += height * (right - left)
        if abs(expected - height) > tol:
            violations.append(
                (
                    object_id,
                    f"visual_objects[{index}]（{object_id}）第 {order} 个黎曼矩形高度是 "
                    f"{_format_number(height)}，而 f({_format_number(sample)}) = "
                    f"{_format_number(expected)}；矩形高度必须就是函数值",
                )
            )
    declared_area = _finite_float(params.get("approx_area"))
    if declared_area is not None and checked and not violations:
        area_tol = max(1e-6, 0.02 * max(abs(declared_area), 1.0))
        if abs(declared_area - total) > area_tol:
            violations.append(
                (
                    object_id,
                    f"visual_objects[{index}]（{object_id}）声称的近似面积 "
                    f"{_format_number(declared_area)} 不等于画出的矩形面积和 "
                    f"{_format_number(total)}",
                )
            )
    elif declared_area is not None and not rects:
        count = _finite_float(params.get("n"))
        span = params.get("x_range")
        if count is not None and isinstance(span, (list, tuple)) and len(span) >= 2:
            low, high = _finite_float(span[0]), _finite_float(span[1])
            if low is not None and high is not None and 1 <= count <= 512:
                computed = _riemann_sum(
                    expression, variable, low, high, int(count), side
                )
                if computed is not None:
                    area_tol = max(1e-6, 0.02 * max(abs(declared_area), 1.0))
                    if abs(declared_area - computed[0]) > area_tol:
                        violations.append(
                            (
                                object_id,
                                f"visual_objects[{index}]（{object_id}）声称的近似面积 "
                                f"{_format_number(declared_area)} 与 n={int(count)} 的"
                                f"真实黎曼和 {_format_number(computed[0])} 不一致",
                            )
                        )
    return violations


def _tangency_candidates(
    item: dict[str, Any],
    points: tuple[tuple[float, float], tuple[float, float]],
    curve: dict[str, Any],
) -> list[float]:
    """The x values the drawing itself nominates as the point of tangency.

    Only nominated points count: an explicit parameter, or an endpoint/midpoint
    of the drawn segment.  Accepting any interior point would let a fabricated
    slope pass on a coincidence — along a long enough segment a curved graph
    takes almost every slope somewhere, which is exactly how a wrong tangent
    survives a casual look.
    """
    params = _params_of(item)
    nominated = [
        value
        for value in (
            _finite_float(params.get(key)) for key in ("at_x", "x0", "tangent_at")
        )
        if value is not None
    ]
    (x1, _), (x2, _) = points
    if not nominated:
        nominated = [x1, x2, (x1 + x2) / 2]
    span = curve.get("x_range")
    candidates: list[float] = []
    for value in nominated:
        if span is not None and not (span[0] - 1e-9 <= value <= span[1] + 1e-9):
            continue
        if all(abs(value - existing) > 1e-9 for existing in candidates):
            candidates.append(value)
    return candidates


def _line_tangent_violations(
    item: dict[str, Any],
    index: int,
    points: tuple[tuple[float, float], tuple[float, float]],
    curves: list[dict[str, Any]],
    tol: float,
) -> list[tuple[str, str]]:
    """A segment labelled "tangent" must actually touch a curve tangentially."""
    object_id = str(item.get("id") or f"line_{index}")
    slope = _segment_slope(points)
    if slope is None:
        return []
    slope_tol = max(tol, 1e-6)
    (x1, y1), _ = points
    diagnostics: list[str] = []
    checked = False
    for curve in curves:
        candidates = _tangency_candidates(item, points, curve)
        anchor_reading: str | None = None
        for x in candidates:
            value = _real_value_at(curve["expression"], curve["variable"], x)
            true_slope = _slope_value_at(curve["expression"], curve["variable"], x)
            if value is None or true_slope is None:
                continue
            checked = True
            if abs(y1 + slope * (x - x1) - value) <= tol and abs(slope - true_slope) <= slope_tol:
                return []
            if anchor_reading is None:
                anchor_reading = (
                    f"{curve['id']} 在 {curve['variable']}={_format_number(x)} 处的"
                    f"真实切线斜率是 {_format_number(true_slope)}，切点高度 "
                    f"{_format_number(value)}"
                )
        if anchor_reading is not None:
            diagnostics.append(anchor_reading)
    if not checked:
        return []
    return [
        (
            object_id,
            f"visual_objects[{index}]（{object_id}）被标注为切线，但斜率 "
            f"{_format_number(slope)} 的这条线段与任何函数曲线都不相切："
            + "；".join(diagnostics[:2])
            + "。切线的斜率必须等于该点导数，否则图上读到的是假数",
        )
    ]


def _line_secant_violations(
    item: dict[str, Any],
    index: int,
    points: tuple[tuple[float, float], tuple[float, float]],
    curves: list[dict[str, Any]],
    tol: float,
) -> list[tuple[str, str]]:
    """A segment labelled "secant" must join two real points of one curve."""
    object_id = str(item.get("id") or f"line_{index}")
    checked = False
    for curve in curves:
        values: list[float] = []
        for x, y in points:
            if not _curve_covers(curve, x):
                values = []
                break
            value = _real_value_at(curve["expression"], curve["variable"], x)
            if value is None:
                values = []
                break
            values.append(abs(value - y))
        if not values:
            continue
        checked = True
        if max(values) <= tol:
            return []
    if not checked:
        return []
    (x1, y1), (x2, y2) = points
    return [
        (
            object_id,
            f"visual_objects[{index}]（{object_id}）被标注为割线，但端点 "
            f"({_format_number(x1)}, {_format_number(y1)}) 与 "
            f"({_format_number(x2)}, {_format_number(y2)}) 并非同一条曲线上的两点",
        )
    ]


def _geometric_truth_violations(plan: dict[str, Any]) -> list[str]:
    """Every drawn claim the mathematics contradicts, as validation errors."""
    return [message for _, message in _geometric_truth_findings(plan)]


def _geometrically_false_object_ids(plan: dict[str, Any]) -> set[str]:
    """Ids of objects whose geometry the mathematics contradicts."""
    return {object_id for object_id, _ in _geometric_truth_findings(plan)}


def _validate_plan(
    plan: dict[str, Any],
    grade: str,
    *,
    previous_pattern: str = "",
    is_replan: bool = False,
) -> list[str]:
    """Validate a universal scene contract, never a problem-type taxonomy."""
    del grade, previous_pattern, is_replan
    errors: list[str] = []
    # Geometric truth ranks with the structural contract, not below it: a plan
    # whose drawing contradicts its own function is a defect of the same order
    # as a missing scene, and must take the same repair/degrade path instead of
    # reaching a child.
    errors.extend(_geometric_truth_violations(plan))
    thesis = (plan.get("visual_thesis") or "").strip()
    if len(thesis) < 12:
        errors.append("visual_thesis 太短：请用一句完整的话描述观众最终要看懂的视觉论证")
    errors.extend(_validate_essence_rationale(plan.get("essence_rationale") or ""))

    ledger = plan.get("symbol_ledger") or []
    if len(ledger) < 2:
        errors.append("symbol_ledger 至少 2 项，分别固定参照对象与变化/结论对象的全片含义")

    visual_objects = plan.get("visual_objects") or []
    object_ids: set[str] = set()
    object_primitives: dict[str, str] = {}
    objects_by_id: dict[str, dict[str, Any]] = {}
    if len(visual_objects) < 2:
        errors.append("visual_objects 至少需要 2 个承载数学意义的非文字图形对象")
    errors.extend(_member_series_violations(visual_objects))
    for index, item in enumerate(visual_objects, start=1):
        if not isinstance(item, dict):
            errors.append(f"visual_objects[{index}] 不是对象")
            continue
        object_id = str(item.get("id") or "").strip()
        primitive = str(item.get("primitive") or "").strip()
        meaning = str(item.get("meaning") or "").strip()
        if not object_id or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", object_id):
            errors.append(f"visual_objects[{index}].id 必须是稳定的标识符")
        elif object_id in object_ids:
            errors.append(f"visual object id 重复：{object_id}")
        else:
            object_ids.add(object_id)
            object_primitives[object_id] = primitive
            objects_by_id[object_id] = item
        if primitive not in _VISUAL_PRIMITIVES:
            errors.append(
                f"visual_objects[{index}].primitive='{primitive}' 不在可组合图形原语集合中"
            )
        if not meaning:
            errors.append(f"visual_objects[{index}].meaning 为空，图形没有稳定数学含义")
        if primitive == "function_curve":
            params = item.get("params") or {}
            if not str(params.get("expression") or "").strip():
                errors.append(f"visual_objects[{index}] 的 function_curve 缺少 params.expression")
        if primitive in _CALCULUS_PRIMITIVES:
            params = item.get("params") or {}
            required = {
                "tangent_line": ("expression", "variable", "at_x"),
                "secant_line": ("expression", "variable", "x0", "h"),
                "riemann_rects": ("expression", "variable", "x_range", "n"),
                "limit_approach": ("expression", "variable", "target"),
                "composition_chain": ("outer", "inner", "variable"),
            }[primitive]
            missing = [key for key in required if params.get(key) in (None, "")]
            if missing:
                errors.append(
                    f"visual_objects[{index}] 的 {primitive} 缺少 params."
                    + "/params.".join(missing)
                    + "；微积分构件必须携带它所依据的表达式，渲染端才能自行重算"
                )
        if primitive == "balance":
            params = item.get("params") or {}
            for field_name in ("coefficient", "total", "solution"):
                raw = params.get(field_name)
                if not isinstance(raw, int) or raw < 0:
                    errors.append(
                        f"visual_objects[{index}] 的 balance 缺少非负整数 params.{field_name}"
                    )

    scenes = plan.get("scenes") or []
    transform_ops: set[str] = set()
    has_transform_scene = False
    visible_ids: set[str] = set()
    mapped_aliases: dict[str, str] = {}
    causal_transition_count = 0
    has_relation_reveal = False
    # Running unit ledger: initialized from declared counts at create time and
    # updated by quantity verbs, so conservation is checked against the actual
    # on-screen state, not the static declaration.
    unit_ledger: dict[str, int] = {}

    def ledger_value(object_id: str) -> int | None:
        if object_id in unit_ledger:
            return unit_ledger[object_id]
        return _declared_count(objects_by_id.get(object_id))
    if len(scenes) < 3:
        errors.append(f"场景数 {len(scenes)} < 3")
    if "transform" not in [s.get("role", "") for s in scenes if isinstance(s, dict)]:
        errors.append("缺少 role=transform 场景（必须让数学状态真实发生变化）")
    for index, scene in enumerate(scenes, start=1):
        if not isinstance(scene, dict):
            errors.append(f"场景 {index} 不是对象")
            continue
        role = scene.get("role", "")
        if role == "transform":
            has_transform_scene = True
        if role not in _VALID_ROLES:
            errors.append(f"场景 {index} role='{role}' 不在允许集合 {sorted(_VALID_ROLES)}")
        for field in (
            "key_objects",
            "action",
            "invariant",
            "attention_target",
            "exit_condition",
            "teaching_line",
        ):
            if not (scene.get(field) or "").strip():
                errors.append(f"场景 {index} {field} 为空")
        actions = scene.get("actions") or []
        if not actions:
            errors.append(f"场景 {index} actions 为空，只有文字导演描述而无可执行图形动作")
        action_ops: set[str] = set()
        visible_at_scene_start = set(visible_ids)
        for action_index, action in enumerate(actions, start=1):
            if not isinstance(action, dict):
                errors.append(f"场景 {index} action {action_index} 不是对象")
                continue
            op = str(action.get("op") or "")
            action_ops.add(op)
            if op not in _VISUAL_ACTIONS:
                errors.append(f"场景 {index} action op='{op}' 不受支持")
            targets = action.get("targets") or []
            if not targets:
                errors.append(f"场景 {index} action {action_index} 没有 targets")
            unknown = [target for target in targets if target not in object_ids]
            if unknown:
                errors.append(
                    f"场景 {index} action {action_index} 引用了未知图形对象：{','.join(unknown)}"
                )
            result = str(action.get("result") or "")
            if result and result not in object_ids:
                errors.append(f"场景 {index} action result 引用了未知图形对象：{result}")
            if op in {"transform", "partition", "map"} and not result:
                errors.append(
                    f"场景 {index} action {action_index} 的 {op} 缺少 result，"
                    "无法形成可见的来源→结果变化"
                )
            if op in {"transform", "partition", "map"} and result in targets:
                errors.append(
                    f"场景 {index} action {action_index} 的 result 与来源相同，没有可辨认的终态"
                )
            if op == "transform":
                # Conservation must not be bypassable through the legacy verb:
                # an additive count change (5-grid → 3-grid) destroys unit
                # continuity and must use take_from/combine. Multiplicative
                # regrouping (3 → 12, 6 → 2) keeps a visible row/group
                # structure, so grid-to-grid transform remains legal there.
                source_counts = [
                    _declared_count(objects_by_id.get(str(target))) for target in targets
                ]
                result_count = _declared_count(objects_by_id.get(result))
                if (
                    result_count is not None
                    and result_count > 0
                    and source_counts
                    and all(value is not None for value in source_counts)
                ):
                    combined = sum(value for value in source_counts if value is not None)
                    multiplicative = combined > 0 and (
                        combined % result_count == 0 or result_count % combined == 0
                    )
                    if combined != result_count and not multiplicative:
                        errors.append(
                            f"场景 {index} action {action_index} 用 transform 改变单位数量"
                            f"（{source_counts} → {result_count}）；加减类数量变化必须用 "
                            "take_from/combine 表达，保持单位对象连续可追踪"
                        )
            if op == "take_from":
                source = str(action.get("source") or "").strip()
                destination = str(action.get("destination") or "").strip()
                take_count = action.get("count")
                style = str(action.get("style") or "").strip()
                if not source or source not in object_ids:
                    errors.append(
                        f"场景 {index} action {action_index} 的 take_from 缺少已声明的 source 组"
                    )
                if not destination or destination not in object_ids:
                    errors.append(
                        f"场景 {index} action {action_index} 的 take_from 缺少已声明的 "
                        "destination 容器对象（不接受自由 zone 字符串）"
                    )
                elif destination == source:
                    errors.append(
                        f"场景 {index} action {action_index} 的 take_from 目的地与来源相同"
                    )
                if not isinstance(take_count, int) or take_count < 1:
                    errors.append(
                        f"场景 {index} action {action_index} 的 take_from 缺少正整数 count"
                    )
                else:
                    source_count = ledger_value(source)
                    if source_count is not None and take_count > source_count:
                        errors.append(
                            f"场景 {index} action {action_index} 守恒违例：take_from 数量 "
                            f"{take_count} 超过 source 当前数量 {source_count}"
                        )
                    if source_count is not None:
                        unit_ledger[source] = source_count - min(take_count, source_count)
                        unit_ledger[destination] = (
                            (ledger_value(destination) or 0) + min(take_count, source_count)
                        )
                if style and style not in _TAKE_FROM_STYLES:
                    errors.append(
                        f"场景 {index} action {action_index} 的 take_from style='{style}' "
                        f"不在 {sorted(_TAKE_FROM_STYLES)} 中"
                    )
            elif op == "combine":
                if len(targets) < 2:
                    errors.append(
                        f"场景 {index} action {action_index} 的 combine 需要至少 2 个来源组"
                    )
                if not result:
                    errors.append(
                        f"场景 {index} action {action_index} 的 combine 缺少 result 合并目标"
                    )
                else:
                    source_counts = [ledger_value(str(target)) for target in targets]
                    if all(value is not None for value in source_counts):
                        combined = sum(value for value in source_counts if value is not None)
                        declared_result = _declared_count(objects_by_id.get(result))
                        if declared_result is not None and declared_result != combined:
                            errors.append(
                                f"场景 {index} action {action_index} 守恒违例：combine 来源"
                                f"数量和 {source_counts} ≠ result 声明数量 {declared_result}"
                            )
                        unit_ledger[result] = combined
                        for target in targets:
                            unit_ledger[str(target)] = 0
            elif op in {"balance_remove", "balance_divide", "balance_verify"}:
                balance_target = str(targets[0]) if targets else ""
                if object_primitives.get(balance_target) != "balance":
                    errors.append(
                        f"场景 {index} action {action_index} 的 {op} 目标必须是 balance 对象"
                    )
                else:
                    balance_params = (
                        objects_by_id.get(balance_target, {}).get("params") or {}
                    )
                    amount = action.get("count")
                    if op == "balance_remove":
                        limit = balance_params.get("constant")
                        if not isinstance(amount, int) or amount < 1:
                            errors.append(
                                f"场景 {index} action {action_index} 的 balance_remove "
                                "缺少正整数 count"
                            )
                        elif isinstance(limit, int) and amount > limit:
                            errors.append(
                                f"场景 {index} action {action_index} 守恒违例："
                                f"balance_remove {amount} 超过盘上单位数 {limit}"
                            )
                    elif op == "balance_divide":
                        expected = balance_params.get("coefficient")
                        if not isinstance(amount, int) or amount < 2:
                            errors.append(
                                f"场景 {index} action {action_index} 的 balance_divide "
                                "缺少 ≥2 的整数 count（份数）"
                            )
                        elif isinstance(expected, int) and amount != expected:
                            errors.append(
                                f"场景 {index} action {action_index} 的 balance_divide "
                                f"份数 {amount} 与未知数系数 {expected} 不一致"
                            )
                    else:  # balance_verify
                        expect = action.get("expect")
                        declared = balance_params.get("solution")
                        if not isinstance(expect, int) or expect < 0:
                            errors.append(
                                f"场景 {index} action {action_index} 的 balance_verify "
                                "缺少非负整数 expect（解）"
                            )
                        elif isinstance(declared, int) and expect != declared:
                            errors.append(
                                f"场景 {index} action {action_index} 的 balance_verify "
                                f"expect={expect} 与已验证解 {declared} 不一致"
                            )
            elif op == "swap_units":
                swap_source = str(action.get("source") or "").strip() or (
                    str(targets[0]) if targets else ""
                )
                swap_count = action.get("count")
                if not swap_source or swap_source not in object_ids:
                    errors.append(
                        f"场景 {index} action {action_index} 的 swap_units 缺少已声明的 source 组"
                    )
                if not isinstance(swap_count, int) or swap_count < 1:
                    errors.append(
                        f"场景 {index} action {action_index} 的 swap_units 缺少正整数 count"
                    )
                else:
                    swap_available = ledger_value(swap_source)
                    if swap_available is not None and swap_count > swap_available:
                        errors.append(
                            f"场景 {index} action {action_index} 守恒违例：swap_units 数量 "
                            f"{swap_count} 超过 source 当前数量 {swap_available}"
                        )
                expect_after = action.get("expect")
                if expect_after is not None and (
                    not isinstance(expect_after, int) or not 0 <= expect_after <= 6
                ):
                    errors.append(
                        f"场景 {index} action {action_index} 的 swap_units expect"
                        "（替换后每单位标记数）必须是 0-6 的整数"
                    )
            elif op == "replicate":
                times = action.get("count")
                replicate_source = str(action.get("source") or "").strip() or (
                    str(targets[0]) if targets else ""
                )
                if not result:
                    errors.append(
                        f"场景 {index} action {action_index} 的 replicate 缺少 result 容器"
                    )
                if not isinstance(times, int) or times < 1:
                    errors.append(
                        f"场景 {index} action {action_index} 的 replicate 缺少正整数 count（份数）"
                    )
                elif replicate_source in object_ids:
                    per_row = ledger_value(replicate_source)
                    if per_row is not None:
                        replicated_total = per_row * times
                        if replicated_total > 64:
                            errors.append(
                                f"场景 {index} action {action_index} 的 replicate 总量 "
                                f"{replicated_total} 超过 64，应改用 quantity_bar 测量表达"
                            )
                        declared_result = _declared_count(objects_by_id.get(result))
                        if declared_result is not None and declared_result != replicated_total:
                            errors.append(
                                f"场景 {index} action {action_index} 守恒违例：replicate "
                                f"{per_row}×{times}={replicated_total} ≠ result 声明数量 "
                                f"{declared_result}"
                            )
                        if result:
                            unit_ledger[result] = replicated_total
                            unit_ledger[replicate_source] = 0
            elif op == "count":
                expect = action.get("expect")
                if not isinstance(expect, int) or expect < 0:
                    errors.append(
                        f"场景 {index} action {action_index} 的 count 缺少非负整数 expect"
                    )
                elif targets:
                    target_count = ledger_value(str(targets[0]))
                    if target_count is not None and expect != target_count:
                        errors.append(
                            f"场景 {index} action {action_index} 的 count expect={expect} "
                            f"与对象当前数量 {target_count} 不一致"
                        )
            elif op == "recount_verify":
                expect_total = action.get("expect_total")
                if not isinstance(expect_total, int) or expect_total < 0:
                    errors.append(
                        f"场景 {index} action {action_index} 的 recount_verify 缺少非负整数 "
                        "expect_total"
                    )
                else:
                    group_counts = [ledger_value(str(target)) for target in targets]
                    if (
                        group_counts
                        and all(value is not None for value in group_counts)
                        and sum(value for value in group_counts if value is not None)
                        != expect_total
                    ):
                        errors.append(
                            f"场景 {index} action {action_index} 守恒违例：recount_verify 各组"
                            f"数量和 {group_counts} ≠ expect_total={expect_total}"
                        )
            elif op == "move":
                destination = str(action.get("destination") or "").strip()
                if not (
                    destination in object_ids
                    or _AXIS_DESTINATION_RE.fullmatch(destination) is not None
                ):
                    errors.append(
                        f"场景 {index} action {action_index} 的 move 缺少 destination"
                        "（已声明对象 id 或 x=<数值>）；没有目的地的移动不构成可执行语义"
                    )
            resolved_targets = [
                target for target in targets if target in visible_ids or target in mapped_aliases
            ]
            if op == "create":
                visible_ids.update(targets)
            elif op in {
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
            }:
                required_visible = list(targets)
                if op == "take_from":
                    # The destination container may be materialized by the
                    # lowering itself (cross_out wraps the removed units in
                    # place), so only the source must already be on screen.
                    source_ref = str(action.get("source") or "").strip()
                    if source_ref and source_ref in object_ids:
                        required_visible.append(source_ref)
                missing_targets = [
                    target
                    for target in dict.fromkeys(required_visible)
                    if target not in visible_ids and target not in mapped_aliases
                ]
                if missing_targets:
                    errors.append(
                        f"场景 {index} action {action_index} 在对象出现前执行 {op}："
                        + ",".join(missing_targets)
                    )
                if op == "take_from":
                    destination_ref = str(action.get("destination") or "").strip()
                    if destination_ref in object_ids:
                        visible_ids.add(destination_ref)
                if op in {"combine", "replicate"} and result in object_ids:
                    visible_ids.add(result)
                if op in _MUTATING_VISUAL_ACTIONS and resolved_targets:
                    causal_transition_count += 1
                if op in {"transform", "partition", "map"} and result:
                    for target in targets:
                        visible_ids.discard(target)
                    visible_ids.add(result)
                    if op == "map":
                        for target in targets:
                            mapped_aliases[target] = result
                elif op == "remove":
                    for target in targets:
                        visible_ids.discard(target)
            if not str(action.get("meaning") or "").strip():
                errors.append(f"场景 {index} action {action_index} 缺少数学语义 meaning")
        if role == "transform":
            transform_ops.update(action_ops)
            created_ids = {
                str(target)
                for action in actions
                if isinstance(action, dict) and action.get("op") == "create"
                for target in action.get("targets") or []
            }
            created_relationship_ids = {
                target
                for target in created_ids
                if object_primitives.get(str(target)) in _RELATIONSHIP_PRIMITIVES
            }
            created_coordinate_ids = {
                target
                for target in created_ids
                if object_primitives.get(str(target)) in _RELATIONSHIP_PRIMITIVES | {"dot"}
            }
            has_coordinate_reference = any(
                object_primitives.get(object_id) == "axes" for object_id in visible_at_scene_start
            )
            focused_related = any(
                isinstance(action, dict)
                and action.get("op") in {"highlight", "measure", "compare", "verify"}
                and any(
                    str(target) in visible_at_scene_start | created_ids
                    for target in action.get("targets") or []
                )
                for action in actions
            )
            if (
                created_relationship_ids
                and (
                    focused_related
                    or (
                        has_coordinate_reference
                        and len(created_coordinate_ids) >= 2
                        and any(
                            object_primitives.get(object_id) in {"line", "arrow"}
                            for object_id in created_coordinate_ids
                        )
                    )
                )
                and (
                    has_coordinate_reference
                    or any(
                        object_primitives.get(object_id) in {"line", "arrow"}
                        for object_id in created_relationship_ids
                    )
                )
            ):
                # Revealing an auxiliary/projection/constraint line against
                # an existing object is itself a causal graphical step.  It
                # is not a static list, even though no object identity is
                # replaced.  This covers coordinate and geometric arguments
                # without knowing their problem type.
                has_relation_reveal = True
                causal_transition_count += 1
        if role == "verify" and not (action_ops & _VERIFY_VISUAL_ACTIONS):
            errors.append("verify 场景必须通过 compare/measure/verify 图形动作核对结论")
        if role == "verify":
            created_in_verify = {
                str(target)
                for action in actions
                if isinstance(action, dict) and action.get("op") == "create"
                for target in action.get("targets") or []
            }
            numeric_conclusions = {
                object_id
                for object_id in created_in_verify
                if object_primitives.get(object_id) in {"quantity_bar", "relation_node", "dot"}
                and (
                    str((objects_by_id[object_id].get("label") or "")).strip()
                    or any(
                        key in (objects_by_id[object_id].get("params") or {})
                        for key in ("value", "count", "x", "y", "positions")
                    )
                )
            }
            verification_targets = {
                str(target)
                for action in actions
                if isinstance(action, dict) and action.get("op") in _VERIFY_VISUAL_ACTIONS
                for target in action.get("targets") or []
            }
            evidence_actions = [
                action
                for action in actions
                if isinstance(action, dict)
                and action.get("op") in {"measure", "compare"}
                and any(
                    str(target) not in numeric_conclusions for target in action.get("targets") or []
                )
            ]
            if numeric_conclusions and not numeric_conclusions.issubset(verification_targets):
                errors.append(
                    "verify 场景新建了数值结论对象，但最终核对未同时包含该对象："
                    + ",".join(sorted(numeric_conclusions - verification_targets))
                )
            if numeric_conclusions and not evidence_actions:
                errors.append(
                    "verify 场景的新数值结论缺少 measure/compare 图形证据；"
                    "不能只创建数值标签后宣告成立"
                )
        duration = float(scene.get("duration_s") or 0)
        if duration < 2 or duration > 20:
            errors.append(f"场景 {index} duration_s={duration:g}，应在 2-20 秒之间")
        zone = (scene.get("anchor_zone") or "").strip()
        if not zone or parse_zone(zone) is None:
            errors.append(f"场景 {index} anchor_zone='{zone}' 不符合 6×6 网格格式")

    # A visual argument may use several beats for one continuous change: one
    # beat performs the structural mutation and the next reveals projections
    # or verification marks. Require a real mutation across that sequence,
    # instead of forcing every beat labelled transform to mutate again.
    if (
        has_transform_scene
        and not (transform_ops & _MUTATING_VISUAL_ACTIONS)
        and not has_relation_reveal
    ):
        errors.append("transform 场景序列必须包含会改变非文字图形状态的结构化动作")
    if has_transform_scene and causal_transition_count == 0:
        errors.append("transform 场景只有对象罗列，没有对已出现对象执行可见的因果变化")

    # Scenes are temporal beats, so reusing a zone later is valid.  Collision
    # checks belong to per-frame code/video validation, not cross-beat plans.
    if len(plan.get("forbidden") or []) < 2:
        errors.append("反模式清单至少 2 条")
    total_duration = sum(
        float(scene.get("duration_s") or 0) for scene in scenes if isinstance(scene, dict)
    )
    if scenes and not 12 <= total_duration <= 120:
        errors.append(f"计划总时长 {total_duration:g}s，应在 12-120 秒之间")
    return errors


class VisualPlanTool(ITool):
    def __init__(self, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "visual_plan"

    @property
    def description(self) -> str:
        return (
            "在代码生成前调用。直接从已验证解答提炼开放式视觉论点和逐场景语义，"
            "不匹配题型、不选择预设模板；计划必须包含真实数学变换和视觉验证。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文（缺省取会话题目）"},
                "grade": {"type": "string", "description": "学生年级"},
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        if not problem:
            return ToolResult(success=False, summary="缺少题目", error="empty_problem")
        if ctx.state.get("solution_verified") is not True:
            return ToolResult(
                success=False,
                summary="解答尚未通过 verify_solution，不能开始视觉规划",
                error="solution_not_verified",
            )

        analysis = ctx.state.get("analysis")
        analysis_section = ""
        if analysis:
            analysis_section = (
                "## 题目语义（来自 Solve 同次输出）\n"
                f"```json\n{json.dumps(analysis, ensure_ascii=False, indent=2)}\n```"
            )
        solution = ctx.state.get("solution") or {}
        steps = ctx.state.get("solution_steps") or []
        answer = ctx.state.get("solution_answer") or ""
        solution_lines = []
        for i, step in enumerate(steps[:10], start=1):
            if not isinstance(step, dict):
                continue
            solution_lines.append(
                f"{i}. {str(step.get('description') or '')[:140]}\n"
                f"   运算：{str(step.get('operation') or '')[:240]}\n"
                f"   结果：{str(step.get('result') or '')[:160]}"
            )
        key_points = solution.get("key_points") or []
        solution_section = ""
        if solution_lines:
            solution_section = (
                "## 已验证解答\n"
                + "\n".join(solution_lines)
                + (f"\n\n最终答案：{answer}" if answer else "")
            )
            if key_points:
                solution_section += "\n\n独立检查证据：\n" + "\n".join(
                    f"- {str(item)[:240]}" for item in key_points[:10]
                )
            math_evidence = (
                ctx.state.get("verify_math_evidence") or ctx.state.get("solve_math_evidence") or {}
            )
            if isinstance(math_evidence, dict) and math_evidence.get("success"):
                compact_evidence = {
                    "applicable": math_evidence.get("applicable"),
                    "all_claims_passed": math_evidence.get("all_claims_passed"),
                    "operations": (math_evidence.get("operations") or [])[:12],
                    "claims": (math_evidence.get("claims") or [])[:12],
                }
                solution_section += (
                    "\n\n确定性数学执行证据（图形中的数值和状态必须来自这里）：\n"
                    "```json\n"
                    + json.dumps(compact_evidence, ensure_ascii=False, indent=2)
                    + "\n```"
                )

        feedback = ""
        if ctx.state.get("last_visual_failed"):
            issues = str(ctx.state.get("last_visual_issues") or "")[:500]
            feedback += (
                "\n\n## 上次成片反馈\n"
                f"{issues}\n请定位失败的具体画面机制并重写相应 beat；不要机械更换一个模式名称。"
            )
        violations = ctx.state.get("visual_plan_last_violations") or []
        if violations:
            feedback += "\n\n## 上次计划的结构问题\n" + "\n".join(
                f"- {item}" for item in violations[:10]
            )
        extra_directives = str(ctx.state.get("extra_directives") or "").strip()
        if extra_directives:
            feedback += "\n\n## 用户对本次成片的额外要求\n" + extra_directives[:1000]

        prompt = self._prompts.render(
            "visual_plan",
            grade=grade,
            problem=problem,
            analysis_section=analysis_section,
            solution_section=solution_section,
            feedback_section=feedback,
        )
        async def author_plan(request_prompt: str) -> Any:
            return await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=request_prompt)],
                # Planning is a contract-writing stage. Low variance makes
                # the first plan internally consistent; diversity belongs in
                # explicit experiments, not in production retries.
                temperature=0.25,
                # A complete typed artifact is safer than truncation repair.
                # Compactness is enforced by the prompt; this is only a hard
                # ceiling for complex open-world geometry.
                max_tokens=8192,
                extra_body={
                    "chat_template_kwargs": {"enable_thinking": False},
                    # LM Studio and other modern OpenAI-compatible runtimes
                    # compile this schema into constrained decoding. The
                    # model chooses the mathematical content; the transport
                    # guarantees that the typed artifact is complete JSON.
                    "response_format": _VISUAL_PLAN_RESPONSE_FORMAT,
                },
            )

        try:
            done = await author_plan(prompt)
        except Exception as exc:
            logger.exception("visual_plan LLM call failed")
            return ToolResult(success=False, summary="视觉规划失败", error=str(exc))

        plan = _parse_plan(done)
        raw_artifacts = [_raw_plan_artifact(done, ctx)]
        if plan is None:
            # A truncated/unparseable artifact is a FORMAT failure with a
            # known cause (an over-long plan hitting the token ceiling). One
            # compact retry with explicit budget feedback is evidence-driven,
            # not stochastic re-rolling.
            compact_prompt = (
                prompt
                + "\n\n## 上一次输出失败\n上一份计划因超长被截断或无法解析。"
                "重新输出完整 JSON，并强制压缩：最多 5 个 visual_objects、"
                "3-4 个 beat；重复成员一律用 params.count 分组压缩，"
                "禁止逐个声明成员；每个自然语言字段只写一个短句。"
            )
            try:
                done = await author_plan(compact_prompt)
                plan = _parse_plan(done)
                raw_artifacts.append(_raw_plan_artifact(done, ctx))
            except Exception:
                logger.exception("visual_plan compact retry failed")
                plan = None
        if plan is None:
            return ToolResult(
                success=False,
                summary="无法解析视觉计划（含一次压缩重试）；已保存模型原始输出用于诊断",
                data={
                    "finish_reason": getattr(done, "finish_reason", ""),
                    "visible_chars": len(getattr(done, "text", "") or ""),
                },
                artifacts=raw_artifacts,
                error="parse_failed",
            )
        plan = ground_visual_plan_from_math_execution(plan, ctx)
        errors = _validate_plan(plan, grade)
        if errors:
            # Near-miss plans deserve one evidence-directed retry: feed the
            # exact violations back before falling to deterministic salvage.
            contract_feedback = (
                "\n\n## 上一份计划未通过结构契约\n"
                + "\n".join(f"- {error}" for error in errors[:6])
                + "\n重新输出完整 JSON 并逐项修正以上问题；未变动的部分保持原样。"
                "所有 targets/result/source/destination 必须引用已在 visual_objects "
                "中声明的 id；take_from 的 style 只能是 cross_out/fade/fly；"
                "count 的 expect 必须等于该组经历全部动作后的当前数量。"
            )
            try:
                retry_done = await author_plan(prompt + contract_feedback)
                raw_artifacts.append(_raw_plan_artifact(retry_done, ctx))
                retry_plan = _parse_plan(retry_done)
                if retry_plan is not None:
                    retry_plan = ground_visual_plan_from_math_execution(retry_plan, ctx)
                    retry_errors = _validate_plan(retry_plan, grade)
                    if not retry_errors:
                        done = retry_done
                        plan = retry_plan
                        errors = []
                    elif len(retry_errors) < len(errors):
                        done = retry_done
                        plan = retry_plan
                        errors = retry_errors
            except Exception:
                logger.exception("visual_plan contract retry failed")
        if errors:
            ctx.state["visual_plan_last_violations"] = errors
            ctx.state["visual_plan_retry_count"] = (
                int(ctx.state.get("visual_plan_retry_count", 0)) + 1
            )
            return ToolResult(
                success=False,
                summary="视觉计划结构不完整（含一次契约重试）：" + "；".join(errors[:3]),
                data={"plan": plan, "violations": errors},
                artifacts=raw_artifacts,
                error="contract_violation",
            )

        # A structurally valid plan can still contain contradictory numbers
        # or an action whose end state does not prove its caption. Audit this
        # artifact before code generation so the code model never receives a
        # mathematically unstable directing contract.
        audit_warning: str | None = None
        try:
            audit_done = await self._llm.chat_complete(
                messages=[
                    ChatMessage(
                        role="user",
                        content=self._prompts.render(
                            "audit_visual_plan",
                            problem=problem,
                            answer=answer,
                            steps_text="\n".join(solution_lines),
                            visual_plan_text=json.dumps(plan, ensure_ascii=False, indent=2),
                        ),
                    )
                ],
                temperature=0.0,
                max_tokens=4096,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            audit_text = (getattr(audit_done, "text", "") or "") or (
                getattr(audit_done, "reasoning", "") or ""
            )
            audit = _parse_plan_audit(audit_text)
        except Exception as exc:
            logger.exception("visual plan audit failed")
            audit = None
            audit_warning = f"视觉计划独立审计调用失败: {exc}"
        if audit is None:
            audit_warning = audit_warning or "视觉计划独立审计格式无效"
        else:
            consistent, audit_issues, checked_claims, corrected_plan = audit
            blocking = [issue for issue in audit_issues if _machine_checkable_blocking_issue(issue)]
            if not consistent and blocking:
                corrected_errors: list[str] = []
                if corrected_plan is not None:
                    corrected_plan = _normalize_plan(corrected_plan)
                    corrected_plan = ground_visual_plan_from_math_execution(corrected_plan, ctx)
                    corrected_errors = _validate_plan(corrected_plan, grade)
                if corrected_plan is not None and not corrected_errors:
                    plan = corrected_plan
                    plan["audit_auto_corrected"] = True
                    plan["audit_resolved_issues"] = blocking[:3]
                else:
                    violations = blocking + corrected_errors
                    ctx.state["visual_plan_last_violations"] = violations
                    ctx.state["visual_plan_retry_count"] = (
                        int(ctx.state.get("visual_plan_retry_count", 0)) + 1
                    )
                    return ToolResult(
                        success=False,
                        summary="视觉计划数学契约不一致：" + "；".join(violations[:2]),
                        data={"plan": plan, "violations": violations},
                        artifacts=[_raw_plan_artifact(done, ctx)],
                        error="plan_math_inconsistent",
                    )
            ignored_audit_opinions = [issue for issue in audit_issues if issue not in blocking]
            if ignored_audit_opinions:
                plan["audit_advisory_issues"] = ignored_audit_opinions[:3]
            plan["audit_checked_claims"] = checked_claims
        if audit_warning:
            plan["audit_warning"] = audit_warning

        # Keep the session-level attempt history. Resetting it here used to
        # make a later visual replan look like another cold start.
        store_visual_plan(ctx, plan)
        return ToolResult(
            success=True,
            summary=(
                f"开放式视觉计划完成：{len(plan['scenes'])} 个 beat；{plan['visual_thesis'][:60]}"
            ),
            data=plan,
        )
