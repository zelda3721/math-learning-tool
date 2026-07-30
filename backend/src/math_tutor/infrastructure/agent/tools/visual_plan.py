"""Open-world visual direction for a verified mathematical solution.

The contract deliberately describes *semantics* (what changes, what stays
invariant, and where attention should move) instead of choosing a problem
type or a named animation template.  New and transformed problems therefore
use the same planner without extending an enum.
"""

from __future__ import annotations

import json
import logging
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
from ..occupancy_table import parse_zone
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)

_VALID_ROLES = {"setup", "transform", "reveal", "verify"}
_VISUAL_PRIMITIVES = {
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
}
_MUTATING_VISUAL_ACTIONS = {"transform", "move", "partition", "merge", "map"}
_VERIFY_VISUAL_ACTIONS = {"compare", "measure", "verify"}
_SECTION_ALIASES = ("视觉计划", "视觉规划", "Visual Plan", "visual_plan", "计划")
_BACKTICKS = "`'\"‘’“”"
_ZONE_LIKE_RE = re.compile(r"[A-Fa-f][1-6]\s*[-–—~～to至]\s*[A-Fa-f][1-6]")
_SINGLE_ANCHOR_RE = re.compile(r"\b([A-Fa-f][1-6])\b")
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
                                    },
                                    "required": ["op", "targets", "result", "meaning"],
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
        payload.get("corrected_plan")
        if isinstance(payload.get("corrected_plan"), dict)
        else None,
    )


def _machine_checkable_blocking_issue(issue: str) -> bool:
    """Accept only falsifiable arithmetic/scalar conflicts as blockers."""
    text = str(issue or "")
    if not (
        text.startswith("BLOCKING:")
        and "observed=" in text
        and "expected=" in text
    ):
        return False
    for left, operator, right, result in _AUDIT_EQUALITY_RE.findall(text):
        a, b, expected_result = float(left), float(right), float(result)
        if operator == "+":
            actual = a + b
        elif operator == "-":
            actual = a - b
        elif operator in {"×", "x", "X", "*"}:
            actual = a * b
        elif b != 0:
            actual = a / b
        else:
            return True
        if abs(actual - expected_result) > 1e-8:
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


def _normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(plan, dict):
        return plan

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
            total = params.get("total")
            if primitive == "quantity_bar" and "value" not in params and total is not None:
                params["value"] = total
            elif primitive in {
                "dot", "circle", "rectangle", "line", "arrow", "polygon", "unit_grid"
            } and "count" not in params:
                try:
                    numeric_total = int(round(float(total)))
                except (TypeError, ValueError):
                    numeric_total = 0
                if 1 < numeric_total <= 64:
                    params["count"] = numeric_total
            item["params"] = params
    plan["visual_objects"] = visual_objects if isinstance(visual_objects, list) else []

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
                            target
                            for target in action["targets"]
                            if target in repeat_counts
                        ]
                        if len(counted_targets) >= 2:
                            source = max(counted_targets, key=repeat_counts.get)
                            divisor = min(counted_targets, key=repeat_counts.get)
                            source_count = repeat_counts[source]
                            divisor_count = repeat_counts[divisor]
                            result_count = repeat_counts[action["result"]]
                            if (
                                divisor_count > 0
                                and source_count / divisor_count == result_count
                            ):
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
                    count = int(round(float(
                        params.get("value", params.get("total_units"))
                    )))
                except (TypeError, ValueError):
                    count = 0
            if 1 < count <= 64:
                params["count"] = count
                if item.get("primitive") == "quantity_bar":
                    item["primitive"] = "unit_grid"
                    params.setdefault(
                        "columns", min(8, max(2, int(count**0.5 + 0.999)))
                    )
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
    answer_numbers = [
        float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", answer_text)
    ]
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
        text = " ".join(
            (operation_text, result_text, str(step.get("description") or ""))
        )
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
        result_numbers = [
            float(item) for item in _AUDIT_NUMBER_RE.findall(result_text)
        ]
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
        for left, operator, right in _AUDIT_OPERATION_RE.findall(
            normalized_operation
        ):
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
            index for index in range(len(equations) - 1, -1, -1)
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
            float(item)
            for item in re.findall(r"[-+]?\d+(?:\.\d+)?", ctx.problem or "")
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
                float(item)
                for item in re.findall(r"[-+]?\d+(?:\.\d+)?", normalized)
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

    values: list[float] = []
    for left, _, right, output, _ in equations:
        for value in (left, right, output):
            if value not in values:
                values.append(value)
    object_ids = {value: f"verified_value_{index}" for index, value in enumerate(values)}
    objects = []
    for value in values:
        count = int(round(abs(value))) if abs(value - round(value)) <= 1e-8 else 0
        params: dict[str, Any] = {"value": value}
        primitive = "quantity_bar"
        if 1 < count <= 64:
            primitive = "unit_grid"
            params.update(
                {
                    "count": count,
                    "columns": min(8, max(2, int(count**0.5 + 0.999))),
                }
            )
        objects.append(
            {
                "id": object_ids[value],
                "primitive": primitive,
                "meaning": f"已验证运算链中的数量 {number_label(value)}",
                "label": number_label(value),
                "color": "green" if value == answer_value else "blue",
                "params": params,
            }
        )

    produced: set[str] = set()
    setup_ids: list[str] = []
    actions: list[dict[str, Any]] = []
    for left, operator, right, output, step_text in equations:
        source_id = object_ids[left]
        operand_id = object_ids[right]
        result_id = object_ids[output]
        for object_id in (source_id, operand_id):
            if object_id not in produced and object_id not in setup_ids:
                setup_ids.append(object_id)
        if operator == "-" and abs(abs(left - right) - output) <= 1e-8:
            actions.append(
                {
                    "op": "compare",
                    "targets": [source_id, operand_id],
                    "result": "",
                    "meaning": f"直接显示 {number_label(left)} 与 {number_label(right)} 的差",
                }
            )
        action_op = "partition" if operator in {"÷", "/"} else "transform"
        actions.append(
            {
                "op": action_op,
                "targets": [source_id],
                "result": result_id,
                "meaning": step_text or (
                    f"{number_label(left)} {operator} {number_label(right)}"
                    f" = {number_label(output)}"
                ),
            }
        )
        produced.add(result_id)

    final_id = object_ids[answer_value]
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
                "actions": [{
                    "op": "create",
                    "targets": setup_ids,
                    "result": "",
                    "meaning": "建立已验证运算链的初始数量",
                }],
            },
            {
                "role": "transform",
                "anchor_zone": "A1-F6",
                "key_objects": ", ".join(object_ids.values()),
                "action": "逐步执行已验证等式对应的图形变化。",
                "invariant": "每个终态等于对应等式的结果",
                "attention_target": "数量在每一步如何改变",
                "exit_condition": "最终答案数量由连续变化得到",
                "teaching_line": "依次执行相同的运算，观察数量怎样到达答案。",
                "duration_s": max(6, min(16, 4 * len(equations))),
                "actions": actions,
            },
            {
                "role": "verify",
                "anchor_zone": "A1-F6",
                "key_objects": final_id,
                "action": "框选最终数量并核对答案。",
                "invariant": "最终数量满足已验证答案",
                "attention_target": "最终答案对象",
                "exit_condition": "答案对象清楚可见并可计数",
                "teaching_line": f"最后核对：{answer_text}",
                "duration_s": 4,
                "actions": [{
                    "op": "verify",
                    "targets": [final_id],
                    "result": "",
                    "meaning": "核对已验证答案",
                }],
            },
        ],
        "forbidden": ["只显示文字等式", "跳过中间数量状态"],
    }


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
    answer_numbers = [
        float(item) for item in re.findall(r"-?\d+(?:\.\d+)?", answer)
    ]
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
                len(label_numbers) == 1
                and label_numbers[0] == answer_value
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
            targets = [
                item for item in action.get("targets") or [] if item in object_by_id
            ]
            result = str(action.get("result") or "")
            if action.get("op") == "compare" and len(targets) >= 2:
                comparison = {
                    "op": "compare",
                    "targets": targets,
                    "result": "",
                    "meaning": action.get("meaning")
                    or "把已验证数量放在同一参照下直接比较",
                }
                if comparison not in preserved_comparisons:
                    preserved_comparisons.append(comparison)
            if (
                action.get("op") in {"transform", "partition", "map"}
                and targets
                and result in object_by_id
                and result not in targets
            ):
                transitions.append({
                    "op": action["op"],
                    "targets": targets,
                    "result": result,
                    "meaning": action.get("meaning") or "显示来源对象如何产生结果对象",
                })

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
                item for item in object_ids
                if object_by_id[item].get("primitive") != "axes"
            ]
            if len(non_axes) < 2:
                return None
            source_id, result_id = non_axes[0], non_axes[-1]
        transitions = [{
            "op": "transform",
            "targets": [source_id],
            "result": result_id,
            "meaning": "让来源图形逐步变为已验证关系中的结果图形",
        }]

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
            item for item in repeated_ids
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
    verify_creates = [
        item for item in verify_ids
        if item not in setup_ids and item != result_id
    ]
    steps = ctx.state.get("solution_steps") or []
    verified_line = "观察图形对象如何在共同参照中建立已验证关系。"
    if steps and isinstance(steps[0], dict):
        step = steps[0]
        verified_line = _strip_decorations(
            str(step.get("description") or step.get("result") or verified_line)
        )[:80]
    ledger = [
        f"{item.get('color') or 'blue'} {item['id']} = {item['meaning']}"
        for item in objects[:4]
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
                "key_objects": ", ".join(dict.fromkeys([
                    *source_ids,
                    *(str(item["result"]) for item in transitions),
                ])),
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
    if len(visual_objects) < 2:
        errors.append("visual_objects 至少需要 2 个承载数学意义的非文字图形对象")
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
        if primitive not in _VISUAL_PRIMITIVES:
            errors.append(
                f"visual_objects[{index}].primitive='{primitive}' 不在可组合图形原语集合中"
            )
        if not meaning:
            errors.append(f"visual_objects[{index}].meaning 为空，图形没有稳定数学含义")

    scenes = plan.get("scenes") or []
    transform_ops: set[str] = set()
    has_transform_scene = False
    visible_ids: set[str] = set()
    mapped_aliases: dict[str, str] = {}
    causal_transition_count = 0
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
                    f"场景 {index} action {action_index} 的 result 与来源相同，"
                    "没有可辨认的终态"
                )
            resolved_targets = [
                target
                for target in targets
                if target in visible_ids or target in mapped_aliases
            ]
            if op == "create":
                visible_ids.update(targets)
            elif op in {
                "transform", "move", "highlight", "partition", "merge",
                "compare", "map", "measure", "verify", "remove",
            }:
                missing_targets = [
                    target
                    for target in targets
                    if target not in visible_ids and target not in mapped_aliases
                ]
                if missing_targets:
                    errors.append(
                        f"场景 {index} action {action_index} 在对象出现前执行 {op}："
                        + ",".join(missing_targets)
                    )
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
        if role == "verify" and not (action_ops & _VERIFY_VISUAL_ACTIONS):
            errors.append("verify 场景必须通过 compare/measure/verify 图形动作核对结论")
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
    if has_transform_scene and not (transform_ops & _MUTATING_VISUAL_ACTIONS):
        errors.append("transform 场景序列必须包含会改变非文字图形状态的结构化动作")
    if has_transform_scene and causal_transition_count == 0:
        errors.append(
            "transform 场景只有对象罗列，没有对已出现对象执行可见的因果变化"
        )

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
        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                # Planning is a contract-writing stage. Low variance makes
                # the first plan internally consistent; diversity belongs in
                # explicit experiments, not in production retries.
                temperature=0.25,
                # A complete typed artifact is safer than truncation repair.
                # Compactness is enforced by the prompt; this is only a hard
                # ceiling for complex open-world geometry.
                max_tokens=6144,
                extra_body={
                    "chat_template_kwargs": {"enable_thinking": False},
                    # LM Studio and other modern OpenAI-compatible runtimes
                    # compile this schema into constrained decoding. The
                    # model chooses the mathematical content; the transport
                    # guarantees that the typed artifact is complete JSON.
                    "response_format": _VISUAL_PLAN_RESPONSE_FORMAT,
                },
            )
        except Exception as exc:
            logger.exception("visual_plan LLM call failed")
            return ToolResult(success=False, summary="视觉规划失败", error=str(exc))

        plan = _parse_plan(done)
        if plan is None:
            return ToolResult(
                success=False,
                summary="无法解析视觉计划；已保存模型原始输出用于诊断",
                data={
                    "finish_reason": getattr(done, "finish_reason", ""),
                    "visible_chars": len(getattr(done, "text", "") or ""),
                },
                artifacts=[_raw_plan_artifact(done, ctx)],
                error="parse_failed",
            )
        errors = _validate_plan(plan, grade)
        if errors:
            ctx.state["visual_plan_last_violations"] = errors
            ctx.state["visual_plan_retry_count"] = (
                int(ctx.state.get("visual_plan_retry_count", 0)) + 1
            )
            return ToolResult(
                success=False,
                summary="视觉计划结构不完整：" + "；".join(errors[:3]),
                data={"plan": plan, "violations": errors},
                artifacts=[_raw_plan_artifact(done, ctx)],
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
            blocking = [
                issue for issue in audit_issues if _machine_checkable_blocking_issue(issue)
            ]
            if not consistent and blocking:
                corrected_errors: list[str] = []
                if corrected_plan is not None:
                    corrected_plan = _normalize_plan(corrected_plan)
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
            ignored_audit_opinions = [
                issue for issue in audit_issues if issue not in blocking
            ]
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
