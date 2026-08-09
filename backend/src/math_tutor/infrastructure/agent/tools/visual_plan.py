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
from ..math_runtime import evaluate_real_expression_at, sample_real_expression
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
}
_QUANTITY_ACTIONS = {"take_from", "combine", "count", "recount_verify", "replicate"}
_MUTATING_VISUAL_ACTIONS = {
    "transform",
    "move",
    "partition",
    "merge",
    "map",
    "take_from",
    "combine",
    "replicate",
}
_VERIFY_VISUAL_ACTIONS = {"compare", "measure", "verify", "recount_verify"}
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
    return errors


def _verified_arithmetic_candidate(ctx: ToolContext) -> dict[str, Any] | None:
    """Build Visual IR from literal equalities in independently verified steps."""
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
    objects = [
        item
        for item in (normalized.get("visual_objects") or [])
        if isinstance(item, dict)
        and item.get("id")
        and item.get("primitive") in _VISUAL_PRIMITIVES
        and item.get("meaning")
    ]
    if len(objects) < 2:
        verified_candidate = _verified_arithmetic_candidate(ctx)
        if verified_candidate is None or verified_candidate is candidate:
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
    if answer_object_id is None:
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
                if object_primitives.get(str(target)) in {"line", "arrow", "function_curve"}
            }
            created_coordinate_ids = {
                target
                for target in created_ids
                if object_primitives.get(str(target)) in {"line", "arrow", "function_curve", "dot"}
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
