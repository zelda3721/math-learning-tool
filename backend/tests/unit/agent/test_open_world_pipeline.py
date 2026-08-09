from __future__ import annotations

import ast
import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from math_tutor.application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from math_tutor.infrastructure.agent.events import DoneEvent, ToolCallStart
from math_tutor.infrastructure.agent.learned_wiki import LearnedWiki, Lesson
from math_tutor.infrastructure.agent.loop import (
    AgentLoop,
    _allowed_tool_names,
    _compact_tool_data,
    _select_next_tool,
    _stage_budget_error,
)
from math_tutor.infrastructure.agent.markdown_extract import parse_json_anywhere
from math_tutor.infrastructure.agent.prompt_composer import PromptComposer
from math_tutor.infrastructure.agent.quality_metrics import (
    aggregate_quality_summaries,
    build_session_quality_summary,
    compare_quality_windows,
)
from math_tutor.infrastructure.agent.tool_registry import ToolRegistry
from math_tutor.infrastructure.agent.tools.compile_video import (
    CompileVideoTool,
    build_verified_fallback_code,
)
from math_tutor.infrastructure.agent.tools.inspect_video import (
    InspectVideoTool,
    _derive_technical_issues,
    _deterministic_visual_math_integrity,
    _finalize_review,
    _no_visual_argument,
    _parse_rate,
    _repair_scope,
)
from math_tutor.infrastructure.agent.tools.run_manim import _compact_manim_error
from math_tutor.infrastructure.agent.tools.solve_problem import (
    _invalid_literal_equalities,
    _solution_contract_issues,
)
from math_tutor.infrastructure.agent.tools.validate_manim_code import (
    _check_animation_api_misuse,
    _check_graphical_reasoning_contract,
    _check_hierarchical_label_band_conflicts,
    _check_problem_opening,
    _check_render_complexity,
    _check_scene_magnitude_contract,
    _check_stale_loop_indices,
    _check_structure,
    _check_teaching_contract,
    _check_visual_evidence_contract,
    _parse_semantic_audit,
    _teaching_similarity,
)
from math_tutor.infrastructure.agent.tools.verify_solution import (
    _add_safe_data_aliases,
    _classify_verification_failure,
    _parse_consistency_audit,
    _parse_data_object,
    _parse_logical_audit,
    _safe_exec_verify,
)
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _machine_checkable_blocking_issue,
    _normalize_plan,
    _parse_plan_audit,
    _validate_plan,
    build_grounded_math_visual_plan,
    ground_visual_plan_from_math_execution,
)
from math_tutor.infrastructure.agent.tools.watch_video import WatchVideoTool
from math_tutor.infrastructure.agent.wiki_ingester import (
    _copies_problem_content,
    _parse_lesson_decision,
)
from math_tutor.infrastructure.llm.openai_provider import _is_local_url
from math_tutor.infrastructure.media import build_narration_cues, render_webvtt
from math_tutor.infrastructure.storage.models import Artifact, Session, ToolCallRecord


def _open_world_plan(thesis: str = "让一个状态连续变化并在同一参照下显出目标关系") -> dict:
    return {
        "visual_thesis": thesis,
        "essence_rationale": "因为学生能看到状态变化与稳定参照的对应，所以结论由画面本身得到验证。",
        "symbol_ledger": ["blue object = changing state", "gold mark = stable reference"],
        "visual_objects": [
            {
                "id": "state",
                "primitive": "quantity_bar",
                "meaning": "the changing mathematical state",
                "label": "state",
                "color": "blue",
                "params": {"value": 7},
            },
            {
                "id": "reference",
                "primitive": "line",
                "meaning": "the invariant reference",
                "label": "reference",
                "color": "yellow",
                "params": {},
            },
            {
                "id": "final_state",
                "primitive": "quantity_bar",
                "meaning": "the verified final state",
                "label": "result",
                "color": "green",
                "params": {"value": 12},
            },
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "state and reference",
                "action": "establish both visible states",
                "invariant": "initial relation is fixed",
                "attention_target": "the reference",
                "exit_condition": "both meanings are visible",
                "teaching_line": "First fix the meaning of the stable reference.",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "create",
                        "targets": ["state", "reference"],
                        "result": "",
                        "meaning": "establish the state and stable reference",
                    }
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "state and reference",
                "action": "change the state while retaining the reference",
                "invariant": "declared relation remains true",
                "attention_target": "the changing gap",
                "exit_condition": "target state is reached",
                "teaching_line": "Watch only what changes while the reference remains fixed.",
                "duration_s": 6,
                "actions": [
                    {
                        "op": "transform",
                        "targets": ["state"],
                        "result": "final_state",
                        "meaning": "change the state while preserving the reference",
                    }
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "final state and check mark",
                "action": "compare the final state against the original relation",
                "invariant": "all constraints remain satisfied",
                "attention_target": "the visual check",
                "exit_condition": "the conclusion is checked on screen",
                "teaching_line": "Now check the final state against every constraint.",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "compare",
                        "targets": ["final_state", "reference"],
                        "result": "",
                        "meaning": "visually compare the result with the invariant",
                    }
                ],
            },
        ],
        "forbidden": ["text-only page changes", "decorative motion without semantics"],
    }


def test_json_extraction_uses_balanced_objects_and_ignores_braces_in_strings() -> None:
    text = '前言 {"discard": true} 后续 {"plan": "观察 {x} 的变化"} 尾声'
    assert parse_json_anywhere(text) == {"discard": True}


def test_json_extraction_accepts_safe_python_literal_from_local_model() -> None:
    text = "```json\n{'ok': True, 'items': [1, 2,],}\n```"
    assert parse_json_anywhere(text) == {"ok": True, "items": [1, 2]}


def test_json_extraction_does_not_invent_truncated_artifacts() -> None:
    assert parse_json_anywhere('{"visual_thesis": "unfinished"') is None


def test_visual_plan_accepts_unseen_free_form_thesis_and_temporal_zone_reuse() -> None:
    plan = _open_world_plan("an entirely new visual argument invented from the current semantics")
    assert _validate_plan(plan, "advanced") == []


def test_visual_plan_requires_reference_and_change_ledger_entries() -> None:
    plan = _open_world_plan()
    plan["symbol_ledger"] = ["stable reference = blue object"]
    assert any("至少 2 项" in issue for issue in _validate_plan(plan, "advanced"))


def test_visual_plan_requires_executable_graphics_and_mutating_actions() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = []
    issues = _validate_plan(plan, "advanced")
    assert any("visual_objects 至少需要 2 个" in issue for issue in issues)
    assert any("未知图形对象" in issue for issue in issues)

    plan = _open_world_plan()
    plan["scenes"][0]["actions"] = []
    assert any("actions 为空" in issue for issue in _validate_plan(plan, "advanced"))

    plan = _open_world_plan()
    plan["scenes"][1]["actions"] = [
        {
            "op": "highlight",
            "targets": ["state"],
            "result": "",
            "meaning": "draw attention without changing the state",
        }
    ]
    assert any("transform 场景序列必须包含" in issue for issue in _validate_plan(plan, "advanced"))


def test_visual_plan_rejects_listing_disguised_as_partition_and_map() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["state"],
            "result": "",
            "meaning": "claim grouping without a visible grouped result",
        },
        {
            "op": "map",
            "targets": ["final_state"],
            "result": "reference",
            "meaning": "claim a mapping before its source has appeared",
        },
    ]
    issues = _validate_plan(plan, "advanced")
    assert any("partition 缺少 result" in issue for issue in issues)
    assert any("在对象出现前执行 map" in issue for issue in issues)


def test_visual_plan_normalizes_domain_quantity_aliases() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][0].update(
        {"primitive": "line", "params": {"count_per_head": 2, "total": 70}}
    )
    plan["visual_objects"][1].update({"primitive": "circle", "params": {"total": 24}})
    normalized = _normalize_plan(plan)
    first_params = normalized["visual_objects"][0]["params"]
    second_params = normalized["visual_objects"][1]["params"]
    assert first_params["count_per_unit"] == 2
    assert "count" not in first_params
    assert second_params["count"] == 24


def test_visual_plan_lowers_object_features_and_causal_create_actions() -> None:
    plan = _open_world_plan()
    plan["scenes"][0]["actions"].append(
        {
            "op": "highlight",
            "targets": ["reference.origin"],
            "result": "",
            "meaning": "highlight a feature of the declared reference",
        }
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["final_state"],
            "result": "",
            "meaning": "introduce the successor state",
        }
    ]

    normalized = _normalize_plan(plan)

    assert normalized["scenes"][0]["actions"][-1]["targets"] == ["reference"]
    transition = normalized["scenes"][1]["actions"][0]
    assert transition["op"] == "transform"
    assert transition["targets"] == ["state"]
    assert transition["result"] == "final_state"
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_splits_parallel_result_arrays_into_single_result_actions() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["state", "reference"],
            "result": ["final_state", "state"],
            "meaning": "apply two visible successor changes",
        }
    ]
    actions = _normalize_plan(plan)["scenes"][1]["actions"]
    assert [action["targets"] for action in actions] == [["state"], ["reference"]]
    assert [action["result"] for action in actions] == ["final_state", "state"]


def test_visual_plan_resolves_stale_source_to_current_successor() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["state"],
            "result": "final_state",
            "meaning": "group the visible source",
        },
        {
            "op": "map",
            "targets": ["state"],
            "result": "reference",
            "meaning": "map the successor using the old semantic name",
        },
    ]
    actions = _normalize_plan(plan)["scenes"][1]["actions"]
    assert actions[0]["targets"] == ["state"]
    assert actions[1]["targets"] == ["final_state"]


def test_visual_plan_materializes_declared_source_before_causal_action() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["final_state"],
            "result": "state",
            "meaning": "partition a declared but not yet visible source",
        }
    ]
    actions = _normalize_plan(plan)["scenes"][1]["actions"]
    assert actions[0]["op"] == "create"
    assert actions[0]["targets"] == ["final_state"]
    assert actions[1]["op"] == "partition"
    assert _validate_plan(plan, "advanced") == []


def test_visual_plan_materializes_declared_verify_targets() -> None:
    plan = _open_world_plan()
    plan["visual_objects"].extend(
        [
            {
                "id": "left_result",
                "primitive": "unit_grid",
                "meaning": "first verified result subset",
                "label": "left",
                "color": "green",
                "params": {"count": 3},
            },
            {
                "id": "right_result",
                "primitive": "unit_grid",
                "meaning": "second verified result subset",
                "label": "right",
                "color": "yellow",
                "params": {"count": 4},
            },
        ]
    )
    plan["scenes"][-1]["actions"] = [
        {
            "op": "verify",
            "targets": ["left_result", "right_result"],
            "meaning": "verify both declared result subsets",
        }
    ]

    normalized = _normalize_plan(plan)
    actions = normalized["scenes"][-1]["actions"]

    assert actions[0]["op"] == "create"
    assert actions[0]["targets"] == ["left_result", "right_result"]
    assert actions[1]["op"] == "verify"
    assert not any(
        "在对象出现前执行 verify" in issue for issue in _validate_plan(normalized, "middle")
    )


def test_visual_plan_lowers_verify_role_highlight_to_verification() -> None:
    plan = _open_world_plan()
    plan["scenes"][-1]["actions"] = [
        {
            "op": "highlight",
            "targets": ["final_state"],
            "meaning": "use the visible result as the final check",
        }
    ]

    normalized = _normalize_plan(plan)
    actions = normalized["scenes"][-1]["actions"]

    assert actions[-1]["op"] == "verify"
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_accepts_relation_reveal_as_causal_transform() -> None:
    plan = _open_world_plan()
    plan["visual_objects"].append(
        {
            "id": "auxiliary",
            "primitive": "line",
            "meaning": "a new relation to the established state",
            "label": "relation",
            "color": "blue",
            "params": {"start": [2, -2], "end": [2, 5]},
        }
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["auxiliary"],
            "meaning": "reveal the relation line against the existing state",
        },
        {
            "op": "highlight",
            "targets": ["state"],
            "meaning": "focus the existing state at the new relation",
        },
    ]

    normalized = _normalize_plan(plan)

    auxiliary = next(item for item in normalized["visual_objects"] if item["id"] == "auxiliary")
    assert auxiliary["params"]["points"] == [[2, -2], [2, 5]]
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_accepts_focused_coordinate_overlay_and_parses_dot_pair() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "shared coordinate reference",
            "label": "",
            "color": "grey",
            "params": {"x_range": [-3, 3], "y_range": [-3, 3]},
        },
        {
            "id": "source_curve",
            "primitive": "function_curve",
            "meaning": "established graph",
            "label": "f",
            "color": "blue",
            "params": {"expression": "x**2 - 1"},
        },
        {
            "id": "derived_curve",
            "primitive": "function_curve",
            "meaning": "derived graphical relation",
            "label": "g",
            "color": "red",
            "params": {"expression": "2*x"},
        },
        {
            "id": "computed_point",
            "primitive": "dot",
            "meaning": "verified coordinate （1，0）",
            "label": "P",
            "color": "green",
            "params": {},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "source_curve"],
            "meaning": "establish the shared graph",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["derived_curve", "computed_point"],
            "meaning": "overlay the derived relation and computed point",
        },
        {
            "op": "highlight",
            "targets": ["derived_curve"],
            "meaning": "focus the new relation on the same axes",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["computed_point"],
            "meaning": "check the computed coordinate",
        }
    ]

    normalized = _normalize_plan(plan)
    point = next(item for item in normalized["visual_objects"] if item["id"] == "computed_point")

    assert point["params"]["x"] == 1
    assert point["params"]["y"] == 0
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_accepts_relation_line_with_new_focused_point() -> None:
    plan = _open_world_plan()
    plan["visual_objects"].extend(
        [
            {
                "id": "constraint_line",
                "primitive": "line",
                "meaning": "coordinate constraint",
                "label": "c",
                "color": "red",
                "params": {"x1": 2, "y1": -2, "x2": 2, "y2": 6},
            },
            {
                "id": "constrained_point",
                "primitive": "dot",
                "meaning": "new point on the constraint",
                "label": "P",
                "color": "green",
                "params": {"x": 2, "y": -1},
            },
        ]
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["constraint_line", "constrained_point"],
            "meaning": "add the constraint and its computed point",
        },
        {
            "op": "highlight",
            "targets": ["constrained_point"],
            "meaning": "focus the new point fixed by the constraint",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["constrained_point"],
            "meaning": "check the constrained point",
        }
    ]

    normalized = _normalize_plan(plan)
    line = next(item for item in normalized["visual_objects"] if item["id"] == "constraint_line")

    assert line["params"]["points"] == [[2, -2], [2, 6]]
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_accepts_multi_object_coordinate_relation_reveal() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "",
            "color": "grey",
            "params": {"x_range": [-2, 4], "y_range": [-2, 4]},
        },
        {
            "id": "curve",
            "primitive": "function_curve",
            "meaning": "known graph",
            "label": "f",
            "color": "blue",
            "params": {"expression": "x**2 - 1"},
        },
        {
            "id": "point",
            "primitive": "dot",
            "meaning": "computed coordinate",
            "label": "P",
            "color": "green",
            "params": {"x": 0, "y": -1},
        },
        {
            "id": "vertical",
            "primitive": "line",
            "meaning": "vertical constraint",
            "label": "x=0",
            "color": "red",
            "params": {"start": [0, -2], "end": [0, 4]},
        },
        {
            "id": "horizontal",
            "primitive": "line",
            "meaning": "horizontal constraint",
            "label": "y=-1",
            "color": "yellow",
            "params": {"start": [-2, -1], "end": [4, -1]},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "curve"],
            "meaning": "establish the shared graph",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["point", "vertical", "horizontal"],
            "meaning": "reveal constraints and their common point",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["point", "horizontal"],
            "meaning": "verify the common coordinate",
        }
    ]

    normalized = _normalize_plan(plan)

    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_lowers_coordinate_bar_to_exact_line_segment() -> None:
    plan = _open_world_plan()
    plan["visual_objects"].append(
        {
            "id": "height_indicator",
            "primitive": "quantity_bar",
            "meaning": "signed coordinate height",
            "label": "-1",
            "color": "purple",
            "params": {"start": [2, 0], "end": [2, -1], "value": -1},
        }
    )

    normalized = _normalize_plan(plan)
    indicator = next(
        item for item in normalized["visual_objects"] if item["id"] == "height_indicator"
    )

    assert indicator["primitive"] == "line"
    assert indicator["params"]["points"] == [[2, 0], [2, -1]]


def test_visual_plan_repairs_self_transform_with_delayed_relation_reveal() -> None:
    plan = _open_world_plan()
    plan["visual_objects"].append(
        {
            "id": "conclusion_line",
            "primitive": "line",
            "meaning": "declared conclusion relationship",
            "label": "result",
            "color": "yellow",
            "params": {"start": [-2, -1], "end": [6, -1]},
        }
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["state"],
            "result": "state",
            "meaning": "planner attempted an in-place semantic rewrite",
        },
        {
            "op": "highlight",
            "targets": ["state"],
            "meaning": "focus the established result",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "create",
            "targets": ["conclusion_line"],
            "meaning": "reveal the conclusion relationship",
        },
        {
            "op": "verify",
            "targets": ["state", "conclusion_line"],
            "meaning": "check the state against the relationship",
        },
    ]

    normalized = _normalize_plan(plan)
    transform_actions = normalized["scenes"][1]["actions"]
    verify_actions = normalized["scenes"][2]["actions"]

    assert all(action["result"] != action["targets"][0] for action in transform_actions)
    assert [action["op"] for action in transform_actions] == [
        "create",
        "highlight",
        "highlight",
    ]
    assert [action["op"] for action in verify_actions] == ["verify"]
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_lowers_bounded_aggregate_bars_for_addressable_actions() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][0].update({"primitive": "quantity_bar", "params": {"count": 24}})
    plan["visual_objects"][2].update({"primitive": "quantity_bar", "params": {"count": 12}})
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["state"],
            "result": "final_state",
            "meaning": "group addressable members",
        }
    ]
    objects = {item["id"]: item for item in _normalize_plan(plan)["visual_objects"]}
    assert objects["state"]["primitive"] == "unit_grid"
    assert objects["final_state"]["primitive"] == "unit_grid"
    assert objects["reference"]["primitive"] == "line"


def test_visual_plan_lowers_bounded_value_bar_for_mapping() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][2].update({"primitive": "quantity_bar", "params": {"value": 12}})
    plan["scenes"][1]["actions"] = [
        {
            "op": "map",
            "targets": ["state"],
            "result": "final_state",
            "meaning": "extract an addressable subset",
        }
    ]

    objects = {item["id"]: item for item in _normalize_plan(plan)["visual_objects"]}

    assert objects["final_state"]["primitive"] == "unit_grid"
    assert objects["final_state"]["params"]["count"] == 12


def test_visual_plan_lowers_exact_multi_source_map_to_partition() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][0].update({"primitive": "unit_grid", "params": {"count": 24}})
    plan["visual_objects"][1].update({"primitive": "line", "params": {"count": 2}})
    plan["visual_objects"][2].update({"primitive": "unit_grid", "params": {"count": 12}})
    plan["scenes"][1]["actions"] = [
        {
            "op": "map",
            "targets": ["state", "reference"],
            "result": "final_state",
            "meaning": "group a total by a declared unit size",
        }
    ]

    normalized = _normalize_plan(plan)
    action = normalized["scenes"][1]["actions"][-1]
    assert action["op"] == "partition"
    assert action["targets"] == ["state"]
    assert action["result"] == "final_state"


def test_visual_plan_uses_value_when_addressable_count_is_placeholder_one() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][0].update({"primitive": "rectangle", "params": {"count": 1, "value": 8}})
    plan["visual_objects"][2].update({"primitive": "rectangle", "params": {"count": 1, "value": 4}})
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["state"],
            "result": "final_state",
            "meaning": "divide addressable units equally",
        }
    ]
    objects = {item["id"]: item for item in _normalize_plan(plan)["visual_objects"]}
    assert objects["state"]["params"]["count"] == 8
    assert objects["final_state"]["params"]["count"] == 4


def test_visual_plan_normalizes_total_units_for_partition_result() -> None:
    plan = _open_world_plan()
    plan["visual_objects"][2].update(
        {
            "primitive": "line",
            "params": {"total_units": 12, "count_per_unit": 2},
        }
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "partition",
            "targets": ["state"],
            "result": "final_state",
            "meaning": "partition a total into addressable groups",
        }
    ]

    objects = {item["id"]: item for item in _normalize_plan(plan)["visual_objects"]}

    assert objects["final_state"]["primitive"] == "line"
    assert objects["final_state"]["params"]["count"] == 12
    assert objects["final_state"]["params"]["count_per_unit"] == 2


def test_visual_plan_ignores_descriptive_results_on_non_successor_actions() -> None:
    plan = _open_world_plan()
    plan["scenes"][0]["actions"][0]["result"] = "坐标系建立"
    normalized = _normalize_plan(plan)
    assert normalized["scenes"][0]["actions"][0]["result"] == ""
    assert _validate_plan(normalized, "advanced") == []


def test_visual_plan_preserves_undeclared_actions_for_codegen_diagnostics() -> None:
    plan = _open_world_plan()
    plan["scenes"][-1]["actions"].append(
        {
            "op": "merge",
            "targets": ["undeclared_left", "undeclared_right"],
            "result": "undeclared_total",
            "meaning": "hallucinated redundant verification action",
        }
    )

    normalized = _normalize_plan(plan)

    assert len(normalized["scenes"][-1]["actions"]) == 2
    assert normalized["scenes"][-1]["actions"][1]["op"] == "merge"
    assert any("未知图形对象" in issue for issue in _validate_plan(normalized, "advanced"))


def test_visual_plan_audit_parser_requires_machine_checkable_verdict() -> None:
    assert _parse_plan_audit(
        '{"consistent":false,"issues":["BLOCKING: count; observed=10; expected=20"],'
        '"checked_claims":["dimension change"],"corrected_plan":{"visual_thesis":"fixed"}}'
    ) == (
        False,
        ["BLOCKING: count; observed=10; expected=20"],
        ["dimension change"],
        {"visual_thesis": "fixed"},
    )
    assert _parse_plan_audit('{"consistent":"yes","issues":[]}') is None


def test_visual_plan_audit_blocks_only_falsifiable_math_conflicts() -> None:
    assert _machine_checkable_blocking_issue("BLOCKING: count; observed=10; expected=20")
    assert _machine_checkable_blocking_issue(
        "BLOCKING: arithmetic; observed=24 ÷ 3 = 12; expected=24 ÷ 3 = 8"
    )
    assert not _machine_checkable_blocking_issue(
        "BLOCKING: prefer another partition; observed=94 contains 70 and 24; "
        "expected=compare 94 with 70 and show 24"
    )
    assert not _machine_checkable_blocking_issue(
        "BLOCKING: add more anchors; observed=verify current objects; "
        "expected=also display 46 and 48 before 94"
    )
    assert not _machine_checkable_blocking_issue(
        "BLOCKING: prose field order; expected=8; observed=13 minus 5"
    )


def test_visual_plan_fills_only_safe_structural_omissions() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["invariant"] = ""
    plan["scenes"][2]["exit_condition"] = ""
    normalized = _normalize_plan(plan)
    assert normalized["scenes"][1]["invariant"]
    assert normalized["scenes"][2]["exit_condition"]
    assert _validate_plan(normalized, "advanced") == []


def test_lan_model_endpoint_bypasses_system_proxy() -> None:
    assert _is_local_url("http://192.168.3.29:1234/v1") is True
    assert _is_local_url("http://10.1.2.3:8000/v1") is True
    assert _is_local_url("https://api.openai.com/v1") is False


def test_verifier_safely_accepts_fraction_literals_but_not_code_execution() -> None:
    parsed = _parse_data_object('{"optimal_x": 5/3, "bounds": [0, 5]}')
    assert parsed == {"optimal_x": 5 / 3, "bounds": [0, 5]}
    assert _parse_data_object('{"x": __import__("os").system("id")}') is None
    passed, _ = _safe_exec_verify(
        "def verify(data):\n    import math\n    return isinstance(data, dict) and math.isclose(math.sqrt(4), 2)",
        {},
    )
    assert passed is True
    rejected, message = _safe_exec_verify("def verify(data):\n    import os\n    return True", {})
    assert rejected is False and "禁止的导入" in message


def test_legacy_pattern_is_read_only_as_free_text_not_enum() -> None:
    legacy = _open_world_plan()
    legacy["primary_pattern"] = "never-before-seen-mechanism"
    legacy.pop("visual_thesis")
    normalized = _normalize_plan(legacy)
    assert normalized["visual_thesis"] == "never-before-seen-mechanism"
    assert "primary_pattern" not in normalized


def test_controller_excludes_type_routing_and_single_session_memory() -> None:
    prompt = PromptComposer().compose(
        grade="middle",
        use_latex=False,
        learned_context="single task instruction that must never leak",
    )
    assert "不调用 `match_skill`" in prompt
    assert "single task instruction" not in prompt
    assert "primary_pattern" not in prompt


def test_candidate_requires_three_independent_sessions_before_retrieval(tmp_path) -> None:
    wiki = LearnedWiki(tmp_path)
    for index in range(1, 4):
        candidate, _ = wiki.write_candidate(
            Lesson(
                title="Preserve semantic continuity across a transform",
                category="production",
                slug="preserve-semantic-continuity",
                body="Keep unchanged references on screen while the mathematical state changes.",
                keywords=["continuity", "transform", "reference"],
                session_origins=[f"session-{index}"],
            )
        )
        promoted = wiki.promote_candidate(candidate.slug, candidate.category)
        if index < 3:
            assert promoted is None
            assert wiki.list_lessons() == []
        else:
            assert promoted is not None
            assert len(wiki.list_lessons()) == 1


def test_ingest_rejects_non_universal_rule() -> None:
    decision = """
## Lesson Decision

**verdict**: write
**scope**: task-specific
**category**: production
**slug**: task-only-rule
**title**: Task only rule
**keywords**: task, only, rule

### body
This is long enough to parse but must remain excluded because its scope is narrow.
"""
    assert _parse_lesson_decision(decision) is None


def test_candidate_rejects_verbatim_problem_content() -> None:
    lesson = Lesson(
        title="Copied content",
        category="production",
        slug="copied-content",
        body="The exact statement opaque-current-relation-abcdef should be animated.",
    )
    assert (
        _copies_problem_content(
            lesson, "opaque-current-relation-abcdef with an additional condition"
        )
        is True
    )


def test_validator_allows_legitimate_3d_scene() -> None:
    code = """from manim import *

class SolutionScene(ThreeDScene):
    def construct(self):
        self.wait(1)
"""
    assert _check_structure(code, use_latex=False) == []


def test_generated_code_stays_out_of_controller_history() -> None:
    compact = _compact_tool_data(
        "generate_manim_code", {"code": "x" * 50_000, "fix_scope": "global"}
    )
    assert compact == {
        "code_stored_in_state": True,
        "code_chars": 50_000,
        "fix_scope": "global",
    }


def test_logical_verification_requires_all_evidence_sections() -> None:
    incomplete = """
**结论**: pass
### 前提与条件覆盖
- all premises covered
### 步骤审计
- every implication checked
"""
    passed, message, _ = _parse_logical_audit(incomplete)
    assert passed is False
    assert "缺少证据区" in message


def test_controller_exposes_only_next_valid_stage() -> None:
    state: dict = {}
    assert _allowed_tool_names(state, review_available=True) == {"solve_problem"}
    state["solution_steps"] = [{"description": "derive"}]
    assert _allowed_tool_names(state, review_available=True) == {"verify_solution"}
    state["solution_verified"] = True
    assert _allowed_tool_names(state, review_available=True) == {"direct_video"}
    state["visual_plan"] = _open_world_plan()
    assert _allowed_tool_names(state, review_available=True) == {"compile_video"}
    state["latest_video_path"] = "video.mp4"
    assert _allowed_tool_names(state, review_available=True) == {"watch_video"}
    state["last_visual_review"] = {"overall_quality": "good"}
    state["last_visual_failed"] = False
    assert _allowed_tool_names(state, review_available=True) == set()


def test_graphical_reasoning_gate_rejects_text_slides_and_requires_real_transform() -> None:
    text_slides = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        first = Text('step one')
        second = Text('step two')
        self.play(Write(first))
        self.play(Transform(first, second))
"""
    issues = _check_graphical_reasoning_contract(text_slides, _open_world_plan())
    assert any("至少需要两个" in issue for issue in issues)
    assert any("非文字数学对象" in issue for issue in issues)

    static_shapes = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        left = Circle()
        right = Square()
        self.play(FadeIn(left), FadeIn(right))
"""
    issues = _check_graphical_reasoning_contract(static_shapes, _open_world_plan())
    assert any("transform beat" in issue for issue in issues)

    visual_transform = static_shapes.replace(
        "self.play(FadeIn(left), FadeIn(right))",
        "self.play(FadeIn(left), FadeIn(right))\n        self.play(Transform(left, right.copy()))",
    )
    assert _check_graphical_reasoning_contract(visual_transform, _open_world_plan()) == []

    tracker_driven_transform = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        axes = Axes()
        tracker = ValueTracker(0)
        def moving_line():
            return Line(ORIGIN, RIGHT * (1 + tracker.get_value()))
        gap = always_redraw(moving_line)
        self.play(Create(axes), Create(gap))
        self.play(tracker.animate.set_value(2))
"""
    assert _check_graphical_reasoning_contract(tracker_driven_transform, _open_world_plan()) == []


def test_bounded_recovery_policy_reuses_runnable_code_for_one_visual_fix() -> None:
    state = {
        "analysis": {"question": "goal"},
        "solution_steps": [{}],
        "solution_verified": True,
        "visual_plan": _open_world_plan(),
        "latest_manim_code": "code",
        "last_validation_passed": True,
        "latest_video_path": "video.mp4",
        "last_visual_review": {"overall_quality": "bad"},
        "last_visual_failed": True,
        "visual_fail_count": 1,
    }
    assert _select_next_tool(state, review_available=True) == "watch_video"
    state["force_visual_replan"] = True
    assert _select_next_tool(state, review_available=True) == "watch_video"


def test_direct_video_degrades_to_minimal_narrative_instead_of_dying() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(
                success=False,
                summary="数学叙事不一致",
                data={"plan": _open_world_plan()},
                error="plan_math_inconsistent",
            )

    planner = Planner()
    tool = DirectVideoTool(planner)  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        3,
        "middle",
        "任意新问题",
        {
            "solution_verified": True,
            "solution_answer": "答案是 8",
            "solution_steps": [{"description": "建立已验证关系", "result": "先得到 5"}],
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    # No whole-plan stochastic retry (single planner call), but the stage
    # never ends empty-handed: a minimal verified-quantity narrative ships
    # with an explicit degradation warning for the review stage.
    assert planner.calls == 1
    assert result.success is True
    assert ctx.state["visual_plan"]["grounding_source"] == "minimal_narrative"
    assert ctx.state["visual_plan"]["degraded_plan"] is True
    assert "降级" in result.summary
    assert ctx.state["plan_degraded"]


def test_parse_failure_uses_verified_drawable_math_evidence() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(
                success=False,
                summary="模型输出被截断，JSON 未闭合",
                error="parse_failed",
            )

    state = {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "limit_value",
                    "op": "limit",
                    "expression": "sin(x)/x",
                    "variable": "x",
                    "point": 0,
                }
            ],
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "limit_value", "result": "1"}],
        },
    }
    ctx = ToolContext("s", 3, "advanced", "求给定表达式的极限", state)
    planner = Planner()
    tool = DirectVideoTool(planner)  # type: ignore[arg-type]

    result = asyncio.run(tool.execute({}, ctx))

    assert result.success is True
    assert planner.calls == 0
    plan = build_grounded_math_visual_plan(ctx)
    assert plan is not None
    assert plan["grounded_from_math_execution"] is True
    assert _validate_plan(plan, "advanced") == []
    assert "sin(x)/x" in str(plan["visual_objects"])
    assert "tan" not in str(plan["visual_objects"])
    point = next(
        item for item in plan["visual_objects"] if item["id"] == "grounded_result_intersection"
    )
    assert point["params"]["open"] is True
    code = build_verified_fallback_code(ctx)
    assert "sampled_segments" in code
    assert "'grounded_expression_focus'" in code and "'label': ''" in code
    ast.parse(code)


def test_grounded_math_plan_visualizes_any_univariate_solve_as_zero_crossing() -> None:
    state = {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "solve_eq",
                    "op": "solve",
                    "expression": "2**x - 8",
                    "variable": "x",
                }
            ],
            "claims": [{"relation": "equal", "left": "$solve_eq", "right": "[3]"}],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "solve_eq", "result": ["3"]}],
        },
    }
    ctx = ToolContext("s", 3, "advanced", "solve an equation", state)

    plan = build_grounded_math_visual_plan(ctx)

    assert plan is not None
    assert plan["grounded_from_math_execution"] is True
    curve = next(item for item in plan["visual_objects"] if item["id"] == "grounded_solve_curve")
    roots = next(item for item in plan["visual_objects"] if item["id"] == "grounded_solve_roots")
    assert curve["params"]["expression"] == "2**x - 8"
    assert roots["params"]["positions"] == [[3.0, 0]]
    assert _validate_plan(plan, "advanced") == []
    ctx.state["visual_plan"] = plan
    code = build_verified_fallback_code(ctx)
    assert "2**x - 8" in code
    assert "grounded_solve_roots" in code
    ast.parse(code)


def test_grounded_math_plan_does_not_mistake_intermediate_solve_for_final_roots() -> None:
    state = {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "original",
                    "op": "evaluate",
                    "expression": "x**2 - 4*x + 3",
                    "variable": "x",
                },
                {
                    "id": "derivative",
                    "op": "differentiate",
                    "expression": "$original",
                    "variable": "x",
                },
                {
                    "id": "critical",
                    "op": "solve",
                    "expression": "$derivative",
                    "variable": "x",
                },
                {
                    "id": "value",
                    "op": "substitute",
                    "expression": "$original",
                    "substitutions": {"x": "$critical[0]"},
                },
            ],
            "claims": [{"relation": "equal", "left": "$value", "right": "-1"}],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [
                {"id": "original", "result": "x**2 - 4*x + 3"},
                {"id": "derivative", "result": "2*x - 4"},
                {"id": "critical", "result": ["2"]},
                {"id": "value", "result": "-1"},
            ],
        },
    }
    ctx = ToolContext("s", 3, "advanced", "opaque problem", state)

    plan = build_grounded_math_visual_plan(ctx)

    assert plan is not None
    assert "grounded_solve_curve" not in str(plan)
    assert "x**2 - 4*x + 3" in str(plan)
    point = next(
        item for item in plan["visual_objects"] if item["id"] == "grounded_result_intersection"
    )
    assert point["params"]["x"] == 2.0
    assert point["params"]["y"] == -1.0
    assert _validate_plan(plan, "advanced") == []


def test_verified_matrix_contract_repairs_polygon_geometry_without_question_type() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "source",
            "primitive": "polygon",
            "meaning": "source coordinate region",
            "label": "source",
            "color": "blue",
            "params": {"vertices": [[0, 0], [1, 0], [1, 1], [0, 1]]},
        },
        {
            "id": "result",
            "primitive": "polygon",
            "meaning": "mapped coordinate region",
            "label": "result",
            "color": "red",
            "params": {"vertices": [[0, 0], [2, 3], [3, 4], [1, 1]]},
        },
        {
            "id": "answer_bar",
            "primitive": "quantity_bar",
            "meaning": "decorative duplicate of the measured result",
            "label": "area 5",
            "color": "green",
            "params": {"value": 5},
        },
    ]
    plan["scenes"][0]["actions"][0]["targets"] = ["source", "answer_bar"]
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["source"],
            "result": "result",
            "meaning": "apply the verified linear map",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "measure",
            "targets": ["result"],
            "result": "",
            "meaning": "measure the mapped coordinate area",
        },
        {
            "op": "verify",
            "targets": ["result", "answer_bar"],
            "result": "",
            "meaning": "verify the measured result",
        },
    ]
    state = {
        "verify_math_request": {
            "operations": [
                {
                    "id": "d",
                    "op": "determinant",
                    "expression": [[2, 1], [3, 4]],
                }
            ],
            "claims": [{"relation": "equal", "left": "$d", "right": "5"}],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "d", "op": "determinant", "result": "5"}],
        },
    }
    ctx = ToolContext("s", 3, "advanced", "opaque unseen prompt", state)

    grounded = ground_visual_plan_from_math_execution(_normalize_plan(plan), ctx)

    result = next(item for item in grounded["visual_objects"] if item["id"] == "result")
    assert result["params"]["vertices"] == [
        [0.0, 0.0],
        [2.0, 3.0],
        [3.0, 7.0],
        [1.0, 4.0],
    ]
    assert result["params"]["verified_measure"] == 5.0
    assert "answer_bar" not in {item["id"] for item in grounded["visual_objects"]}
    arrows = [item for item in grounded["visual_objects"] if item["primitive"] == "arrow"]
    assert [item["params"]["end"] for item in arrows] == [[2.0, 3.0], [1.0, 4.0]]
    assert _validate_plan(grounded, "advanced") == []


def test_quality_review_rechecks_verified_geometry_instead_of_trusting_frames() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "source",
            "primitive": "polygon",
            "meaning": "source coordinate region",
            "label": "source",
            "color": "blue",
            "params": {"vertices": [[0, 0], [1, 0], [1, 1], [0, 1]]},
        },
        {
            "id": "result",
            "primitive": "polygon",
            "meaning": "incorrect mapped region",
            "label": "result",
            "color": "red",
            "params": {
                "vertices": [[0, 0], [2, 3], [3, 4], [1, 1]],
                "verified_measure": 5,
            },
        },
    ]
    plan["scenes"][0]["actions"][0]["targets"] = ["source"]
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["source"],
            "result": "result",
            "meaning": "apply a verified map",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "measure",
            "targets": ["result"],
            "result": "",
            "meaning": "measure the result",
        }
    ]
    ctx = ToolContext(
        "s",
        5,
        "advanced",
        "opaque prompt",
        {
            "verify_math_request": {
                "operations": [
                    {
                        "id": "d",
                        "op": "determinant",
                        "expression": [[2, 1], [3, 4]],
                    }
                ]
            }
        },
    )

    integrity = _deterministic_visual_math_integrity(plan, ctx)

    assert integrity["passed"] is False
    assert any("坐标面积" in issue for issue in integrity["issues"])
    assert any("顶点不符合" in issue for issue in integrity["issues"])


def test_visual_plan_closes_vector_anchored_polygon_and_links_verification() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "source",
            "primitive": "polygon",
            "meaning": "source region",
            "label": "source",
            "color": "blue",
            "params": {"vertices": [[0, 0], [1, 0], [1, 1], [0, 1]]},
        },
        {
            "id": "result",
            "primitive": "polygon",
            "meaning": "vector-anchored result region",
            "label": "result",
            "color": "red",
            "params": {"vertices": [[0, 0], [2, 3], [3, 4], [1, 4]]},
        },
        {
            "id": "first_vector",
            "primitive": "arrow",
            "meaning": "first transformed basis",
            "label": "v1",
            "color": "green",
            "params": {"start": [0, 0], "end": [2, 3]},
        },
        {
            "id": "second_vector",
            "primitive": "arrow",
            "meaning": "second transformed basis",
            "label": "v2",
            "color": "green",
            "params": {"start": [0, 0], "end": [1, 4]},
        },
        {
            "id": "value",
            "primitive": "quantity_bar",
            "meaning": "verified scalar result",
            "label": "5",
            "color": "yellow",
            "params": {"value": 5},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {"op": "create", "targets": ["source"], "result": "", "meaning": "source"},
        {
            "op": "create",
            "targets": ["first_vector", "second_vector"],
            "result": "",
            "meaning": "vectors",
        },
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["source"],
            "result": "result",
            "meaning": "apply vector-defined transform",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {"op": "measure", "targets": ["result"], "result": "", "meaning": "measure"},
        {"op": "create", "targets": ["value"], "result": "", "meaning": "result value"},
        {"op": "verify", "targets": ["value"], "result": "", "meaning": "verify"},
    ]

    normalized = _normalize_plan(plan)

    result = next(item for item in normalized["visual_objects"] if item["id"] == "result")
    assert result["params"]["vertices"] == [
        [0.0, 0.0],
        [2.0, 3.0],
        [3.0, 7.0],
        [1.0, 4.0],
    ]
    verify = normalized["scenes"][-1]["actions"][-1]
    assert verify["targets"] == ["value", "result"]
    assert _validate_plan(normalized, "advanced") == []


def test_direct_video_salvages_graphics_when_local_model_omits_actions() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    incomplete = _open_world_plan()
    incomplete["scenes"][1]["actions"] = []
    incomplete["scenes"][2]["actions"] = []

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(
                success=False,
                summary="场景 actions 为空",
                data={"plan": incomplete},
                error="contract_violation",
            )

    planner = Planner()
    tool = DirectVideoTool(planner)  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        3,
        "middle",
        "任意新问题",
        {
            "solution_verified": True,
            "solution_answer": "已验证答案",
            "solution_steps": [{"description": "建立已验证关系"}],
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert planner.calls == 1
    plan = ctx.state["visual_plan"]
    assert _validate_plan(plan, "middle") == []
    transform_actions = plan["scenes"][1]["actions"]
    assert any(action["op"] == "transform" for action in transform_actions)


def test_direct_video_safe_plan_preserves_multi_step_causal_chain() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    incomplete = _open_world_plan()
    incomplete["visual_objects"].append(
        {
            "id": "intermediate",
            "primitive": "quantity_bar",
            "meaning": "a verified intermediate state",
            "label": "8",
            "color": "yellow",
            "params": {"value": 8},
        }
    )
    incomplete["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["state"],
            "result": "intermediate",
            "meaning": "first verified change",
        },
        {
            "op": "transform",
            "targets": ["intermediate"],
            "result": "final_state",
            "meaning": "second verified change",
        },
    ]
    incomplete["scenes"][2]["actions"] = []

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(
                success=False,
                summary="verify action missing",
                data={"plan": incomplete},
                error="contract_violation",
            )

    ctx = ToolContext(
        "s",
        3,
        "middle",
        "任意新问题",
        {
            "solution_verified": True,
            "solution_answer": "已验证答案",
            "solution_steps": [{"description": "连续执行两个等价变化"}],
        },
    )
    result = asyncio.run(
        DirectVideoTool(Planner()).execute({}, ctx)  # type: ignore[arg-type]
    )
    assert result.success is True
    actions = ctx.state["visual_plan"]["scenes"][1]["actions"]
    successors = [
        action["result"] for action in actions if action["op"] in {"transform", "partition", "map"}
    ]
    assert successors == ["intermediate", "final_state"]
    assert ctx.state["visual_plan"]["scenes"][2]["actions"][-1]["targets"] == ["final_state"]


def test_direct_video_safe_plan_grounds_final_transition_in_verified_answer() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    incomplete = _open_world_plan()
    incomplete["visual_objects"] = [
        {
            "id": "total",
            "primitive": "rectangle",
            "meaning": "verified total",
            "label": "13",
            "color": "purple",
            "params": {"value": 13},
        },
        {
            "id": "remaining",
            "primitive": "rectangle",
            "meaning": "verified remainder",
            "label": "8",
            "color": "yellow",
            "params": {"count": 1, "value": 8},
        },
        {
            "id": "two_groups",
            "primitive": "relation_node",
            "meaning": "two equal groups",
            "label": "2 groups",
            "color": "blue",
            "params": {},
        },
        {
            "id": "answer_value",
            "primitive": "rectangle",
            "meaning": "verified requested value",
            "label": "4",
            "color": "green",
            "params": {"count": 1},
        },
    ]
    incomplete["scenes"][0]["actions"] = [
        {"op": "create", "targets": ["total"], "result": "", "meaning": "show total"}
    ]
    incomplete["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["total"],
            "result": "remaining",
            "meaning": "show verified remainder",
        },
        {
            "op": "partition",
            "targets": ["remaining"],
            "result": "two_groups",
            "meaning": "split equally",
        },
    ]
    incomplete["scenes"][2]["actions"] = []

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(
                success=False,
                summary="verification omitted",
                data={"plan": incomplete},
                error="contract_violation",
            )

    ctx = ToolContext(
        "s",
        3,
        "middle",
        "任意新问题",
        {
            "solution_verified": True,
            "solution_answer": "x = 4",
            "solution_steps": [{"description": "连续执行等价变化"}],
        },
    )
    result = asyncio.run(
        DirectVideoTool(Planner()).execute({}, ctx)  # type: ignore[arg-type]
    )
    assert result.success is True
    plan = ctx.state["visual_plan"]
    structural = [
        action
        for action in plan["scenes"][1]["actions"]
        if action["op"] in {"transform", "partition", "map"}
    ]
    assert structural[-1]["op"] == "partition"
    assert structural[-1]["result"] == "answer_value"
    objects = {item["id"]: item for item in plan["visual_objects"]}
    assert objects["remaining"]["params"]["count"] == 8
    assert objects["answer_value"]["params"]["count"] == 4
    assert plan["scenes"][2]["actions"][-1]["targets"] == ["answer_value"]


def test_direct_video_rebuilds_missing_answer_object_from_verified_equalities() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    incomplete = _open_world_plan()
    incomplete["visual_objects"] = incomplete["visual_objects"][:2]
    incomplete["visual_objects"].append(
        {
            "id": "verification_formula",
            "primitive": "relation_node",
            "meaning": "代入答案后的验证公式",
            "label": "2(4)+5=13",
            "color": "green",
            "params": {},
        }
    )
    incomplete["scenes"][1]["actions"] = []
    incomplete["scenes"][2]["actions"] = []

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(
                success=False,
                summary="answer object omitted",
                data={"plan": incomplete},
                error="contract_violation",
            )

    ctx = ToolContext(
        "s",
        3,
        "middle",
        "解方程 2x + 5 = 13",
        {
            "solution_verified": True,
            "solution_answer": "x = 4",
            "solution_steps": [
                {"operation": "方程两边同时减去 5", "result": "2x = 8"},
                {"operation": "方程两边同时除以 2", "result": "x = 4"},
            ],
        },
    )
    result = asyncio.run(
        DirectVideoTool(Planner()).execute({}, ctx)  # type: ignore[arg-type]
    )
    assert result.success is True
    plan = ctx.state["visual_plan"]
    labels = {item["label"]: item for item in plan["visual_objects"]}
    # Quantity-verb emission: "13 - 5" is an in-place take_from (5 units get
    # crossed inside the whole; 8 is the mutated state of the source group,
    # not a fresh object), then "8 ÷ 2" keeps the legacy partition regrouping.
    assert {"13", "2", "4"}.issubset(labels)
    assert any(label.startswith("划去") for label in labels)
    take_actions = [
        action for action in plan["scenes"][1]["actions"] if action["op"] == "take_from"
    ]
    assert len(take_actions) == 1
    assert take_actions[0]["count"] == 5
    assert take_actions[0]["destination"].startswith("quantity_box")
    count_actions = [
        action for action in plan["scenes"][1]["actions"] if action["op"] == "count"
    ]
    assert count_actions and count_actions[0]["expect"] == 8
    structural = [
        action
        for action in plan["scenes"][1]["actions"]
        if action["op"] in {"transform", "partition", "map"}
    ]
    assert structural[-1]["op"] == "partition"
    answer_id = next(item["id"] for item in plan["visual_objects"] if item["label"] == "4")
    assert structural[-1]["result"] == answer_id
    assert plan["scenes"][2]["actions"][-1]["targets"][0] == answer_id


def test_direct_video_uses_verified_ir_without_retry_when_plan_is_unparseable() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    class Planner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        def __init__(self) -> None:
            self.calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(
                success=False,
                summary="无法解析视觉计划",
                error="parse_failed",
            )

    planner = Planner()
    ctx = ToolContext(
        "s",
        3,
        "middle",
        "解方程 2x + 5 = 13",
        {
            "solution_verified": True,
            "solution_answer": "x = 4",
            "solution_steps": [
                {"operation": "方程两边同时减去 5", "result": "2x = 8"},
                {"operation": "方程两边同时除以 2", "result": "x = 4"},
            ],
        },
    )

    result = asyncio.run(
        DirectVideoTool(planner).execute({}, ctx)  # type: ignore[arg-type]
    )

    assert result.success is True
    assert planner.calls == 1
    assert ctx.state["visual_plan"]["scenes"][2]["actions"][0]["op"] == "verify"


def test_stage_budget_allows_one_fallback_then_stops_blind_retries() -> None:
    assert _stage_budget_error("solve_problem", 0) is None
    message = _stage_budget_error("solve_problem", 1)
    assert message is not None
    assert "首轮" in message
    assert "停止继续试错" in message
    assert _stage_budget_error("verify_solution", 0) is None
    assert _stage_budget_error("verify_solution", 1) is None
    # Attempt 3 is the tool's forced-logical escalation; only a 4th pick stops.
    assert _stage_budget_error("verify_solution", 2) is None
    assert _stage_budget_error("verify_solution", 3) is not None
    assert _stage_budget_error("compile_video", 0) is None
    assert _stage_budget_error("compile_video", 1) is not None


def test_solution_contract_rejects_visible_scratchpad_self_correction() -> None:
    payload = {
        "answer": "4秒",
        "steps": [
            {
                "description": "求时间",
                "operation": "12 / 3 = 4",
                "explanation": "由已知关系得到",
                "result": "等等，让我重新核算，答案是4秒",
            }
        ],
    }
    issues = _solution_contract_issues(payload)
    assert any("等等" in issue for issue in issues)
    assert (
        _solution_contract_issues(
            {
                "answer": "4秒",
                "steps": [{"result": "代回全部条件后均成立"}],
            }
        )
        == []
    )


def test_solution_contract_flags_duplicate_steps_and_stale_final_number() -> None:
    step = {
        "description": "计算最终量",
        "operation": "14 × 14 × 3",
        "explanation": "由已知关系",
        "result": "588 立方厘米",
    }
    issues = _solution_contract_issues({"answer": "1254 立方厘米", "steps": [step, dict(step)]})
    assert any("重复" in issue for issue in issues)
    # Derivation mismatches are advisory (style/quality), never blocking:
    # independent verification owns math correctness.
    derivation = [issue for issue in issues if "1254" in issue]
    assert derivation and all(issue.startswith("建议：") for issue in derivation)


def test_solution_contract_flags_false_arithmetic_as_blocking() -> None:
    assert _invalid_literal_equalities(r"$24 \div 2 = 14$（只）") == ["24 / 2 = 14"]
    assert _invalid_literal_equalities(r"$24 \div 2 = 12$（只）") == []
    issues = _solution_contract_issues(
        {
            "answer": "甲21个，乙14个",
            "steps": [
                {"operation": "24 ÷ 2 = 12", "result": "乙有12个"},
                {"operation": "35 - 12 = 23", "result": "甲有23个"},
                {"operation": "23 + 12 = 35", "result": "全部条件成立"},
            ],
        }
    )
    derivation = [issue for issue in issues if "14" in issue and "21" in issue]
    assert derivation and all(issue.startswith("建议：") for issue in derivation)
    blocking = _solution_contract_issues(
        {"answer": "12", "steps": [{"operation": "24 ÷ 2 = 14", "result": "14"}]}
    )
    assert any("算术矛盾" in issue and not issue.startswith("建议：") for issue in blocking)


def test_solution_contract_normalizes_fraction_decimal_and_etc_usage() -> None:
    # '0.5' in the answer is derivable from a '1/2' step result.
    issues = _solution_contract_issues(
        {"answer": "0.5 米", "steps": [{"operation": "1 ÷ 2", "result": "1/2 米"}]}
    )
    assert not any("没有被任何步骤结果推导出来" in issue for issue in issues)
    # Enumerative '等等' (etc.) is legitimate prose, not a draft marker.
    issues = _solution_contract_issues(
        {
            "answer": "4",
            "steps": [{"result": "4", "description": "三角形、正方形等等图形都适用"}],
        }
    )
    assert not any("等等" in issue for issue in issues)
    # Self-interruption '等等，' is still flagged (advisory).
    issues = _solution_contract_issues(
        {"answer": "4", "steps": [{"result": "等等，我重新算一下，是4"}]}
    )
    assert any("等等" in issue for issue in issues)


def test_literal_arithmetic_checker_does_not_slice_symbolic_function_context() -> None:
    assert _invalid_literal_equalities(r"\lim_{x\to 0} \frac{\sin(x)}{x} = 1") == []
    assert _invalid_literal_equalities("f(0) = 1") == []
    assert _invalid_literal_equalities("2 + 3 = 6") == ["2 + 3 = 6"]
    assert _invalid_literal_equalities("f(2) = 2^2 - 4 * 2 + 3 = 4 - 8 + 3 = -1") == []
    assert _invalid_literal_equalities("2^3 = 9") == ["2**3 = 9"]


def test_verifier_schema_alias_repairs_only_unambiguous_role_prefix() -> None:
    code = 'def verify(data):\n    return data["answer_volume"] == data["volume"]'
    repaired = _add_safe_data_aliases(code, {"volume": 588})
    assert repaired["answer_volume"] == 588
    assert _add_safe_data_aliases(
        'def verify(data):\n    return data["mystery"]', {"volume": 588}
    ) == {"volume": 588}


def test_render_complexity_rejects_unreadable_literal_object_cloud() -> None:
    tree = ast.parse(
        """
for row in range(14):
    for column in range(14):
        tile = Cube(side_length=0.1)
"""
    )
    issues = _check_render_complexity(tree)
    assert any("196" in issue and "预算 96" in issue for issue in issues)


def test_scene_magnitude_contract_rejects_math_value_as_manim_size() -> None:
    tree = ast.parse(
        """
original_length = 20
paper = Square(side_length=original_length)
"""
    )
    issues = _check_scene_magnitude_contract(tree)
    assert any("side_length=20" in issue and "归一化" in issue for issue in issues)


def test_static_gate_rejects_reusing_caption_child_after_group_fadeout() -> None:
    code = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        caption_text = Text('first')
        caption_box = Rectangle()
        caption = VGroup(caption_box, caption_text)
        self.play(FadeIn(caption))
        self.play(FadeOut(caption))
        next_text = Text('second')
        self.play(Transform(caption_text, next_text))
"""
    issues = _check_structure(code, use_latex=False)
    assert any("字幕生命周期错误" in issue for issue in issues)


def test_executable_verification_survives_malformed_secondary_critic() -> None:
    from types import SimpleNamespace

    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class TwoStageLLM:
        calls = 0

        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            if self.calls == 1:
                return SimpleNamespace(
                    text="""## 验证
**验证模式**: executable
**题目数值**: {"expected_value": 4}
**答案数值**: {"answer_value": 4}
**预期**: 通过

```python
def verify(data):
    assert data["answer_value"] == data["expected_value"]
    return True
```""",
                    reasoning="",
                )
            return SimpleNamespace(text="critic emitted prose instead of JSON", reasoning="")

    state = {
        "solution_steps": [{"description": "derive", "result": "4"}],
        "solution_answer": "4",
    }
    ctx = ToolContext("session", 1, "middle", "求目标值", state)
    result = asyncio.run(
        VerifySolutionTool(TwoStageLLM(), PromptLibrary()).execute({}, ctx)  # type: ignore[arg-type]
    )

    assert result.success
    assert state["solution_verified"] is True
    assert result.data is not None
    assert "格式无效" in str(result.data["consistency_audit_warning"])


def test_self_contradictory_verifier_is_adjudicated_without_resolving() -> None:
    from types import SimpleNamespace

    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class AdjudicatingLLM:
        calls = 0

        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            if self.calls == 1:
                return SimpleNamespace(
                    text="""## 验证
**验证模式**: executable
**题目数值**: {"sample_x": 0.1}
**答案数值**: {"limit_value": 1}
**预期**: 通过

```python
def verify(data):
    import math
    observed = math.sin(data["sample_x"]) / data["sample_x"]
    assert math.isclose(observed, data["limit_value"], abs_tol=1e-6)
    return True
```""",
                    reasoning="",
                )
            return SimpleNamespace(
                text=(
                    '{"consistent": true, "issues": [], '
                    '"checked_claims": ["前提与结论一致", "推导条件成立"]}'
                ),
                reasoning="",
            )

    state = {
        "solution_steps": [{"description": "derive", "result": "1"}],
        "solution_answer": "1",
    }
    ctx = ToolContext("session", 1, "advanced", "求一个连续过程的结论", state)
    llm = AdjudicatingLLM()
    result = asyncio.run(
        VerifySolutionTool(llm, PromptLibrary()).execute({}, ctx)  # type: ignore[arg-type]
    )

    assert result.success is True
    assert llm.calls == 2
    assert state["solution_verified"] is True
    assert "忽略" in str(result.data["message"])


def test_tuple_false_verifier_uses_normalized_counterexample_channel() -> None:
    passed, message = _safe_exec_verify(
        "def verify(data):\n    return (False, 'finite sample is not a limit')",
        {},
    )
    assert passed is False
    assert message == "verify 返回 False: finite sample is not a limit"
    assert _classify_verification_failure(message, expected_pass=True) == "unconfirmed_assertion"


def test_compile_stage_owns_semantic_audit_without_exposing_validator() -> None:
    state = {
        "analysis": {"question": "goal"},
        "solution_steps": [{}],
        "solution_verified": True,
        "visual_plan": _open_world_plan(),
        "latest_manim_code": "code",
        "last_validation_passed": False,
        "last_validation_issues": ["独立语义审计返回格式无效"],
        "retry_semantic_audit": True,
    }
    assert _allowed_tool_names(state, review_available=True) == {"compile_video"}
    assert _select_next_tool(state, review_available=True) == "compile_video"


def test_video_probe_rejects_draft_or_static_output_without_problem_types() -> None:
    critical, warnings = _derive_technical_issues(
        {
            "width": 854,
            "height": 480,
            "fps": 15,
            "duration_s": 18,
            "has_audio": False,
            "visible_fraction_by_frame": [0.1] * 5,
            "blank_frame_count": 0,
            "adjacent_frame_difference": [0.001] * 4,
        }
    )
    assert any("分辨率" in issue for issue in critical)
    assert any("帧率" in issue for issue in critical)
    assert any("静态" in issue for issue in critical)
    assert any("无音轨" in warning for warning in warnings)
    assert _parse_rate("30000/1001") == 30000 / 1001


def test_video_review_uses_dense_temporal_sampling_by_default() -> None:
    tool = InspectVideoTool(object(), object())  # dependencies are not called here
    assert tool._frame_count == 12


def test_video_probe_warns_on_dense_caption_zone_without_guessing_overlap() -> None:
    critical, warnings = _derive_technical_issues(
        {
            "width": 1280,
            "height": 720,
            "fps": 30,
            "duration_s": 20,
            "visible_fraction_by_frame": [0.1] * 4,
            "blank_frame_count": 0,
            "caption_zone_occupancy": [0.04, 0.08, 0.31, 0.07],
            "adjacent_frame_difference": [0.02] * 3,
        }
    )
    assert not any("底部安全带" in issue for issue in critical)
    assert any("底部安全带" in warning for warning in warnings)


def test_static_evidence_gate_follows_free_form_countability_contract() -> None:
    plan = _open_world_plan()
    plan["scenes"][2]["action"] = "最终网格中的单位小方块必须可逐项数一数"
    code = """tiles = VGroup()
for row in range(10):
    tile = Rectangle(width=0.4, height=0.4, stroke_width=0)
    tiles.add(tile)
"""
    issues = _check_visual_evidence_contract(code, plan)
    assert any("单位可逐项计数" in issue for issue in issues)
    assert (
        _check_visual_evidence_contract(code.replace("stroke_width=0", "stroke_width=1"), plan)
        == []
    )


def test_static_evidence_gate_rejects_identical_live_label_anchors() -> None:
    code = """old_label = Text("old")
old_label.next_to(grid, UP, buff=0.2)
self.play(FadeIn(old_label))
new_label = Text("new")
new_label.next_to(grid, UP, buff=0.2)
self.play(FadeIn(new_label))
"""
    issues = _check_visual_evidence_contract(code, {})
    assert any("确定性标签重叠" in issue for issue in issues)
    fixed = code.replace(
        'new_label = Text("new")',
        'self.play(FadeOut(old_label))\nnew_label = Text("new")',
    )
    assert _check_visual_evidence_contract(fixed, {}) == []
    nearby = code.replace("buff=0.2", "buff=0.5", 1).replace(
        "new_label.next_to(grid, UP, buff=0.2)",
        "new_label.next_to(grid, UP)",
    )
    assert any("相邻标签带" in issue for issue in _check_visual_evidence_contract(nearby, {}))


def test_static_gate_requires_faithful_visible_problem_opening() -> None:
    problem = "一个未知的新问题：条件甲为7，求目标乙。"
    good = """from manim import *
PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"
class SolutionScene(Scene):
    def construct(self):
        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)
        self.play(Write(problem_card))
"""
    assert _check_problem_opening(good, problem) == []
    wrapped = good.replace(
        "self.play(Write(problem_card))",
        "problem_panel = VGroup(Rectangle(), problem_card)\n"
        "        self.play(Write(problem_panel))",
    )
    assert _check_problem_opening(wrapped, problem) == []
    class_constant = good.replace(
        'PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"\nclass SolutionScene(Scene):',
        'class SolutionScene(Scene):\n    PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"',
    ).replace("Text(PROBLEM_TEXT)", "Text(self.PROBLEM_TEXT)")
    assert _check_problem_opening(class_constant, problem) == []
    assert any(
        "忠实复制" in issue
        for issue in _check_problem_opening(good.replace("条件甲为7", "条件甲为8"), problem)
    )
    assert any(
        "未传给" in issue
        for issue in _check_problem_opening(
            good.replace("Text(PROBLEM_TEXT)", 'Text("开始解答")'), problem
        )
    )
    assert any(
        "未在" in issue
        for issue in _check_problem_opening(
            good.replace("self.play(Write(problem_card))", "self.wait(3)"), problem
        )
    )
    bad_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'caption = Text("先讲答案")\n        self.play(Write(caption))\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert any("第一个可见 beat" in issue for issue in _check_problem_opening(bad_first, problem))
    added_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'caption = Text("先讲策略")\n        self.add(caption)\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert any("第一个可见 beat" in issue for issue in _check_problem_opening(added_first, problem))
    nested_helper = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'def update_caption():\n            self.play(Write(Text("稍后字幕")))\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert _check_problem_opening(nested_helper, problem) == []
    camera_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT)",
        "self.camera.frame.scale(0.8)\n        problem_card = Text(PROBLEM_TEXT)",
    )
    assert any("camera.frame" in issue for issue in _check_problem_opening(camera_first, problem))


def test_video_probe_rejects_blank_opening_and_border_clipping() -> None:
    critical, warnings = _derive_technical_issues(
        {
            "width": 1280,
            "height": 720,
            "fps": 30,
            "duration_s": 20,
            "visible_fraction_by_frame": [0.004, 0.2, 0.3],
            "blank_frame_count": 0,
            "adjacent_frame_difference": [0.1, 0.1],
            "top_border_occupancy": [0.5, 0.1, 0.1],
            "side_border_occupancy": [0.1, 0.6, 0.1],
            "caption_zone_occupancy": [0.1, 0.2, 0.7],
        }
    )
    assert any("开场" in issue for issue in critical)
    assert any("顶部" in issue for issue in critical)
    assert any("左右" in issue for issue in critical)
    assert any("底部安全带" in warning for warning in warnings)


def test_teaching_lines_become_a_content_agnostic_caption_timeline() -> None:
    plan = _open_world_plan()
    cues = build_narration_cues(plan, actual_duration_s=28)
    assert len(cues) == 3
    assert cues[0].start_s < cues[0].end_s <= cues[1].start_s
    assert cues[-1].end_s <= 28
    vtt = render_webvtt(cues)
    assert vtt.startswith("WEBVTT")
    assert "00:00:" in vtt
    assert plan["scenes"][1]["teaching_line"] in vtt


def test_static_gate_requires_most_planned_teaching_lines_in_code() -> None:
    plan = _open_world_plan()
    lines = [scene["teaching_line"] for scene in plan["scenes"]]
    good_code = "\n".join(f'caption_{i} = Text("{line}")' for i, line in enumerate(lines))
    issues, matched, planned = _check_teaching_contract(good_code, plan)
    assert issues == []
    assert matched == planned == 3
    bad_issues, bad_matched, _ = _check_teaching_contract(
        'caption = Text("generic explanation")', plan
    )
    assert bad_matched == 0
    assert any("字幕契约" in issue for issue in bad_issues)


def test_teaching_contract_allows_distinct_semantic_paraphrases() -> None:
    planned = "观察高度增加时，底面边长如何同时缩短，体积由两种变化共同决定。"
    paraphrase = "盒子变高的同时底面缩小，体积取决于二者的平衡。"
    unrelated = "现在把最终答案写在屏幕中央。"
    assert _teaching_similarity(planned, paraphrase) >= 0.35
    assert _teaching_similarity(planned, unrelated) < 0.35


def test_teaching_contract_accepts_structurally_displayed_split_captions() -> None:
    plan = {
        "scenes": [
            {"teaching_line": "先建立基准并观察总量。"},
            {"teaching_line": "再把差额与单个对象的变化对应。"},
            {"teaching_line": "最后核对两个条件。"},
        ]
    }
    code = """TEACHING_LINES = ["基准画面", "差额画面", "对应画面", "核验画面"]
a = Text(TEACHING_LINES[0])
b = Text(TEACHING_LINES[1])
c = Text(TEACHING_LINES[2])
d = Text(TEACHING_LINES[3])
"""
    issues, matched, planned_count = _check_teaching_contract(code, plan)
    assert issues == []
    assert matched >= 3
    assert planned_count == 3

    frozen_code = """class SolutionScene:
    TEACHING_LINES = ["先建立基准并观察总量。", "再把差额与单个对象的变化对应。", "最后核对两个条件。"]
    def construct(self):
        caption = Text(self.TEACHING_LINES[0])
        self.add(caption)
"""
    frozen_issues, frozen_matched, _ = _check_teaching_contract(frozen_code, plan)
    assert frozen_matched == 1
    assert any("字幕契约" in issue for issue in frozen_issues)


def test_semantic_audit_parser_is_strict_and_reports_contradictions() -> None:
    parsed = _parse_semantic_audit(
        '```json\n{"consistent":false,"issues":["对象分组与标签冲突"],'
        '"checked_claims":["分组成员"]}\n```'
    )
    assert parsed == (False, ["对象分组与标签冲突"], ["分组成员"])
    assert _parse_semantic_audit(
        "审计结果如下：{'consistent': True, 'issues': [], 'checked_claims': ['公式']}\n额外说明"
    ) == (True, [], ["公式"])
    assert _parse_semantic_audit('{"consistent":"yes","issues":[],"checked_claims":[]}') is None


def test_malformed_semantic_audit_degrades_without_a_failed_workflow_turn() -> None:
    from types import SimpleNamespace

    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.validate_manim_code import ValidateManimCodeTool

    class MalformedAuditLLM:
        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            return SimpleNamespace(text="not-json", reasoning="")

    problem = "未知问题"
    code = """from manim import *
PROBLEM_TEXT = "未知问题"
TEACHING_LINES = ["展示当前关系"]
class SolutionScene(Scene):
    def construct(self):
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        self.wait(1)
        source = Circle(radius=1, color=BLUE)
        target = Square(side_length=1.6, color=GREEN).shift(RIGHT * 2)
        self.play(FadeOut(card), FadeIn(source), FadeIn(target))
        caption = Text(TEACHING_LINES[0])
        caption.to_edge(DOWN)
        self.play(FadeIn(caption), Transform(source, target.copy()))
        self.wait(1)
"""
    state = {
        "latest_manim_code": code,
        "solution_answer": "答案",
        "solution_steps": ["推导"],
        "visual_plan": {"scenes": [{"teaching_line": "展示当前关系"}]},
    }
    ctx = ToolContext("session", 1, "middle", problem, state)
    tool = ValidateManimCodeTool(MalformedAuditLLM(), PromptLibrary())  # type: ignore[arg-type]

    result = asyncio.run(tool.execute({}, ctx))
    assert result.success
    assert result.data is not None
    assert "降级到静态与成片审查" in str(result.data.get("semantic_audit_warning"))
    assert "retry_semantic_audit" not in state


def test_code_extraction_accepts_unclosed_or_balanced_markdown_fences() -> None:
    from math_tutor.infrastructure.agent.tools.generate_manim_code import (
        _ensure_problem_text,
        _extract_code,
        _sanitize_code,
    )

    source = "from manim import *\nclass SolutionScene(Scene):\n    pass"
    assert _extract_code(f"```python\n{source}\n```") == source
    assert _extract_code(f"```python\r\n{source}") == source
    assert _extract_code(f"Here is the source:\n{source}") == source
    assert "ShowCreation" not in _sanitize_code("self.play(ShowCreation(shape))")
    assert "Create(shape)" in _sanitize_code("self.play(ShowCreation(shape))")
    axis_labels = "axes_labels = axes.get_axis_labels()"
    pango_axis_labels = _sanitize_code(axis_labels)
    assert "get_axis_labels" not in pango_axis_labels
    assert "Text('x'" in pango_axis_labels and "Text('y'" in pango_axis_labels
    from math_tutor.infrastructure.manim import ManimExecutor

    executor = object.__new__(ManimExecutor)
    runtime_axis_labels = executor._sanitize_code(axis_labels)
    assert "get_axis_labels" not in runtime_axis_labels
    assert "Text('x'" in runtime_axis_labels and "Text('y'" in runtime_axis_labels
    axis_numbers = 'x_axis_config={"include_numbers": True}'
    assert '"label_constructor": Text' in _sanitize_code(axis_numbers)
    assert '"label_constructor": Text' in executor._sanitize_code(axis_numbers)
    selected_axis_numbers = 'y_axis_config={"numbers_to_include": range(0, 9, 2)}'
    assert '"label_constructor": Text' in _sanitize_code(selected_axis_numbers)
    assert '"label_constructor": Text' in executor._sanitize_code(selected_axis_numbers)
    legacy_graph = "line = axes.get_graph(fn, color=RED)\npoint = line.get_point_at_x(2)"
    for migrated_graph in (
        _sanitize_code(legacy_graph),
        executor._sanitize_code(legacy_graph),
    ):
        assert "line = axes.plot(fn, color=RED)" in migrated_graph
        assert "point = axes.i2gp(2, line)" in migrated_graph
    edge_label = "label_red.next_to(point, UP + RIGHT, buff=0.2)"
    for guarded_label in (_sanitize_code(edge_label), executor._sanitize_code(edge_label)):
        assert "label_red.shift_onto_screen(buff=0.3)" in guarded_label
        assert guarded_label.count("shift_onto_screen") == 1
    assert _sanitize_code(_sanitize_code(edge_label)).count("shift_onto_screen") == 1
    star = _sanitize_code("mark = Star(scale_factor=0.3, color=YELLOW)")
    assert "Star(color=YELLOW).scale(0.3)" in star
    layout_code = """TEACHING_LINES = ["first"]
caption = Text("Loading...", font_size=28)
caption.scale_to_fit_width(11.5)
volume_bar.set_height(target_h)"""
    sanitized_layout = _sanitize_code(layout_code)
    assert "Text(TEACHING_LINES[0]," in sanitized_layout
    assert "if caption.width > 11.5:" in sanitized_layout
    assert "volume_bar.stretch_to_fit_height(target_h)" in sanitized_layout
    inline_caption = (
        "Transform(caption, Text('next', font_size=24).scale_to_fit_width(11.5).center())"
    )
    sanitized_caption = _sanitize_code(inline_caption)
    assert ".scale_to_fit_width" not in sanitized_caption
    assert "Text('next', font_size=24).center()" in sanitized_caption
    assert "v_bar.copy().stretch_to_fit_height(h)" in _sanitize_code(
        "small_bar = v_bar.copy().set_height(h)"
    )
    nested = "class S:\n    def construct(self):\n        def phase():\n            pass\n        self.phase()"
    assert "self.phase()" not in _sanitize_code(nested)
    assert "phase()" in _sanitize_code(nested)
    filled = _sanitize_code("ball = Circle(radius=0.4, fill=True, fill_opacity=0.8, color=RED)")
    assert "fill=True" not in filled
    assert "fill_opacity=0.8" in filled
    assert "stroke_opacity=0" in _sanitize_code(
        "panel = Rectangle(stroke_color=NONE, fill_opacity=0.8)"
    )
    self_group = _sanitize_code("bg.become(VGroup(bg, txt).arrange(DOWN, buff=0.1))")
    assert self_group == "bg = VGroup(bg, txt).arrange(DOWN, buff=0.1)"
    animate_chain = _sanitize_code(
        "self.play(group.animate.set_fill(RED).animate.scale(0).fade(1))"
    )
    assert animate_chain == "self.play(group.animate.set_fill(RED).scale(0).fade(1))"
    parallel_animations = _sanitize_code(
        "self.play(left.animate.scale(1.05), right.animate.scale(1.05))"
    )
    assert parallel_animations == ("self.play(left.animate.scale(1.05), right.animate.scale(1.05))")
    legacy_play = _sanitize_code("self.play(removed.set_color, GREY, FadeOut(label))")
    assert legacy_play == "self.play(removed.animate.set_color(GREY), FadeOut(label))"
    anchored_caption = _sanitize_code(
        "self.play(Transform(caption, Text(TEACHING_LINES[2], font_size=24)))"
    )
    assert "Text(TEACHING_LINES[2], font_size=24).move_to(caption.get_center())" in anchored_caption
    number_line = _sanitize_code(
        "axis = NumberLine(x_range=[-5, 10, 1], include_numbers=True)\n"
        "dot.move_to([value * SCALE, 0, 0])\n"
        "label.move_to([(left + right) / 2 * SCALE, 0.3, 0])"
    )
    assert "include_numbers=True, label_constructor=Text" in number_line
    assert "dot.move_to(axis.n2p(value) + UP * (0))" in number_line
    assert "label.move_to(axis.n2p((left + right) / 2) + UP * (0.3))" in number_line
    captions = _sanitize_code(
        "        self.play(Write(get_caption(TEACHING_LINES[0])))\n"
        "        self.play(Write(get_caption(TEACHING_LINES[1])))"
    )
    assert "caption = get_caption(TEACHING_LINES[0])" in captions
    assert "Transform(caption, next_caption_2)" in captions
    moving = _sanitize_code(
        "class SolutionScene(Scene):\n"
        "    def construct(self):\n"
        "        self.camera.frame.save_state()\n"
    )
    assert "class SolutionScene(MovingCameraScene):" in moving
    arranged = _sanitize_code("balls.arrange_in_circle(buff=0.8, center=ORIGIN, arc_angle=PI)")
    assert "arrange_in_circle" not in arranged
    assert "balls.arrange(RIGHT, buff=0.8).move_to(ORIGIN)" in arranged
    colors = _sanitize_code(
        "class SolutionScene(Scene):\n"
        "    def construct(self):\n"
        "        GREEN = GREEN\n"
        "        RED = BLUE\n"
        "        dot = Dot(color=GREEN)\n"
    )
    assert "GREEN = GREEN" not in colors
    assert "RED = BLUE" not in colors
    assert "Dot(color=GREEN)" in colors
    assert "LIGHT_BLUE" not in _sanitize_code("Dot(color=LIGHT_BLUE)")
    dashed = _sanitize_code("line = Line(LEFT, RIGHT, stroke_dash_array=[4, 4], color=GRAY)")
    assert "stroke_dash_array" not in dashed
    assert "color=GRAY" in dashed
    tuple_group = _sanitize_code(
        "connections = []\nconnections.append((i, j, line))\ngroup = VGroup(*connections, title)\n"
    )
    assert "VGroup(*[item[-1] for item in connections], title)" in tuple_group
    caption_bg = _sanitize_code("caption.set_fill(BLACK, opacity=0.7)")
    assert "caption.add_background_rectangle(color=BLACK, opacity=0.7)" in caption_bg
    caption_state = _sanitize_code(
        'TEACHING_LINES = ["first"]\n'
        'caption = Text("", font_size=32).to_edge(DOWN)\n'
        'self.play(ReplacementTransform(caption, Text("next")))\n'
    )
    assert "caption = Text(TEACHING_LINES[0]," in caption_state
    assert "Transform(caption, Text" in caption_state
    move_target = _sanitize_code("self.play(MoveToTarget(items, target_position=box))")
    assert "items.animate.move_to(box)" in move_target
    list_layout = _sanitize_code(
        "balls = [make_ball(x) for x in data]\nballs.arrange(RIGHT, buff=0.6).shift(UP)\n"
    )
    assert "VGroup(*balls).arrange(RIGHT, buff=0.6)" in list_layout
    shifted_fade = _sanitize_code(
        'self.play(FadeIn(Text("prompt", font_size=32), DOWN))\nself.play(FadeOut(title, UP))\n'
    )
    assert 'FadeIn(Text("prompt", font_size=32), shift=DOWN)' in shifted_fade
    assert "FadeOut(title, shift=UP)" in shifted_fade
    assert "np.append(coord, 0)" in _sanitize_code("ball.move_to(coord)")
    assert "unit.move_to([x0 + c * dx, y0 - r * dy, 0])" in _sanitize_code(
        "unit.move_to(x0 + c * dx, y0 - r * dy)"
    )
    line_3d = _sanitize_code("leg = Line(start=(offset, -radius), end=(offset, -radius - height))")
    assert "start=(offset, -radius, 0)" in line_3d
    assert "end=(offset, -radius - height, 0)" in line_3d
    positional_line = _sanitize_code("mark = Line([x, y, 0], [x, y - height], color=YELLOW)")
    assert "Line([x, y, 0], [x, y - height, 0], color=YELLOW)" in positional_line
    safe_append = _sanitize_code("body.move_to(np.append(position, 0))")
    assert "if len(position) == 2 else position" in safe_append
    assert "list(balls).index(ball)" in _sanitize_code("balls.get_index(ball)")
    assert "get_part_by_class" not in _sanitize_code("feet = animal.get_part_by_class(Line)")
    used_family = _sanitize_code("feet = animal.get_part_by_class(Line)\nself.play(FadeOut(feet))")
    assert "animal.get_family()" in used_family
    assert "isinstance(part, Line)" in used_family
    broken_caption = (
        "self.play(Transform(caption, Text('next').move_to("
        "caption_box.get_center().move_to(caption.get_center()))))"
    )
    repaired_caption = _sanitize_code(broken_caption)
    assert ".get_center().move_to(" not in repaired_caption
    assert repaired_caption == _sanitize_code(repaired_caption)
    ambiguous_colors = _sanitize_code('label = Text("24 and 2", t2c={"24": RED, "2": ORANGE})')
    assert '"24": RED' in ambiguous_colors
    assert '"2": ORANGE' not in ambiguous_colors
    assert "buff=max(0.3, 0.2)" in _sanitize_code(
        "items.arrange_in_grid(rows=5, cols=7, buff=(0.3, 0.2))"
    )
    assert "background_rect" not in _sanitize_code('caption = Text("hello", background_rect=True)')
    visible_transform = _sanitize_code(
        "for unit in animals:\n"
        "    unit.become(make_target())\n"
        "self.play(*[Transform(unit, make_target()) for unit in animals])\n"
    )
    assert "unit.become" not in visible_transform
    assert "Transform(unit, make_target())" in visible_transform
    chained_text = _sanitize_code(
        'caption = Text("short", font_size=24).to_edge(DOWN).scale_to_fit_width(11.5)'
    )
    assert 'caption = Text("short", font_size=24).to_edge(DOWN)' in chained_text
    assert "if caption.width > 11.5:" in chained_text
    wrapped = _ensure_problem_text(
        'from manim import *\nPROBLEM_TEXT = """old"""',
        "这是一个很长的全新问题，其中包含若干条件和一个需要回答的目标，"
        "视频开场必须完整显示原文且不能缩成难以阅读的一行。",
    )
    assert "old" not in wrapped
    assert "\\n" in wrapped
    problem_literal = ast.literal_eval(
        re.search(r"PROBLEM_TEXT\s*=\s*(.+)", wrapped).group(1)  # type: ignore[union-attr]
    )
    assert max(len(line) for line in problem_literal.splitlines()) <= 22
    ordered = _ensure_problem_text(
        """from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        caption = Text("strategy")
        self.play(Write(caption))
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        self.wait(2)
        self.play(FadeOut(card))
""",
        "new problem",
    )
    assert ordered.index("self.play(Write(card))") < ordered.index("self.play(Write(caption))")
    assert ordered.index("self.play(FadeOut(card))") < ordered.index("self.play(Write(caption))")
    multiline_ordered = _ensure_problem_text(
        """from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        caption_bg = Rectangle()
        caption = Text("strategy")
        self.play(
            FadeIn(caption_bg),
            FadeIn(caption),
        )
        problem_card = Text(PROBLEM_TEXT)
        self.play(Write(problem_card))
        self.wait(2)
        self.play(FadeOut(problem_card))
""",
        "new problem",
    )
    assert multiline_ordered.index("self.play(Write(problem_card))") < multiline_ordered.index(
        "FadeIn(caption_bg)"
    )
    assert multiline_ordered.index("self.play(FadeOut(problem_card))") < multiline_ordered.index(
        "FadeIn(caption_bg)"
    )
    class_attr_ordered = _ensure_problem_text(
        _sanitize_code("""from manim import *
class SolutionScene(Scene):
    PROBLEM_TEXT = "old"
    def construct(self):
        caption = Text("strategy")
        self.add(caption)
        card = Text(self.PROBLEM_TEXT, font_size=20)
        self.play(Write(card))
        self.wait(2)
        self.play(FadeOut(card))
"""),
        "new problem",
    )
    assert "Text(self.PROBLEM_TEXT, font_size=40)" in class_attr_ordered
    assert class_attr_ordered.index("self.play(FadeOut(card))") < class_attr_ordered.index(
        "self.add(caption)"
    )
    atomic_opening = _ensure_problem_text(
        _sanitize_code("""from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        self.play(FadeIn(answer_hint))
        self.wait(3)
        self.play(FadeOut(card))
"""),
        "new problem",
    )
    assert atomic_opening.index("self.play(FadeOut(card))") < atomic_opening.index(
        "self.play(FadeIn(answer_hint))"
    )
    inline_problem = _ensure_problem_text(
        """from manim import *
class SolutionScene(Scene):
    def construct(self):
        self.play(Write(Text(PROBLEM_TEXT, font_size=30).to_edge(UP)))
        self.wait(3)
        self.play(FadeOut(Text(PROBLEM_TEXT, font_size=30).to_edge(UP)))
""",
        "当前未知问题",
    )
    assert "problem_card = Text(PROBLEM_TEXT" in inline_problem
    assert "self.play(Write(problem_card))" in inline_problem
    assert "self.play(FadeOut(problem_card))" in inline_problem
    missing_problem_card = _ensure_problem_text(
        """from manim import *
class SolutionScene(Scene):
    def construct(self):
        PROBLEM_TEXT = "old"
        title = Text("开始")
        self.play(Write(title))
""",
        "当前未知问题",
    )
    assert "problem_card = Text(PROBLEM_TEXT" in missing_problem_card
    assert missing_problem_card.index(
        "self.play(Write(problem_card))"
    ) < missing_problem_card.index("self.play(Write(title))")


def test_static_gate_rejects_display_text_as_category_state() -> None:
    code = """
from manim import *
class SolutionScene(Scene):
    def construct(self):
        is_different = left.get_text() != right.get_text()
"""
    issues = _check_structure(code, use_latex=False)
    assert any("完整显示文本" in issue for issue in issues)


def test_static_gate_rejects_class_helper_reading_construct_local() -> None:
    code = """
from manim import *
class SolutionScene(Scene):
    def construct(self):
        subtitle_y = -3
        self.set_caption("hello")
    def set_caption(self, text):
        caption = Text(text).set_y(subtitle_y)
"""
    issues = _check_structure(code, use_latex=False)
    assert any("set_caption" in issue and "subtitle_y" in issue for issue in issues)


def test_static_gate_rejects_stale_index_from_previous_layout_loop() -> None:
    tree = ast.parse(
        """for row in range(10):
    for col in range(10):
        make_tile(row, col)
for row in range(10):
    make_added_tile(row, col)
"""
    )
    issues = _check_stale_loop_indices(tree)
    assert any("col" in issue and "旧循环索引" in issue for issue in issues)
    fixed = ast.parse(
        """for row in range(10):
    for col in range(10):
        make_tile(row, col)
for row in range(10):
    for col in range(10, 12):
        make_added_tile(row, col)
"""
    )
    assert _check_stale_loop_indices(fixed) == []


def test_scope_refine_extracts_rich_traceback_location() -> None:
    from math_tutor.infrastructure.agent.scope_refine import extract_error_line

    traceback = (
        "/site-packages/manim/scene.py:237 in render\n"
        "/tmp/generated_scene.py:132 in construct\nNameError: missing"
    )
    assert extract_error_line(traceback) == 132


def test_verifier_program_fault_does_not_impugn_the_solution() -> None:
    assert (
        _classify_verification_failure("执行错误: TypeError: bad checker", expected_pass=True)
        == "verifier_fault"
    )
    assert (
        _classify_verification_failure("断言失败: claimed counterexample", expected_pass=True)
        == "unconfirmed_assertion"
    )
    assert (
        _classify_verification_failure("断言失败: actual counterexample", expected_pass=False)
        == "solution_failure"
    )
    assert (
        _classify_verification_failure("verify 返回 False（应返回 True）", expected_pass=False)
        == "solution_failure"
    )
    passed, message, _ = _parse_logical_audit(
        """**结论**: 推导过程符合定理要求
### 前提与条件覆盖
- 已核对前提
### 步骤审计
- 已核对步骤
### 边界与反例
- 未发现反例
### 独立检查
- 使用另一条路径核对
"""
    )
    assert passed is False
    assert message.startswith("逻辑审计结论格式无效：")


def test_independent_consistency_audit_parses_specific_contradictions() -> None:
    parsed = _parse_consistency_audit(
        '{"consistent": false, "issues": ["同一计数先写3，后写4"], "checked_claims": ["总数为10"]}'
    )
    assert parsed == (False, ["同一计数先写3，后写4"], ["总数为10"])
    assert _parse_consistency_audit('{"issues": []}') is None


def test_static_gate_rejects_unbounded_or_huge_generated_loops() -> None:
    base = "from manim import *\nclass SolutionScene(Scene):\n    def construct(self):\n"
    assert any(
        "while" in issue
        for issue in _check_structure(
            base + "        while True:\n            self.wait(1)", use_latex=False
        )
    )
    assert any(
        "range" in issue
        for issue in _check_structure(
            base + "        for i in range(10000):\n            self.wait(0.1)", use_latex=False
        )
    )


def test_static_gate_rejects_loop_shadowing_of_later_fadeout_target() -> None:
    code = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        volume_bar = Rectangle()
        for item in [1, 2, 3]:
            volume_bar = Rectangle(height=item)
        self.play(FadeOut(volume_bar))
"""
    issues = _check_structure(code, use_latex=False)
    assert any("覆盖" in issue and "volume_bar" in issue for issue in issues)


def test_static_gate_rejects_noop_or_unplayed_animation_patterns() -> None:
    tree = ast.parse("""class SolutionScene:
    def construct(self):
        self.play(Transform(group, group))
        caption.animate.become(other)
        self.play(self.get_caption(1))
        self.play(MoveToTarget(item))
""")
    issues = _check_animation_api_misuse(tree)
    assert any("同对象" in issue for issue in issues)
    assert any("未传给" in issue for issue in issues)
    assert any("不能确认" in issue for issue in issues)
    assert any("generate_target" in issue for issue in issues)
    fade_tree = ast.parse("self.play(FadeOut(Text('new object'))) ")
    assert any("未在场" in issue for issue in _check_animation_api_misuse(fade_tree))
    duplicate_tree = ast.parse("self.play(Transform(item, target), item.animate.set_fill(RED))")
    assert any(
        "重复驱动对象 item" in issue for issue in _check_animation_api_misuse(duplicate_tree)
    )
    mutated_target_tree = ast.parse("self.play(Transform(item, item.add(label)))")
    assert any(
        "动画前直接修改了源对象 item" in issue
        for issue in _check_animation_api_misuse(mutated_target_tree)
    )
    legacy_tree = ast.parse("self.play(item.set_color, RED)")
    assert any("旧式方法参数" in issue for issue in _check_animation_api_misuse(legacy_tree))
    drifting_caption = ast.parse(
        "self.play(Transform(caption, Text(TEACHING_LINES[2], font_size=24)))"
    )
    assert any("默认原点" in issue for issue in _check_animation_api_misuse(drifting_caption))


def test_static_gate_rejects_parent_and_child_labels_in_the_same_band() -> None:
    tree = ast.parse(
        """segments = VGroup()
remaining = segments[3:]
summary = Text("aggregate")
summary.next_to(remaining, DOWN, buff=0.3)
self.play(FadeIn(summary))
labels = VGroup()
for i in range(5):
    label = Text("unit")
    center = remaining[i].get_center()
    label.move_to(center + DOWN * 0.5)
    labels.add(label)
self.play(FadeIn(labels))
"""
    )
    issues = _check_hierarchical_label_band_conflicts(tree)
    assert any("summary" in issue and "labels" in issue and "DOWN" in issue for issue in issues)

    non_overlapping = ast.parse(
        """segments = VGroup()
remaining = segments[3:]
summary = Text("aggregate")
summary.next_to(remaining, UP, buff=0.3)
self.play(FadeIn(summary))
labels = VGroup()
for i in range(5):
    label = Text("unit")
    center = remaining[i].get_center()
    label.move_to(center + DOWN * 0.5)
    labels.add(label)
self.play(FadeIn(labels))
"""
    )
    assert _check_hierarchical_label_band_conflicts(non_overlapping) == []


def test_manim_error_compaction_preserves_exception_tail() -> None:
    compact = _compact_manim_error("header" * 1000 + "\nTypeError: actual cause")
    assert "traceback head omitted" in compact
    assert compact.endswith("TypeError: actual cause")


def test_session_quality_summary_measures_first_pass_without_type_labels() -> None:
    now = datetime.now(timezone.utc)
    session = Session(
        id="session",
        problem="opaque current problem",
        grade="middle",
        status="done",
        created_at=now,
        updated_at=now,
        final_video_path="video.mp4",
    )
    calls = [
        ToolCallRecord(
            id=f"call-{index}",
            session_id="session",
            turn_index=index,
            name=name,
            arguments={},
            status="success",
            created_at=now,
            duration_ms=100,
        )
        for index, name in enumerate(
            (
                "solve_problem",
                "verify_solution",
                "direct_video",
                "compile_video",
                "watch_video",
            ),
            start=1,
        )
    ]
    report = Artifact(
        id=1,
        session_id="session",
        kind="quality_report",
        path="quality.json",
        created_at=now,
        meta={
            "overall_quality": "good",
            "b_total": 10,
            "math_consistency": 2,
            "essence_delivery": 2,
            "technical_pass": True,
            "width": 1280,
            "height": 720,
            "fps": 30,
            "has_audio": False,
        },
    )
    subtitle = Artifact(
        id=2,
        session_id="session",
        kind="subtitle",
        path="captions.vtt",
        created_at=now,
        meta={"format": "webvtt", "language": "zh", "cue_count": 3},
    )
    summary = build_session_quality_summary(session, calls, [report, subtitle])
    assert summary["quality_gate_passed"] is True
    assert summary["first_pass_success"] is True
    assert summary["total_tool_latency_ms"] == 500
    assert "problem_type" not in summary
    aggregate = aggregate_quality_summaries([summary])
    assert aggregate["quality_gate_pass_rate"] == 1.0
    assert aggregate["first_pass_success_rate"] == 1.0
    assert aggregate["accessibility_pass_rate"] == 1.0


def test_quality_trend_detects_cross_session_regression_without_type_buckets() -> None:
    recent = [
        {
            "quality_gate_passed": False,
            "first_pass_success": False,
            "total_tool_latency_ms": 2000,
        }
        for _ in range(3)
    ]
    previous = [
        {
            "quality_gate_passed": True,
            "first_pass_success": True,
            "total_tool_latency_ms": 1000,
        }
        for _ in range(3)
    ]
    trend = compare_quality_windows(recent + previous, window_size=3)
    assert trend["status"] == "regression"
    assert "quality_gate_pass_rate" in trend["regressions"]
    assert "problem_type" not in str(trend)


def test_bounded_workflow_skips_controller_llm_calls() -> None:
    class NeverCalledLLM:
        calls = 0

        def chat_stream(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            raise AssertionError("controller LLM must not run in bounded mode")

    class MemoryStore:
        def __init__(self) -> None:
            self.updated: dict[str, Any] = {}
            self.artifact_id = 0

        async def create_session(self, **kwargs: Any) -> str:
            return "session"

        async def append_message(self, *args: Any, **kwargs: Any) -> int:
            return 1

        async def record_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def complete_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def update_session(self, session_id: str, **kwargs: Any) -> None:
            self.updated = kwargs

        async def save_text_artifact(self, *args: Any, **kwargs: Any) -> tuple[int, str]:
            self.artifact_id += 1
            return self.artifact_id, "quality.json"

        async def add_artifact(self, *args: Any, **kwargs: Any) -> int:
            self.artifact_id += 1
            return self.artifact_id

    class StageTool(ITool):
        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        @property
        def description(self) -> str:
            return self._name

        @property
        def parameters(self) -> dict[str, Any]:
            return {"type": "object", "properties": {}, "required": []}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            state = ctx.state
            if self.name == "solve_problem":
                state["analysis"] = {"question": "goal"}
                state["solution_steps"] = [{"description": "derive"}]
                state["solution_answer"] = "answer"
                state["solution_verified"] = False
            elif self.name == "verify_solution":
                state["solution_verified"] = True
            elif self.name == "direct_video":
                state["visual_plan"] = _open_world_plan()
            elif self.name == "compile_video":
                state["latest_manim_code"] = "code"
                state["last_validation_passed"] = True
                state["latest_video_path"] = "video.mp4"
                return ToolResult(
                    success=True,
                    summary="rendered",
                    artifacts=[
                        ArtifactSpec(
                            kind="video",
                            external_path="video.mp4",
                            meta={"url": "/video.mp4"},
                        )
                    ],
                )
            elif self.name == "watch_video":
                state["last_visual_review"] = {"overall_quality": "good"}
                state["last_visual_failed"] = False
            return ToolResult(success=True, summary="ok")

    registry = ToolRegistry()
    stage_names = (
        "solve_problem",
        "verify_solution",
        "direct_video",
        "compile_video",
        "watch_video",
    )
    for name in stage_names:
        registry.register(StageTool(name))
    llm = NeverCalledLLM()
    store = MemoryStore()
    loop = AgentLoop(
        llm=llm,  # type: ignore[arg-type]
        registry=registry,
        composer=PromptComposer(),
        store=store,  # type: ignore[arg-type]
        use_latex=False,
        # Exactly the five production stages: success must not require a
        # sixth empty controller turn.
        max_turns=5,
        deterministic_workflow=True,
    )

    async def collect() -> list[Any]:
        return [event async for event in loop.run(problem="opaque", grade="middle")]

    events = asyncio.run(collect())
    names = [event.name for event in events if isinstance(event, ToolCallStart)]
    done = [event for event in events if isinstance(event, DoneEvent)][-1]
    assert names == list(stage_names)
    assert llm.calls == 0
    assert done.status == "ok"
    assert done.final_video_path == "video.mp4"


def test_compile_video_prefers_visual_ir_compiler_without_a_generative_hop() -> None:
    class Unused:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise AssertionError("production Visual IR must not call free-form codegen")

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            code = str(args.get("code") or "")
            assert "VISUAL_OBJECTS" in code
            assert ctx.state.get("delivery_fallback") is not True
            ctx.state["latest_video_path"] = "compiled.mp4"
            ctx.state["latest_video_url"] = "/compiled.mp4"
            return ToolResult(success=True, summary="rendered")

    renderer = Renderer()
    tool = CompileVideoTool(Unused(), Unused(), renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="任意新问题",
        state={
            "solution_verified": True,
            "solution_answer": "已验证答案",
            "visual_plan": _open_world_plan(),
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["deterministic_compiler"] is True
    assert result.data["delivery_fallback"] is False
    assert renderer.calls == 1


def test_compile_video_hides_one_evidence_directed_repair_inside_stage() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_manim_code"] = f"code-{self.calls}"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if self.calls == 1:
                ctx.state["last_validation_issues"] = ["observed=x expected=y"]
                ctx.state["last_error_source"] = "validate"
                return ToolResult(success=False, summary="invalid", error="validation_failed")
            ctx.state["last_validation_passed"] = True
            return ToolResult(success=True, summary="valid")

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_video_path"] = "video.mp4"
            ctx.state["latest_video_url"] = "/video.mp4"
            return ToolResult(success=True, summary="rendered")

    writer, validator, renderer = Writer(), Validator(), Renderer()
    tool = CompileVideoTool(writer, validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="opaque",
        state={"solution_verified": True, "visual_plan": _open_world_plan()},
    )
    result = asyncio.run(tool.execute({"model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["internal_repair_count"] == 1
    assert writer.calls == 2
    assert validator.calls == 2
    assert renderer.calls == 1


def test_compile_video_guarantees_a_rendered_verified_fallback() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_manim_code"] = "model code"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=True, summary="valid")

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if not ctx.state.get("delivery_fallback"):
                return ToolResult(success=False, summary="runtime failed", error="bad api")
            ctx.state["latest_video_path"] = "fallback.mp4"
            ctx.state["latest_video_url"] = "/fallback.mp4"
            return ToolResult(success=True, summary="fallback rendered")

    writer, validator, renderer = Writer(), Validator(), Renderer()
    tool = CompileVideoTool(writer, validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="一个此前未见的问题",
        state={
            "solution_verified": True,
            "solution_steps": [
                {"description": "建立关系", "operation": "7 + 5 = 12", "result": "12"}
            ],
            "solution_answer": "12",
            "visual_plan": _open_world_plan(),
        },
    )
    result = asyncio.run(tool.execute({"model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["delivery_fallback"] is True
    assert result.data["video_path"] == "fallback.mp4"
    assert renderer.calls == 3
    ctx.state["visual_plan"]["visual_objects"][0]["params"]["ticks"] = True
    fallback_code = build_verified_fallback_code(ctx)
    compile(fallback_code, "<fallback>", "exec")
    assert "一个此前未见的问题" in fallback_code
    assert "答案：12" in fallback_code
    assert "VISUAL_OBJECTS" in fallback_code
    assert "VISUAL_SCENES" in fallback_code
    assert "quantity_bar" in fallback_code
    assert "RoundedRectangle" in fallback_code
    assert "Arrow(" in fallback_code
    assert "STEP_TEXTS" not in fallback_code
    assert "'ticks': True" in fallback_code
    assert _check_graphical_reasoning_contract(fallback_code, ctx.state["visual_plan"]) == []


def test_review_repair_uses_visual_fallback_instead_of_restoring_text_only_video() -> None:
    class Writer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="repair source failed", error="bad patch")

    class Validator:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise AssertionError("validator is not reached when repair writing fails")

    class Renderer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            assert ctx.state.get("delivery_fallback") is True
            assert "quantity_bar" in str(args.get("code") or "")
            ctx.state["latest_video_path"] = "visual-fallback.mp4"
            ctx.state["latest_video_url"] = "/visual-fallback.mp4"
            return ToolResult(success=True, summary="visual fallback rendered")

    tool = CompileVideoTool(Writer(), Validator(), Renderer())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="任意新问题",
        state={
            "solution_verified": True,
            "solution_steps": [
                {"description": "建立数量关系", "operation": "9 - 4 = 5", "result": "5"}
            ],
            "solution_answer": "5",
            "visual_plan": _open_world_plan(),
            "latest_video_path": "text-only.mp4",
        },
    )
    result = asyncio.run(tool.execute({"review_repair": True, "model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["delivery_fallback"] is True
    assert result.data["video_path"] == "visual-fallback.mp4"


def test_watch_video_allows_exactly_one_frame_evidence_repair() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "bad" if self.calls == 1 else "good"
            ctx.state["last_visual_review"] = {"overall_quality": quality}
            ctx.state["last_visual_failed"] = quality == "bad"
            if quality == "bad":
                ctx.state["last_visual_issues"] = "24s observed=overlap expected=separate"
                ctx.state["last_error_source"] = "inspect"
            return ToolResult(
                success=True,
                summary=quality,
                data={"overall_quality": quality, "blacklist_hits": []},
            )

    class Compiler:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            assert args == {"review_repair": True}
            ctx.state["latest_video_path"] = "repaired.mp4"
            ctx.state["latest_video_url"] = "/repaired.mp4"
            return ToolResult(success=True, summary="recompiled")

    class Director:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=True, summary="redirected")

    inspector, compiler, director = Inspector(), Compiler(), Director()
    tool = WatchVideoTool(  # type: ignore[arg-type]
        inspector,
        compiler,
        director,
    )
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={"latest_video_path": "first.mp4"},
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["internal_repair_count"] == 1
    assert inspector.calls == 2
    assert compiler.calls == 1
    assert director.calls == 0


def test_watch_patches_existing_candidate_without_replanning() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "bad" if self.calls == 1 else "good"
            ctx.state["last_visual_failed"] = quality == "bad"
            return ToolResult(
                success=True,
                summary=quality,
                data={"overall_quality": quality, "blacklist_hits": []},
            )

    class Director:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state.pop("delivery_fallback", None)
            return ToolResult(success=True, summary="new causal plan")

    class Compiler:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            assert args == {"review_repair": True}
            ctx.state["latest_video_path"] = "replanned.mp4"
            ctx.state["latest_video_url"] = "/replanned.mp4"
            return ToolResult(success=True, summary="recompiled")

    inspector, director, compiler = Inspector(), Director(), Compiler()
    tool = WatchVideoTool(inspector, compiler, director)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={
            "delivery_fallback": True,
            "latest_video_path": "fallback.mp4",
            "latest_video_url": "/fallback.mp4",
        },
    )

    result = asyncio.run(tool.execute({}, ctx))

    assert result.success is True
    assert result.data is not None and result.data["replanned"] is False
    assert director.calls == 0
    assert compiler.calls == 1
    assert inspector.calls == 2


def test_watch_revises_scenespec_once_for_semantic_visual_failure() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "bad" if self.calls == 1 else "good"
            ctx.state["last_visual_failed"] = quality == "bad"
            return ToolResult(
                success=True,
                summary=quality,
                data={
                    "overall_quality": quality,
                    "blacklist_hits": [],
                    "repair_directive": {"scope": "plan" if quality == "bad" else "code"},
                },
            )

    class Director:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            assert args == {"review_repair": True}
            assert ctx.state["force_visual_replan"] is True
            ctx.state["visual_plan"] = _open_world_plan("revised causal argument")
            ctx.state.pop("force_visual_replan", None)
            return ToolResult(success=True, summary="revised")

    class Compiler:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            assert args == {"review_repair": True, "deterministic_ir": True}
            ctx.state["latest_video_path"] = "replanned.mp4"
            ctx.state["latest_video_url"] = "/replanned.mp4"
            return ToolResult(success=True, summary="compiled")

    inspector, director, compiler = Inspector(), Director(), Compiler()
    tool = WatchVideoTool(inspector, compiler, director)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="advanced",
        problem="opaque",
        state={
            "latest_manim_code": "old",
            "latest_video_path": "old.mp4",
            "latest_video_url": "/old.mp4",
        },
    )

    result = asyncio.run(tool.execute({}, ctx))

    assert result.success is True
    assert result.data is not None and result.data["replanned"] is True
    assert director.calls == 1
    assert compiler.calls == 1
    assert inspector.calls == 2


def test_watch_video_delivers_best_playable_candidate_when_quality_gate_fails() -> None:
    class Inspector:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["last_visual_review"] = {"overall_quality": "bad"}
            ctx.state["last_visual_failed"] = True
            ctx.state["last_visual_issues"] = "字幕遮挡"
            return ToolResult(
                success=True,
                summary="bad",
                data={
                    "overall_quality": "bad",
                    "blacklist_hits": [],
                    "b_scores": {"b5": 2, "b6": 2},
                },
            )

    class Compiler:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="repair failed", error="bad api")

    class Director:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=True, summary="unused")

    tool = WatchVideoTool(Inspector(), Compiler(), Director())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={
            "latest_manim_code": "playable code",
            "latest_video_path": "playable.mp4",
            "latest_video_url": "/playable.mp4",
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    # A watchable-but-imperfect candidate is delivered with an explicit
    # warning; the session must not end empty-handed.
    assert result.success is True
    assert result.data is not None and result.data["quality_degraded"] is True
    assert result.data["video_path"] == "playable.mp4"
    assert result.data["delivery_warning"]
    assert ctx.state["last_visual_failed"] is False
    assert ctx.state["quality_degraded"] is True
    assert "已交付" in result.summary


def test_watch_video_fails_only_when_no_playable_candidate_exists() -> None:
    class Inspector:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="no frames", error="video_not_found")

    class Compiler:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="unused", error="unused")

    class Director:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=True, summary="unused")

    tool = WatchVideoTool(Inspector(), Compiler(), Director())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={},
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is False


def test_watch_rejects_second_text_only_candidate_without_meaningless_fallback() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "good" if self.calls == 3 else "bad"
            ctx.state["last_visual_review"] = {"overall_quality": quality}
            ctx.state["last_visual_failed"] = quality == "bad"
            ctx.state["last_visual_issues"] = "只有文字切换"
            return ToolResult(
                success=True,
                summary=quality,
                data={
                    "overall_quality": quality,
                    "blacklist_hits": [] if quality == "good" else ["文字搬运"],
                },
            )

    class Compiler:
        calls: list[dict[str, Any]] = []

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls.append(args)
            if args.get("visual_fallback_only"):
                ctx.state["delivery_fallback"] = True
                ctx.state["latest_video_path"] = "visual-fallback.mp4"
                ctx.state["latest_video_url"] = "/visual-fallback.mp4"
                return ToolResult(success=True, summary="visual fallback")
            ctx.state["latest_video_path"] = "second-text-only.mp4"
            ctx.state["latest_video_url"] = "/second-text-only.mp4"
            return ToolResult(success=True, summary="model repair rendered")

    class Director:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=True, summary="unused")

    inspector, compiler = Inspector(), Compiler()
    tool = WatchVideoTool(inspector, compiler, Director())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={
            "latest_manim_code": "text-only code",
            "latest_video_path": "first-text-only.mp4",
            "latest_video_url": "/first-text-only.mp4",
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    # The second text-only candidate still fails review, so the best playable
    # candidate is delivered with a degraded-quality warning.
    assert result.success is True
    assert result.data is not None and result.data["quality_degraded"] is True
    assert "已交付" in result.summary
    assert compiler.calls == [{"review_repair": True}]
    assert inspector.calls == 2


def test_no_visual_argument_flags_only_videos_without_any_graphics() -> None:
    # B6=0 means the video never shows why the answer holds — hard fail.
    assert _no_visual_argument({"b3": 2, "b4": 2, "b6": 0}) is not None
    # No text-independence AND no visible relation change — hard fail.
    assert _no_visual_argument({"b3": 0, "b4": 0, "b6": 1}) is not None
    # Partial scores are review feedback, not automatic failures.
    assert _no_visual_argument({"b3": 1, "b4": 2, "b6": 1}) is None
    assert _no_visual_argument({"b3": 2, "b4": 1, "b6": 2}) is None
    # Missing core scores cannot be waved through.
    assert _no_visual_argument({}) is not None


def test_quality_review_routes_semantic_failure_to_scenespec_repair() -> None:
    assert (
        _repair_scope(
            {
                "b_scores": {
                    "b1": 0,
                    "b2": 1,
                    "b3": 0,
                    "b4": 1,
                    "b5": 1,
                    "b6": 0,
                },
                "blacklist_hits": ["文字搬运"],
                "issues": ["视觉计划与视频内容脱节"],
            }
        )
        == "plan"
    )
    assert (
        _repair_scope(
            {
                "b_scores": {
                    "b1": 2,
                    "b2": 2,
                    "b3": 2,
                    "b4": 2,
                    "b5": 2,
                    "b6": 2,
                },
                "blacklist_hits": [],
                "issues": ["24 秒顶部公式重叠"],
            }
        )
        == "code"
    )


def test_technical_review_rejects_long_video_with_sparse_visible_change() -> None:
    metrics = {
        "width": 1280,
        "height": 720,
        "fps": 30,
        "duration_s": 31,
        "visible_fraction_by_frame": [0.1] * 12,
        "adjacent_frame_difference": [
            0.0,
            0.013,
            0.004,
            0.0019,
            0.0059,
            0.0097,
            0.0035,
            0.0033,
            0.0019,
            0.0015,
            0.0,
        ],
    }

    critical, _ = _derive_technical_issues(metrics)

    assert any("有效画面变化覆盖不足" in issue for issue in critical)
    assert metrics["active_transition_fraction"] < 0.25


def test_static_validation_rejects_recreated_caption_and_shared_text_edge() -> None:
    tree = ast.parse(
        """
from manim import *
class SolutionScene(Scene):
    def construct(self):
        problem = Text("problem")
        problem.to_edge(UP)
        self.play(Write(problem))
        self.play(FadeOut(problem))
        formula = Text("formula")
        formula.to_edge(UP)
        caption = self._create_caption("first")
        caption = self._create_caption("second")
        check = Text("check")
        check.to_edge(UP)
    def _create_caption(self, text):
        caption = Text(text)
        self.play(FadeIn(caption))
        return caption
"""
    )

    issues = _check_animation_api_misuse(tree)

    assert any("双字幕" in issue for issue in issues)
    assert any("formula 与 check" in issue for issue in issues)


def test_visual_ir_fallback_compiles_generic_repetition_partition_and_map() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "all_units",
            "primitive": "dot",
            "meaning": "all units",
            "label": "35 units",
            "color": "blue",
            "params": {"count": 35, "columns": 7},
        },
        {
            "id": "baseline",
            "primitive": "line",
            "meaning": "two marks per unit",
            "label": "2 per unit",
            "color": "blue",
            "params": {"count_per_unit": 2},
        },
        {
            "id": "difference",
            "primitive": "line",
            "meaning": "difference tokens",
            "label": "24 tokens",
            "color": "red",
            "params": {"count": 24},
        },
        {
            "id": "groups",
            "primitive": "circle",
            "meaning": "paired groups",
            "label": "12 groups",
            "color": "green",
            "params": {"count": 12},
        },
    ]
    plan["scenes"] = [
        {
            "role": "setup",
            "teaching_line": "establish every unit",
            "actions": [{"op": "create", "targets": ["all_units", "baseline"]}],
        },
        {
            "role": "transform",
            "teaching_line": "pair the differences",
            "actions": [
                {"op": "create", "targets": ["difference"]},
                {"op": "partition", "targets": ["difference"], "result": "groups"},
            ],
        },
        {
            "role": "verify",
            "teaching_line": "map groups to the original units",
            "actions": [{"op": "map", "targets": ["groups"], "result": "all_units"}],
        },
    ]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": plan},
    )
    code = build_verified_fallback_code(ctx)
    compile(code, "<fallback>", "exec")
    assert "def repeated_body" in code
    assert 'self.repeat_units[spec["id"]] = body' in code
    assert 'params.get("count_per_unit")' in code
    assert "source_units[index * ratio:(index + 1) * ratio]" in code
    assert "pair_count = min(len(source_units), len(result_units))" in code
    assert "layout_animations = self.relayout(visible, [result_id])" in code
    assert "FadeIn(result_units[index], scale=0.7)" in code
    assert "个已对应" in code
    assert "attached_source_id = next" in code
    assert "len(source_units) > len(result_units)" in code
    assert "从原集合逐个取出" in code
    assert "个来自原集合" in code
    assert 'spec.get("primitive") in {"relation_node", "line", "arrow"}' in code
    assert "smaller_id = min(repeated_ids" in code
    assert "self.quantity_bar_max" in code
    assert "每组对应一个单位" in code
    assert "个发生变化的单位" in code
    assert "self.deferred_creates.update" in code
    assert "compare_badge.add_updater" in code
    assert "compared_ids.issubset(selected_set)" in code
    assert "for item in framed" in code
    assert "greater = max(first_value, second_value)" in code
    assert "'count': 35" in code and "'count': 24" in code and "'count': 12" in code


def test_visual_ir_compiles_safe_function_curve_instead_of_generic_line() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "axes",
            "color": "grey",
            "params": {"x_range": [-2, 2], "y_range": [-2, 2]},
        },
        {
            "id": "curve",
            "primitive": "line",
            "meaning": "a nonlinear graph",
            "label": "sin(x)",
            "color": "red",
            "params": {"func": "sin"},
        },
        {
            "id": "tangent",
            "primitive": "line",
            "meaning": "its tangent",
            "label": "slope 1",
            "color": "green",
            "params": {"slope": 1, "intercept": 0},
        },
    ]
    plan["scenes"] = [
        {
            "role": "setup",
            "teaching_line": "draw the curve",
            "actions": [{"op": "create", "targets": ["axes", "curve"]}],
        },
        {
            "role": "transform",
            "teaching_line": "show the local tangent",
            "actions": [{"op": "transform", "targets": ["curve"], "result": "tangent"}],
        },
        {
            "role": "verify",
            "teaching_line": "compare on the same axes",
            "actions": [{"op": "measure", "targets": ["tangent"]}],
        },
    ]
    normalized = _normalize_plan(plan)
    curve = next(item for item in normalized["visual_objects"] if item["id"] == "curve")
    assert curve["primitive"] == "function_curve"
    assert curve["params"]["expression"] == "sin(x)"
    plan_issues = _validate_plan(normalized, "advanced")
    assert not any("primitive='function_curve'" in issue for issue in plan_issues)
    assert not any("function_curve 缺少" in issue for issue in plan_issues)

    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": _normalize_plan(plan)},
    )
    code = build_verified_fallback_code(ctx)
    compile(code, "<fallback>", "exec")
    assert "sampled_segments" in code
    assert 'elif primitive == "function_curve"' in code
    assert "path.set_points_smoothly" in code
    assert '"include_numbers": False' in code
    assert 'Text(f"{x_value:g}"' in code
    assert "def nice_tick(span):" in code
    assert "label.next_to(body.get_right(), UP" in code
    assert "label.next_to(body, UR" in code
    assert "if result_id not in self.coordinate_ids:" in code
    assert "body = Line(LEFT * 1.2" in code  # still available for true lines


def test_visual_ir_places_any_explicit_xy_dot_on_axes() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "axes",
            "color": "grey",
            "params": {"x_range": [-3, 3], "y_range": [-3, 3]},
        },
        {
            "id": "arbitrary_named_point",
            "primitive": "dot",
            "meaning": "a mathematically computed point",
            "label": "P",
            "color": "yellow",
            "params": {"x": 2, "y": -1},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "arbitrary_named_point"],
            "meaning": "show the computed point on its coordinate reference",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "move",
            "targets": ["arbitrary_named_point"],
            "meaning": "make the coordinate relation visible",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["arbitrary_named_point"],
            "meaning": "verify the point at its declared coordinates",
        }
    ]
    normalized = _normalize_plan(plan)

    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": normalized},
    )
    code = build_verified_fallback_code(ctx)

    assert 'all(key in params for key in ("x", "y"))' in code
    assert "self.primary_axes.c2p(point_x, point_y)," in code


def test_visual_ir_projects_one_unbound_dot_to_unique_curve_constraint() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "axes",
            "color": "grey",
            "params": {"x_range": [-2, 4], "y_range": [-2, 5]},
        },
        {
            "id": "curve",
            "primitive": "function_curve",
            "meaning": "a verified function graph",
            "label": "g",
            "color": "red",
            "params": {"expression": "(x - 1)**2", "x_range": [-2, 4]},
        },
        {
            "id": "constraint",
            "primitive": "line",
            "meaning": "a vertical constraint",
            "label": "x=1",
            "color": "blue",
            "params": {"start": [1, -2], "end": [1, 5]},
        },
        {
            "id": "computed_point",
            "primitive": "dot",
            "meaning": "the point fixed by both graphical constraints",
            "label": "P",
            "color": "green",
            "params": {},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "curve", "computed_point"],
            "meaning": "establish the graph and its constrained point",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "create",
            "targets": ["constraint"],
            "meaning": "reveal the unique vertical constraint",
        },
        {
            "op": "highlight",
            "targets": ["computed_point"],
            "meaning": "focus the point fixed by the two constraints",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["computed_point"],
            "meaning": "check the point on the curve",
        }
    ]
    normalized = _normalize_plan(plan)
    assert _validate_plan(normalized, "advanced") == []
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": normalized},
    )

    code = build_verified_fallback_code(ctx)

    assert "len(vertical_x_values) == 1" in code
    assert "len(curve_specs) == 1" in code
    assert 'dot_params["x"] = projection_x' in code
    assert 'self.coordinate_ids.add(unbound_dots[0]["id"])' in code


def test_visual_ir_keeps_vertical_point_segments_in_coordinate_space() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "",
            "color": "grey",
            "params": {"x_range": [-2, 4], "y_range": [-2, 5]},
        },
        {
            "id": "vertical_constraint",
            "primitive": "line",
            "meaning": "fixed x coordinate",
            "label": "x=1",
            "color": "red",
            "params": {"points": [[1, -2], [1, 5]]},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "vertical_constraint"],
            "meaning": "show the coordinate constraint",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "move",
            "targets": ["vertical_constraint"],
            "meaning": "focus the coordinate relation",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "verify",
            "targets": ["vertical_constraint"],
            "meaning": "check the fixed coordinate",
        }
    ]
    normalized = _normalize_plan(plan)
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": normalized},
    )

    code = build_verified_fallback_code(ctx)

    assert 'else:\n                    self.coordinate_segments[spec["id"]]' in code
    assert "self.primary_axes.c2p(*start)" in code


def test_visual_ir_renders_all_coordinate_positions_and_compares_y_values() -> None:
    plan = _open_world_plan()
    plan["visual_objects"] = [
        {
            "id": "axes",
            "primitive": "axes",
            "meaning": "coordinate reference",
            "label": "",
            "color": "grey",
            "params": {"x_range": [-2, 4], "y_range": [-2, 5]},
        },
        {
            "id": "minimum",
            "primitive": "dot",
            "meaning": "computed minimum",
            "label": "min",
            "color": "green",
            "params": {"x": 2, "y": -1},
        },
        {
            "id": "checks",
            "primitive": "dot",
            "meaning": "two comparison samples",
            "label": "checks",
            "color": "orange",
            "params": {"count": 2, "positions": [[1, 0], [3, 0]]},
        },
    ]
    plan["scenes"][0]["actions"] = [
        {
            "op": "create",
            "targets": ["axes", "minimum"],
            "meaning": "establish the coordinate result",
        }
    ]
    plan["scenes"][1]["actions"] = [
        {
            "op": "move",
            "targets": ["minimum"],
            "meaning": "focus the computed coordinate",
        }
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "create",
            "targets": ["checks"],
            "meaning": "show both comparison samples",
        },
        {
            "op": "compare",
            "targets": ["minimum", "checks"],
            "meaning": "compare their y coordinates",
        },
    ]
    normalized = _normalize_plan(plan)
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "verified", "visual_plan": normalized},
    )

    code = build_verified_fallback_code(ctx)

    assert 'for position in params.get("positions") or []' in code
    assert 'return params.get("y")' in code
    assert 'smaller_text = f"({smaller:g})" if smaller < 0' in code


def test_visual_plan_recovers_json_damaged_latex_before_plain_text_lowering() -> None:
    plan = _open_world_plan()
    plan["scenes"][0]["teaching_line"] = "转化为 " + "\x0crac{" + "\text" + "{cos}(x)}{1}"
    normalized = _normalize_plan(plan)
    assert normalized["scenes"][0]["teaching_line"] == (r"转化为 \frac{\text{cos}(x)}{1}")
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="advanced",
        problem="opaque",
        state={"solution_answer": "1", "visual_plan": normalized},
    )
    code = build_verified_fallback_code(ctx)
    assert "转化为 cos(x)/1" in code
    assert "转化为 rac" not in code


# ---------------------------------------------------------------------------
# Graduated review verdict (_finalize_review)
# ---------------------------------------------------------------------------


def _review_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "overall_quality": "bad",
        "b_total": "7/12",
        "b_scores": {"b1": 1, "b2": 1, "b3": 1, "b4": 2, "b5": 1, "b6": 1},
        "blacklist_hits": [],
        "layout_fatal": [],
        "issues": [],
        "highlights": [],
        "fix_suggestion": [],
    }
    payload.update(overrides)
    return payload


def test_finalize_review_delivers_acceptable_band_instead_of_forcing_bad() -> None:
    payload = _review_payload()
    state: dict[str, Any] = {"latest_video_path": "v.mp4"}
    overall, b_total = _finalize_review(payload, {}, [], state, "v.mp4", [1.0, 5.0])
    assert overall == "acceptable"
    assert b_total == 7
    assert state["last_visual_failed"] is False
    assert payload["reported_overall_quality"] == "bad"


def test_finalize_review_promotes_strong_rubric_to_good() -> None:
    payload = _review_payload(
        overall_quality="acceptable",
        b_total="10/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 1},
    )
    state: dict[str, Any] = {}
    overall, _ = _finalize_review(payload, {}, [], state, "v.mp4", [])
    assert overall == "good"


def test_finalize_review_caps_partially_verifiable_math_at_acceptable() -> None:
    payload = _review_payload(
        overall_quality="good",
        b_total="10/12",
        b_scores={"b1": 2, "b2": 2, "b3": 2, "b4": 2, "b5": 1, "b6": 1},
    )
    overall, _ = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall == "acceptable"


def test_finalize_review_low_total_and_contradiction_force_bad() -> None:
    low = _review_payload(b_total="4/12", b_scores={"b1": 0, "b2": 1, "b3": 1, "b4": 1, "b5": 1, "b6": 1})
    assert _finalize_review(low, {}, [], {}, "v.mp4", [])[0] == "bad"
    contradiction = _review_payload(
        b_scores={"b1": 2, "b2": 2, "b3": 2, "b4": 2, "b5": 0, "b6": 2},
        b_total="10/12",
    )
    assert _finalize_review(contradiction, {}, [], {}, "v.mp4", [])[0] == "bad"


def test_finalize_review_layout_fatal_field_forces_bad_but_minor_issue_does_not() -> None:
    fatal = _review_payload(layout_fatal=["12.5s D3 公式与曲线重叠，无法辨认"])
    state: dict[str, Any] = {}
    assert _finalize_review(fatal, {}, [], state, "v.mp4", [])[0] == "bad"
    # A minor wording like 轻微重叠 in issues is feedback, not a hard failure.
    minor = _review_payload(issues=["8s 底部字幕与图形轻微重叠，但可读"])
    assert _finalize_review(minor, {}, [], {}, "v.mp4", [])[0] == "acceptable"
    # Explicit unreadability in issues still fails via the fallback scan.
    unreadable = _review_payload(issues=["10s 顶部公式严重重叠，无法辨认"])
    assert _finalize_review(unreadable, {}, [], {}, "v.mp4", [])[0] == "bad"


def test_finalize_review_downgrades_static_blacklist_without_measured_support() -> None:
    payload = _review_payload(
        b_total="9/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
        blacklist_hits=["静态幻灯片"],
    )
    metrics = {"active_transition_fraction": 0.55}
    overall, _ = _finalize_review(payload, metrics, [], {}, "v.mp4", [])
    assert overall == "good"
    assert payload["blacklist_hits"] == []
    assert payload["blacklist_downgraded"] == ["静态幻灯片"]
    assert any("降级" in str(item) for item in payload["issues"])


def test_finalize_review_confirms_static_blacklist_with_measured_support() -> None:
    payload = _review_payload(
        b_total="9/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
        blacklist_hits=["静态幻灯片"],
    )
    metrics = {"active_transition_fraction": 0.2}
    overall, _ = _finalize_review(payload, metrics, [], {}, "v.mp4", [])
    assert overall == "bad"
    assert payload["blacklist_hits"] == ["静态幻灯片"]


def test_finalize_review_downgrades_text_only_blacklist_contradicted_by_rubric() -> None:
    # b3=2 means the reviewer itself says graphics carry the argument, so a
    # 文字搬运 claim is inconsistent and must not sink the video.
    payload = _review_payload(
        b_total="9/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
        blacklist_hits=["文字搬运"],
    )
    overall, _ = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall == "good"
    assert payload["blacklist_hits"] == []


def test_finalize_review_keeps_best_candidate_for_degraded_delivery() -> None:
    state: dict[str, Any] = {
        "latest_manim_code": "code-a",
        "latest_video_path": "a.mp4",
        "latest_video_url": "/a.mp4",
    }
    payload = _review_payload()
    _finalize_review(payload, {}, [], state, "a.mp4", [])
    best = state["best_visual_candidate"]
    assert best["video_path"] == "a.mp4"
    assert best["score"] == 7
    # A later worse review must not overwrite the stored candidate.
    worse = _review_payload(
        b_total="3/12",
        b_scores={"b1": 0, "b2": 0, "b3": 1, "b4": 1, "b5": 1, "b6": 0},
    )
    state["latest_video_path"] = "b.mp4"
    _finalize_review(worse, {}, [], state, "b.mp4", [])
    assert state["best_visual_candidate"]["video_path"] == "a.mp4"


def test_finalize_review_routes_no_visual_argument_to_replan() -> None:
    payload = _review_payload(
        b_total="5/12",
        b_scores={"b1": 1, "b2": 1, "b3": 1, "b4": 1, "b5": 1, "b6": 0},
    )
    state: dict[str, Any] = {}
    overall, _ = _finalize_review(payload, {}, [], state, "v.mp4", [])
    assert overall == "bad"
    assert payload["repair_directive"]["scope"] == "plan"
    assert state["force_visual_replan"] is True


def test_finalize_review_routes_layout_failure_to_code_repair() -> None:
    payload = _review_payload(layout_fatal=["3s A1 标题被裁切"])
    state: dict[str, Any] = {}
    overall, _ = _finalize_review(payload, {}, [], state, "v.mp4", [])
    assert overall == "bad"
    assert payload["repair_directive"]["scope"] == "code"
    assert "force_visual_replan" not in state


def test_finalize_review_treats_plan_contract_issue_as_warning_only() -> None:
    # Plan schema violations no longer poison the video verdict: a payload
    # with a healthy rubric stays deliverable even when the stored plan would
    # fail its own contract re-validation.
    payload = _review_payload(
        b_total="9/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
    )
    overall, _ = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall == "good"


# ---------------------------------------------------------------------------
# Compile: review repair budget and contract soft pass
# ---------------------------------------------------------------------------


def test_review_repair_gets_one_internal_repair_attempt() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if self.calls == 1:
                return ToolResult(success=False, summary="typo draft", error="bad line")
            ctx.state["latest_manim_code"] = "repaired code"
            return ToolResult(success=True, summary="written")

    class Validator:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=True, summary="valid")

    class Renderer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["latest_video_path"] = "repaired.mp4"
            ctx.state["latest_video_url"] = "/repaired.mp4"
            return ToolResult(success=True, summary="rendered")

    writer = Writer()
    tool = CompileVideoTool(writer, Validator(), Renderer())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=6,
        grade="middle",
        problem="opaque",
        state={"solution_verified": True, "visual_plan": _open_world_plan()},
    )
    result = asyncio.run(tool.execute({"review_repair": True, "model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data.get("delivery_fallback") is not True
    assert result.data["internal_repair_count"] == 1
    assert writer.calls == 2
    assert ctx.state["last_compiler"] == "model"


def test_contract_only_validation_failure_soft_passes_to_render() -> None:
    class Writer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["latest_manim_code"] = "model code"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(
                success=False,
                summary="校验未通过：契约",
                error="validation_failed",
                data={
                    "syntax_ok": True,
                    "structure_issues": [],
                    "problem_opening_issues": [],
                    "visual_evidence_issues": [],
                    "graphical_reasoning_issues": ["未见 transform 证据"],
                    "semantic_audit_issues": [],
                },
            )

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_video_path"] = "soft.mp4"
            ctx.state["latest_video_url"] = "/soft.mp4"
            return ToolResult(success=True, summary="rendered")

    validator, renderer = Validator(), Renderer()
    tool = CompileVideoTool(Writer(), validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=6,
        grade="middle",
        problem="opaque",
        state={"solution_verified": True, "visual_plan": _open_world_plan()},
    )
    result = asyncio.run(tool.execute({"model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None
    # The video rendered from model code instead of diverting to the
    # template fallback; the reviewer decides whether the reasoning holds.
    assert result.data.get("delivery_fallback") is not True
    assert result.data["video_path"] == "soft.mp4"
    assert renderer.calls == 1
    assert validator.calls == 2
    assert ctx.state["contract_soft_pass_issues"] == ["未见 transform 证据"]


def test_syntax_class_validation_failure_still_falls_back() -> None:
    class Writer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["latest_manim_code"] = "broken code"
            return ToolResult(success=True, summary="written")

    class Validator:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(
                success=False,
                summary="校验未通过：语法错误",
                error="validation_failed",
                data={
                    "syntax_ok": False,
                    "structure_issues": [],
                    "problem_opening_issues": [],
                    "visual_evidence_issues": [],
                    "graphical_reasoning_issues": [],
                    "semantic_audit_issues": [],
                },
            )

    class Renderer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            assert ctx.state.get("delivery_fallback") is True
            ctx.state["latest_video_path"] = "fallback.mp4"
            ctx.state["latest_video_url"] = "/fallback.mp4"
            return ToolResult(success=True, summary="fallback rendered")

    tool = CompileVideoTool(Writer(), Validator(), Renderer())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=6,
        grade="middle",
        problem="一个此前未见的问题",
        state={
            "solution_verified": True,
            "solution_steps": [
                {"description": "建立关系", "operation": "7 + 5 = 12", "result": "12"}
            ],
            "solution_answer": "12",
            "visual_plan": _open_world_plan(),
        },
    )
    result = asyncio.run(tool.execute({"model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["delivery_fallback"] is True


# ---------------------------------------------------------------------------
# Watch: alternate compiler on replanned repair
# ---------------------------------------------------------------------------


def test_watch_replan_repair_switches_compiler_after_template_failure() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "bad" if self.calls == 1 else "good"
            ctx.state["last_visual_failed"] = quality == "bad"
            return ToolResult(
                success=True,
                summary=quality,
                data={
                    "overall_quality": quality,
                    "blacklist_hits": [],
                    "repair_directive": {"scope": "plan" if quality == "bad" else "code"},
                },
            )

    class Director:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["visual_plan"] = _open_world_plan("revised argument")
            return ToolResult(success=True, summary="revised")

    class Compiler:
        received: dict[str, Any] = {}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.received = args
            ctx.state["latest_video_path"] = "second.mp4"
            ctx.state["latest_video_url"] = "/second.mp4"
            return ToolResult(success=True, summary="compiled")

    compiler = Compiler()
    tool = WatchVideoTool(Inspector(), compiler, Director())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={
            "latest_video_path": "template.mp4",
            # The failing video came from the deterministic template.
            "last_compiler": "visual_ir",
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    # Same-template recompilation would reproduce the same footage, so the
    # repair must go through the model compiler instead.
    assert compiler.received == {"review_repair": True, "model_codegen": True}


# ---------------------------------------------------------------------------
# Loop: budget exhaustion salvages the playable candidate
# ---------------------------------------------------------------------------


def test_stage_budget_exhaustion_delivers_playable_candidate() -> None:
    class NeverCalledLLM:
        calls = 0

        def chat_stream(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            raise AssertionError("controller LLM must not run in bounded mode")

    class MemoryStore:
        def __init__(self) -> None:
            self.updated: dict[str, Any] = {}
            self.artifact_id = 0

        async def create_session(self, **kwargs: Any) -> str:
            return "session"

        async def append_message(self, *args: Any, **kwargs: Any) -> int:
            return 1

        async def record_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def complete_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def update_session(self, session_id: str, **kwargs: Any) -> None:
            self.updated = kwargs

        async def save_text_artifact(self, *args: Any, **kwargs: Any) -> tuple[int, str]:
            self.artifact_id += 1
            return self.artifact_id, "artifact.json"

        async def add_artifact(self, *args: Any, **kwargs: Any) -> int:
            self.artifact_id += 1
            return self.artifact_id

    class StageTool(ITool):
        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        @property
        def description(self) -> str:
            return self._name

        @property
        def parameters(self) -> dict[str, Any]:
            return {"type": "object", "properties": {}, "required": []}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            state = ctx.state
            if self.name == "solve_problem":
                state["solution_steps"] = [{"description": "derive"}]
                state["solution_answer"] = "42"
                state["solution_verified"] = False
            elif self.name == "verify_solution":
                state["solution_verified"] = True
            elif self.name == "direct_video":
                state["visual_plan"] = _open_world_plan()
            elif self.name == "compile_video":
                state["latest_video_path"] = "candidate.mp4"
                state["latest_video_url"] = "/candidate.mp4"
            elif self.name == "watch_video":
                # A pathological watch stage that fails without delivering.
                state["last_visual_review"] = {"overall_quality": "bad"}
                state["last_visual_failed"] = True
                return ToolResult(success=False, summary="review failed", error="bad")
            return ToolResult(success=True, summary="ok")

    registry = ToolRegistry()
    for name in (
        "solve_problem",
        "verify_solution",
        "direct_video",
        "compile_video",
        "watch_video",
    ):
        registry.register(StageTool(name))
    store = MemoryStore()
    loop = AgentLoop(
        llm=NeverCalledLLM(),  # type: ignore[arg-type]
        registry=registry,
        composer=PromptComposer(),
        store=store,  # type: ignore[arg-type]
        use_latex=False,
        max_turns=8,
        deterministic_workflow=True,
    )

    async def collect() -> list[Any]:
        return [event async for event in loop.run(problem="opaque", grade="middle")]

    events = asyncio.run(collect())
    done = [event for event in events if isinstance(event, DoneEvent)][-1]
    # The playable candidate must survive budget exhaustion with a warning
    # instead of the session failing empty-handed.
    assert done.status == "ok"
    assert done.final_video_path == "candidate.mp4"
    assert "最佳可播放候选" in done.text
    assert store.updated.get("status") == "done"
    assert "stage_budget_exhausted" in str(store.updated.get("error"))


# ---------------------------------------------------------------------------
# Occupancy: bracket-coordinate placements are visible to overlap detection
# ---------------------------------------------------------------------------


def test_occupancy_parses_bracket_coordinate_move_to() -> None:
    from math_tutor.infrastructure.agent import occupancy_table as occ

    code = "\n".join(
        [
            "label.move_to([2, -1, 0])",
            "dot.move_to(np.array([1.5, 2.25, 0]))",
            "tip.move_to((0.5, -0.5, 0))",
            "title.move_to(UP * 2)",
        ]
    )
    placements = occ.parse_placements_from_code(code)
    coords = {p.var: (p.x, p.y) for p in placements}
    assert coords["label"] == (2.0, -1.0)
    assert coords["dot"] == (1.5, 2.25)
    assert coords["tip"] == (0.5, -0.5)
    assert coords["title"] == (0.0, 2.0)


# ---------------------------------------------------------------------------
# Adversarial-review regressions: undefined locals, payload shapes, soft pass
# ---------------------------------------------------------------------------


def test_changed_modules_have_no_undefined_local_names() -> None:
    """Guard against extract-refactors leaving dangling variable references
    (a NameError in inspect_video.execute once slipped past every test)."""
    import builtins as builtins_mod

    from math_tutor.infrastructure.agent.tools import (
        compile_video as compile_module,
        inspect_video as inspect_module,
        watch_video as watch_module,
    )

    for module in (inspect_module, watch_module, compile_module):
        source = Path(module.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        module_names: set[str] = set(dir(builtins_mod))
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                module_names.add(node.name)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        module_names.add(target.id)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    module_names.add(alias.asname or alias.name.split(".")[0])

        # Only module-level functions and class methods: nested functions may
        # legitimately close over enclosing-scope names, and their bodies are
        # already covered by the walk over their enclosing function.
        functions = [
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        ] + [
            node
            for cls in tree.body
            if isinstance(cls, ast.ClassDef)
            for node in cls.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        ]
        for func in functions:
            assigned = {"self", "cls"}
            for node in ast.walk(func):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    assigned.add(node.id)
                elif isinstance(node, ast.arg):
                    assigned.add(node.arg)
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    assigned.add(node.name)
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    assigned.add(node.name)
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    for alias in node.names:
                        assigned.add(alias.asname or alias.name.split(".")[0])
                elif isinstance(node, ast.Global):
                    assigned.update(node.names)
            used = {
                node.id
                for node in ast.walk(func)
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
            }
            undefined = used - assigned - module_names
            assert not undefined, (
                f"{module.__name__}.{func.name} references undefined names: "
                f"{sorted(undefined)}"
            )


def test_inspect_video_execute_end_to_end_with_stub_vision(tmp_path, monkeypatch) -> None:
    """Drive the FULL execute path (frames -> VLM -> verdict -> artifact meta)
    so the ToolResult/ArtifactSpec construction is covered by tests."""
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools import inspect_video as iv

    video = tmp_path / "candidate.mp4"
    video.write_bytes(b"00")
    monkeypatch.setattr(iv.shutil, "which", lambda name: f"/usr/bin/{name}")

    async def fake_extract(video_path: Any, time_s: float, out_path: Any) -> bool:
        Path(out_path).write_bytes(b"png")
        return True

    async def fake_ffprobe(path: Any) -> dict[str, Any]:
        return {
            "duration_s": 15.0,
            "file_size_bytes": 1000,
            "width": 1280,
            "height": 720,
            "fps": 30.0,
            "has_audio": False,
        }

    monkeypatch.setattr(iv, "_extract_frame", fake_extract)
    monkeypatch.setattr(iv, "_ffprobe_metadata", fake_ffprobe)
    monkeypatch.setattr(
        iv,
        "_frame_sequence_metrics",
        lambda paths: {
            "visible_fraction_by_frame": [0.1] * 12,
            "entropy_by_frame": [1.0] * 12,
            "adjacent_frame_difference": [0.01] * 11,
            "blank_frame_count": 0,
            "near_static_transition_count": 0,
            "top_border_occupancy": [0.0] * 12,
            "side_border_occupancy": [0.0] * 12,
            "caption_zone_occupancy": [0.0] * 12,
        },
    )

    class StubVision:
        async def chat_complete(self, **kwargs: Any) -> Any:
            class Done:
                text = "\n".join(
                    [
                        "## 视觉评审",
                        "",
                        "**整体质量**: acceptable",
                        "**B 段总分**: 8/12",
                        "**布局硬伤**: 无",
                        "**命中黑名单**: 无",
                        "",
                        "### B 段打分",
                        "- B1 视觉论证连贯性: 1",
                        "- B2 动画语义: 1",
                        "- B3 文字依赖度: 1",
                        "- B4 关系变化可见: 2",
                        "- B5 数学契约一致性: 2",
                        "- B6 本质可见性: 1",
                        "",
                        "### 问题",
                        "- 5s F6 底部字幕稍显拥挤",
                        "",
                        "### 帧描述",
                        "- 第 1 帧 @ 1.20s: 题目卡完整可读",
                    ]
                )
                reasoning = ""

            return Done()

    tool = InspectVideoTool(StubVision(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=7,
        grade="middle",
        problem="求最小值",
        state={
            "latest_video_path": str(video),
            "visual_plan": _open_world_plan(),
            "solution_answer": "-1",
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["overall_quality"] == "acceptable"
    assert ctx.state["last_visual_failed"] is False
    meta = result.artifacts[0].meta
    assert meta["overall_quality"] == "acceptable"
    assert meta["math_consistency"] == 2
    assert meta["essence_delivery"] == 1
    assert meta["technical_pass"] is True


def test_finalize_review_coerces_string_fields_from_json_fallback() -> None:
    # A raw-JSON review may carry string fields; "无" must not become a fake
    # blacklist hit or layout failure by character iteration.
    payload = _review_payload(
        blacklist_hits="无",
        layout_fatal="未发现",
        issues="5s 底部字幕稍显拥挤",
        b_scores={"b1": "1", "b2": "1分", "b3": "1", "b4": "2", "b5": "2", "b6": "1"},
        b_total="8/12",
    )
    overall, b_total = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall == "acceptable"
    assert b_total == 8
    assert payload["blacklist_hits"] == []
    assert payload["layout_fatal"] == []
    assert payload["issues"] == ["5s 底部字幕稍显拥挤"]


def test_finalize_review_drops_unparseable_scores_to_missing_gate() -> None:
    payload = _review_payload(
        overall_quality="good", b_scores="not a dict", b_total="8/12"
    )
    overall, _ = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall == "bad"
    assert payload["forced_reason"] == "视觉评审缺少完整 B 段评分"
    # A formatting hiccup must not discard the SceneSpec.
    assert payload["repair_directive"]["scope"] == "code"


def test_finalize_review_excludes_no_visual_argument_from_best_candidate() -> None:
    state: dict[str, Any] = {"latest_video_path": "text.mp4"}
    payload = _review_payload(
        b_total="7/12",
        b_scores={"b1": 2, "b2": 2, "b3": 0, "b4": 0, "b5": 2, "b6": 1},
    )
    overall, _ = _finalize_review(payload, {}, [], state, "text.mp4", [])
    assert overall == "bad"
    assert "best_visual_candidate" not in state


def test_render_repair_revalidation_also_soft_passes_contract_issues() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_manim_code"] = f"code v{self.calls}"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if self.calls == 1:
                return ToolResult(success=True, summary="valid")
            return ToolResult(
                success=False,
                summary="校验未通过：契约",
                error="validation_failed",
                data={
                    "syntax_ok": True,
                    "structure_issues": [],
                    "problem_opening_issues": [],
                    "visual_evidence_issues": ["契约证据存疑"],
                    "graphical_reasoning_issues": [],
                    "semantic_audit_issues": [],
                },
            )

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if self.calls == 1:
                return ToolResult(success=False, summary="runtime failed", error="bad api")
            ctx.state["latest_video_path"] = "second.mp4"
            ctx.state["latest_video_url"] = "/second.mp4"
            return ToolResult(success=True, summary="rendered")

    writer, validator, renderer = Writer(), Validator(), Renderer()
    tool = CompileVideoTool(writer, validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=6,
        grade="middle",
        problem="opaque",
        state={"solution_verified": True, "visual_plan": _open_world_plan()},
    )
    result = asyncio.run(tool.execute({"model_codegen": True}, ctx))
    assert result.success is True
    assert result.data is not None
    # The repaired code rendered instead of diverting to the template.
    assert result.data.get("delivery_fallback") is not True
    assert result.data["video_path"] == "second.mp4"
    assert ctx.state["contract_soft_pass_issues"] == ["契约证据存疑"]


# ---------------------------------------------------------------------------
# P1: quantity verbs — validator, builders, deterministic story plans
# ---------------------------------------------------------------------------


def _quantity_plan_base() -> dict[str, Any]:
    return {
        "plan_version": 2,
        "visual_thesis": "让单位真实迁移并由计数得到答案",
        "essence_rationale": "因为学生看到单位逐个离开并重新计数，减法的意义直接来自画面变化。",
        "symbol_ledger": ["蓝色单位 = 剩余", "灰色容器 = 拿走"],
        "visual_objects": [
            {
                "id": "total_group",
                "primitive": "unit_grid",
                "meaning": "全部单位",
                "label": "苹果",
                "color": "blue",
                "params": {"count": 5, "columns": 3},
            },
            {
                "id": "removed_box",
                "primitive": "rectangle",
                "meaning": "被拿走的单位",
                "label": "拿走",
                "color": "gray",
                "params": {},
            },
        ],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "total_group",
                "action": "建立全部单位",
                "invariant": "无，当前建立初始状态",
                "attention_target": "总数",
                "exit_condition": "总数可见",
                "teaching_line": "先数清总数。",
                "duration_s": 4,
                "actions": [
                    {"op": "create", "targets": ["total_group"], "result": "", "meaning": "建立"},
                    {
                        "op": "count",
                        "targets": ["total_group"],
                        "result": "",
                        "expect": 5,
                        "meaning": "数总数",
                    },
                ],
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "total_group, removed_box",
                "action": "移走部分单位",
                "invariant": "总量守恒",
                "attention_target": "被移走的单位",
                "exit_condition": "分组清楚",
                "teaching_line": "拿走的每一个都看得见。",
                "duration_s": 6,
                "actions": [
                    {"op": "create", "targets": ["removed_box"], "result": "", "meaning": "建容器"},
                    {
                        "op": "take_from",
                        "targets": ["total_group"],
                        "result": "",
                        "source": "total_group",
                        "destination": "removed_box",
                        "count": 2,
                        "style": "fly",
                        "meaning": "移走 2 个",
                    },
                    {
                        "op": "count",
                        "targets": ["total_group"],
                        "result": "",
                        "expect": 3,
                        "meaning": "数剩余",
                    },
                ],
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "total_group, removed_box",
                "action": "重新计数核对",
                "invariant": "剩余+拿走=总数",
                "attention_target": "合计算式",
                "exit_condition": "算式成立",
                "teaching_line": "合起来还是原来的总数。",
                "duration_s": 4,
                "actions": [
                    {
                        "op": "recount_verify",
                        "targets": ["total_group", "removed_box"],
                        "result": "",
                        "expect_total": 5,
                        "meaning": "重数核对",
                    },
                ],
            },
        ],
        "forbidden": ["只显示文字等式", "数量变化不经过单位迁移"],
    }


def test_validator_accepts_ledger_consistent_quantity_plan() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    assert _validate_plan(_quantity_plan_base(), "elementary") == []


def test_validator_enforces_take_from_parameters_and_conservation() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    missing_destination = _quantity_plan_base()
    missing_destination["scenes"][1]["actions"][1].pop("destination")
    errors = _validate_plan(missing_destination, "elementary")
    assert any("destination" in item for item in errors)

    over_take = _quantity_plan_base()
    over_take["scenes"][1]["actions"][1]["count"] = 9
    errors = _validate_plan(over_take, "elementary")
    assert any("守恒违例" in item for item in errors)

    # count.expect is checked against the running ledger (5 - 2 = 3), so a
    # stale expectation equal to the declared count must fail.
    stale_count = _quantity_plan_base()
    stale_count["scenes"][1]["actions"][2]["expect"] = 5
    errors = _validate_plan(stale_count, "elementary")
    assert any("当前数量" in item for item in errors)

    bad_total = _quantity_plan_base()
    bad_total["scenes"][2]["actions"][0]["expect_total"] = 6
    errors = _validate_plan(bad_total, "elementary")
    assert any("守恒违例" in item for item in errors)


def test_validator_requires_move_destination_and_rejects_additive_transform() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    plan = _quantity_plan_base()
    plan["scenes"][1]["actions"] = [
        {"op": "move", "targets": ["total_group"], "result": "", "meaning": "移动"},
    ]
    errors = _validate_plan(plan, "elementary")
    assert any("move 缺少 destination" in item for item in errors)

    plan = _quantity_plan_base()
    plan["visual_objects"].append(
        {
            "id": "shrunk_group",
            "primitive": "unit_grid",
            "meaning": "变小后的组",
            "label": "剩余",
            "color": "green",
            "params": {"count": 3, "columns": 2},
        }
    )
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["total_group"],
            "result": "shrunk_group",
            "meaning": "5 变 3",
        },
    ]
    errors = _validate_plan(plan, "elementary")
    assert any("take_from/combine" in item for item in errors)

    # Multiplicative regrouping (6 -> 2) keeps a visible group structure and
    # stays legal for the P1 division path.
    plan = _quantity_plan_base()
    plan["visual_objects"][0]["params"]["count"] = 6
    plan["visual_objects"].append(
        {
            "id": "regrouped",
            "primitive": "unit_grid",
            "meaning": "重新分组",
            "label": "组",
            "color": "green",
            "params": {"count": 2, "columns": 2},
        }
    )
    plan["scenes"][0]["actions"][1]["expect"] = 6
    plan["scenes"][1]["actions"] = [
        {
            "op": "transform",
            "targets": ["total_group"],
            "result": "regrouped",
            "meaning": "6 分成每组 3 个",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {"op": "verify", "targets": ["regrouped"], "result": "", "meaning": "核对"},
    ]
    errors = _validate_plan(plan, "elementary")
    assert not any("take_from/combine" in item for item in errors)


def test_member_series_violation_targets_homogeneous_units_only() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _member_series_violations

    apples = [
        {"id": f"apple_{i}", "primitive": "circle", "params": {}} for i in range(1, 6)
    ]
    violations = _member_series_violations(apples)
    assert violations and "params.count=5" in violations[0]

    quantities = [
        {"id": "verified_value_0", "primitive": "circle", "params": {"count": 5}},
        {"id": "verified_value_1", "primitive": "circle", "params": {"count": 2}},
        {"id": "verified_value_2", "primitive": "circle", "params": {"count": 3}},
    ]
    assert _member_series_violations(quantities) == []


def test_arithmetic_candidate_take_away_plan_compiles_through_template() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _validate_plan,
        _verified_arithmetic_candidate,
    )

    ctx = ToolContext(
        "s",
        3,
        "elementary",
        "小明有5个苹果，吃了2个，还剩几个？",
        {
            "solution_verified": True,
            "solution_answer": "3",
            "solution_steps": [
                {"description": "减法", "operation": "5 - 2 = 3", "result": "3"},
            ],
        },
    )
    plan = _verified_arithmetic_candidate(ctx)
    assert plan is not None
    assert _validate_plan(plan, "elementary") == []
    take_actions = [
        action
        for scene in plan["scenes"]
        for action in scene["actions"]
        if action["op"] == "take_from"
    ]
    assert take_actions and take_actions[0]["count"] == 2
    recounts = [
        action
        for scene in plan["scenes"]
        for action in scene["actions"]
        if action["op"] == "recount_verify"
    ]
    assert recounts and recounts[0]["expect_total"] == 5

    # The deterministic template must compile the quantity verbs end to end.
    ctx.state["visual_plan"] = plan
    code = build_verified_fallback_code(ctx)
    compile(code, "<quantity-template>", "exec")
    assert "take_from" in code
    assert "recount_verify" in code
    assert "animate_count" in code
    assert "shift(UP * 0.35)" not in code


def test_quantity_story_plan_builds_and_abstains_correctly() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _validate_plan,
        build_quantity_story_visual_plan,
    )

    def story_ctx(**story_overrides: Any) -> ToolContext:
        story = {
            "relation": "take_away",
            "entity": "苹果",
            "first": 5,
            "second": 2,
            "result": 3,
        }
        story.update(story_overrides)
        return ToolContext(
            "s",
            3,
            "elementary",
            "小明有5个苹果，吃了2个，还剩几个？",
            {
                "solution_verified": True,
                "solution_answer": "3",
                "quantity_story": story,
                "solve_math_request": {
                    "engine": "sympy",
                    "operations": [
                        {"id": "calc", "op": "evaluate", "expression": "5 - 2"}
                    ],
                },
                "solve_math_evidence": {
                    "success": True,
                    "all_claims_passed": True,
                    "operations": [{"id": "calc", "op": "evaluate", "result": "3"}],
                },
            },
        )

    plan = build_quantity_story_visual_plan(story_ctx())
    assert plan is not None
    assert plan["grounding_source"] == "quantity_story"
    assert _validate_plan(plan, "elementary") == []
    ops = [a["op"] for scene in plan["scenes"] for a in scene["actions"]]
    assert "take_from" in ops and "count" in ops and "recount_verify" in ops

    # Numbers not reproduced by executed Math IR -> abstain.
    assert build_quantity_story_visual_plan(story_ctx(first=7, second=4)) is None
    # Values outside the countable range -> abstain (LLM director path).
    assert build_quantity_story_visual_plan(story_ctx(first=40, second=37)) is None
    # Inconsistent arithmetic -> abstain.
    assert build_quantity_story_visual_plan(story_ctx(result=4)) is None

    comparison = build_quantity_story_visual_plan(
        story_ctx(relation="compare_more", first=5, second=2, result=3)
    )
    assert comparison is not None
    assert _validate_plan(comparison, "elementary") == []
    take_actions = [
        a
        for scene in comparison["scenes"]
        for a in scene["actions"]
        if a["op"] == "take_from"
    ]
    # Comparison lowers to align-and-extract: the surplus migrates out, so
    # the difference is countable units, not a combine animation.
    assert take_actions and take_actions[0]["count"] == 3


def test_direct_video_prefers_quantity_story_plan_over_llm_director() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    class NeverCalledPlanner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise AssertionError("LLM director must not run when a story plan exists")

    ctx = ToolContext(
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
    result = asyncio.run(DirectVideoTool(NeverCalledPlanner()).execute({}, ctx))  # type: ignore[arg-type]
    assert result.success is True
    assert ctx.state["visual_plan"]["grounding_source"] == "quantity_story"
    assert ctx.state["visual_plan"]["plan_version"] == 2


def test_parse_quantity_story_from_solve_markdown() -> None:
    from math_tutor.infrastructure.agent.tools.solve_problem import _parse_quantity_story

    class Done:
        text = "\n".join(
            [
                "## 数量故事",
                "- 适用: 是",
                "- 实体: 苹果",
                "- 关系: take_away",
                "- 量1: 5",
                "- 量2: 2",
                "- 结果量: 3",
                "",
                "## 解题",
                "**策略**: 减法",
            ]
        )
        reasoning = ""

    story = _parse_quantity_story(Done())
    assert story == {
        "relation": "take_away",
        "entity": "苹果",
        "first": 5,
        "second": 2,
        "result": 3,
    }

    class NotApplicable:
        text = "## 数量故事\n- 适用: 否\n"
        reasoning = ""

    assert _parse_quantity_story(NotApplicable()) is None


def test_fallback_ir_preserves_quantity_verb_fields() -> None:
    from math_tutor.infrastructure.agent.tools.compile_video import _fallback_visual_ir

    plan = _quantity_plan_base()
    ir = _fallback_visual_ir(plan)
    assert ir is not None
    take_actions = [
        action
        for scene in ir["scenes"]
        for action in scene["actions"]
        if action["op"] == "take_from"
    ]
    assert take_actions
    assert take_actions[0]["source"] == "total_group"
    assert take_actions[0]["destination"] == "removed_box"
    assert take_actions[0]["count"] == 2
    recounts = [
        action
        for scene in ir["scenes"]
        for action in scene["actions"]
        if action["op"] == "recount_verify"
    ]
    assert recounts and recounts[0]["expect_total"] == 5


# ---------------------------------------------------------------------------
# Generic IR-format resilience (motivated by a system-of-equations failure)
# ---------------------------------------------------------------------------


def test_math_runtime_solves_equation_systems_with_lenient_ir_shapes() -> None:
    from math_tutor.infrastructure.agent.math_runtime import execute_math_request

    # Canonical shape: string-array equations + variables + component claims.
    canonical = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"x": {"domain": "nonnegative"}, "y": {"domain": "nonnegative"}},
            "operations": [
                {
                    "id": "solve_system",
                    "op": "solve",
                    "expression": ["x + y - 35", "2*x + 4*y - 94"],
                    "variables": ["x", "y"],
                }
            ],
            "claims": [
                {"id": "x_value", "relation": "equal", "left": "$solve_system[0].x", "right": "23"},
                {"id": "y_value", "relation": "equal", "left": "$solve_system[0].y", "right": "12"},
            ],
        }
    )
    assert canonical.success and canonical.all_claims_passed

    # Observed local-model near-miss: Eq(...) & Eq(...) conjunction, the
    # variable list under the singular key, and a mapping-literal claim.
    lenient = execute_math_request(
        {
            "engine": "sympy",
            "symbols": {"c": {"domain": "nonnegative"}, "r": {"domain": "nonnegative"}},
            "operations": [
                {
                    "id": "setup_equations",
                    "op": "solve",
                    "expression": "Eq(c + r, 35) & Eq(2*c + 4*r, 94)",
                    "variable": ["c", "r"],
                }
            ],
            "claims": [
                {
                    "id": "final_answer",
                    "relation": "equal",
                    "left": "$setup_equations",
                    "right": "{c: 23, r: 12}",
                }
            ],
        }
    )
    assert lenient.success, lenient.errors
    assert lenient.all_claims_passed, lenient.claims


def test_malformed_math_json_gets_actionable_feedback() -> None:
    from math_tutor.infrastructure.agent.tools.solve_problem import _execute_declared_math

    class Done:
        # Unquoted algebraic expressions make the block invalid JSON — the
        # exact failure observed in the field.
        text = (
            "## 确定性计算\n\n```json\n"
            '{"engine": "sympy", "operations": [{"id": "s", "op": "solve", '
            '"expression": [2*x + 4*y - 94, x + y - 35]}]}\n```\n\n## 解题\n**策略**: 方程'
        )
        reasoning = ""

    request, result = _execute_declared_math(Done())
    assert request is None
    assert not result.success
    assert any("引号" in error for error in result.errors)


def test_solve_downgrades_math_evidence_instead_of_failing_session() -> None:
    from math_tutor.infrastructure.agent.tools.solve_problem import SolveProblemTool
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary

    bad_math_output = "\n".join(
        [
            "## 分析",
            "**难度**: easy",
            "**求解目标**: 求数量",
            "## 确定性计算",
            "```json",
            '{"engine": "sympy", "operations": [{"id": "s", "op": "solve", '
            '"expression": [2*x + 4*y - 94, x + y - 35]}]}',
            "```",
            "## 解题",
            "**策略**: 假设法",
            "**最终答案**: 鸡 23 只，兔 12 只",
            "### 第 1 步",
            "- 描述: 假设全是鸡",
            "- 运算: 35 * 2 = 70",
            "- 解释: 每只鸡两只脚",
            "- 结果: 70",
            "### 第 2 步",
            "- 描述: 差值",
            "- 运算: 94 - 70 = 24",
            "- 解释: 兔子每只多两只脚",
            "- 结果: 24",
            "### 第 3 步",
            "- 描述: 求兔",
            "- 运算: 24 / 2 = 12",
            "- 解释: 每只兔多 2 只脚",
            "- 结果: 12",
            "### 第 4 步",
            "- 描述: 求鸡",
            "- 运算: 35 - 12 = 23",
            "- 解释: 头数守恒",
            "- 结果: 鸡 23 只，兔 12 只",
        ]
    )

    class StubLLM:
        calls = 0

        async def chat_complete(self, **kwargs: Any) -> Any:
            StubLLM.calls += 1

            class Done:
                text = bad_math_output
                reasoning = ""
                finish_reason = "stop"

            return Done()

    tool = SolveProblemTool(StubLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=1,
        grade="elementary",
        problem="鸡兔同笼，35 个头，94 只脚",
        state={},
    )
    result = asyncio.run(tool.execute({}, ctx))
    # The model twice failed to author executable Math IR, but the solution
    # itself is consistent: the stage must abstain (applicable=false) and keep
    # the session alive instead of dying at solve.
    assert result.success is True
    evidence = ctx.state["solve_math_evidence"]
    assert evidence["applicable"] is False
    assert "降级" in evidence["reason"]
    assert ctx.state["math_evidence_downgraded"]
    assert ctx.state["solution_answer"].startswith("鸡 23")


def test_take_from_cross_out_needs_no_precreated_container() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    plan = _quantity_plan_base()
    # Remove the explicit create of the container: the cross_out lowering
    # materializes the outline around the crossed units in place.
    plan["scenes"][1]["actions"] = [
        {
            "op": "take_from",
            "targets": ["total_group"],
            "result": "",
            "source": "total_group",
            "destination": "removed_box",
            "count": 2,
            "style": "cross_out",
            "meaning": "原地划去 2 个",
        },
        {
            "op": "count",
            "targets": ["total_group"],
            "result": "",
            "expect": 3,
            "meaning": "数剩余",
        },
    ]
    assert _validate_plan(plan, "elementary") == []


def test_quantity_story_take_away_defaults_to_in_place_cross_out() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        build_quantity_story_visual_plan,
    )

    ctx = ToolContext(
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
    plan = build_quantity_story_visual_plan(ctx)
    assert plan is not None
    take = next(
        action
        for scene in plan["scenes"]
        for action in scene["actions"]
        if action["op"] == "take_from"
    )
    assert take["style"] == "cross_out"
    # The repair variant switches representation so the retry differs.
    repair = build_quantity_story_visual_plan(ctx, variant="repair")
    assert repair is not None
    repair_take = next(
        action
        for scene in repair["scenes"]
        for action in scene["actions"]
        if action["op"] == "take_from"
    )
    assert repair_take["style"] == "fly"


def test_grounded_curve_plan_respects_elementary_abstraction_ceiling() -> None:
    # Representation policy: coordinate curves exceed the elementary level,
    # regardless of whether the Math IR happens to expose a drawable shape.
    state = {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "solve_eq",
                    "op": "solve",
                    "expression": "2**x - 8",
                    "variable": "x",
                }
            ],
            "claims": [{"relation": "equal", "left": "$solve_eq", "right": "[3]"}],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "solve_eq", "result": ["3"]}],
        },
    }
    elementary_ctx = ToolContext("s", 3, "elementary_upper", "解方程", dict(state))
    middle_ctx = ToolContext("s", 3, "middle", "解方程", dict(state))
    assert build_grounded_math_visual_plan(elementary_ctx) is None
    assert build_grounded_math_visual_plan(middle_ctx) is not None


# ---------------------------------------------------------------------------
# P2/P3: replicate verb, beat manifest, deterministic count check
# ---------------------------------------------------------------------------


def test_arithmetic_chain_emits_replicate_for_small_multiplication() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _validate_plan,
        _verified_arithmetic_candidate,
    )

    ctx = ToolContext(
        "s",
        3,
        "elementary",
        "每盒有4个球，3盒一共有多少个？",
        {
            "solution_verified": True,
            "solution_answer": "12",
            "solution_steps": [
                {"description": "乘法", "operation": "3 × 4 = 12", "result": "12"},
            ],
        },
    )
    plan = _verified_arithmetic_candidate(ctx)
    assert plan is not None
    assert _validate_plan(plan, "elementary") == []
    replicates = [
        action
        for scene in plan["scenes"]
        for action in scene["actions"]
        if action["op"] == "replicate"
    ]
    assert replicates and replicates[0]["count"] == 3
    ctx.state["visual_plan"] = plan
    code = build_verified_fallback_code(ctx)
    compile(code, "<replicate-template>", "exec")
    assert "record_beat" in code
    assert "BEAT_MANIFEST_JSON" in code


def test_validator_replicate_conservation() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    plan = _quantity_plan_base()
    plan["visual_objects"][0]["params"]["count"] = 4
    plan["visual_objects"].append(
        {
            "id": "product_box",
            "primitive": "rectangle",
            "meaning": "乘积容器",
            "label": "乘积",
            "color": "green",
            "params": {},
        }
    )
    plan["scenes"][0]["actions"][1]["expect"] = 4
    plan["scenes"][1]["actions"] = [
        {"op": "create", "targets": ["product_box"], "result": "", "meaning": "建容器"},
        {
            "op": "replicate",
            "targets": ["total_group"],
            "result": "product_box",
            "source": "total_group",
            "count": 3,
            "meaning": "复制 3 份",
        },
        {
            "op": "count",
            "targets": ["product_box"],
            "result": "",
            "expect": 12,
            "meaning": "数乘积",
        },
    ]
    plan["scenes"][2]["actions"] = [
        {
            "op": "recount_verify",
            "targets": ["product_box"],
            "result": "",
            "expect_total": 12,
            "meaning": "重数核对",
        },
    ]
    assert _validate_plan(plan, "elementary") == []

    # Ledger-aware: counting the product as anything but 12 must fail.
    plan["scenes"][1]["actions"][2]["expect"] = 9
    errors = _validate_plan(plan, "elementary")
    assert any("当前数量" in item for item in errors)


def test_executor_parses_beat_manifest_marker() -> None:
    from math_tutor.infrastructure.manim.executor import ManimExecutor

    log = "\n".join(
        [
            "Manim Community v0.18",
            'BEAT_MANIFEST_JSON:{"frame_width": 14.22, "frame_height": 8.0, '
            '"beats": [{"beat_index": 0, "role": "setup", "end_time": 5.1, '
            '"groups": {"story_total": {"count": 5, "bbox": [-1, -1, 1, 1], '
            '"color": "#58C4DD"}}}]}',
            "File ready at video.mp4",
        ]
    )
    manifest = ManimExecutor._parse_beat_manifest(log)
    assert manifest is not None
    assert manifest["beats"][0]["groups"]["story_total"]["count"] == 5
    assert ManimExecutor._parse_beat_manifest("no marker here") is None


def test_count_units_in_image_counts_colored_components() -> None:
    from PIL import Image, ImageDraw

    from math_tutor.infrastructure.agent.tools.inspect_video import (
        _count_units_in_image,
        _manifest_pixel_bbox,
    )

    image = Image.new("RGB", (200, 120), (0, 0, 0))
    draw = ImageDraw.Draw(image)
    for index in range(3):
        x = 20 + index * 60
        draw.rectangle([x, 40, x + 30, 70], fill=(88, 196, 221))
    assert _count_units_in_image(image, (0, 0, 200, 120), "#58C4DD") == 3
    # Unknown color abstains instead of guessing.
    assert _count_units_in_image(image, (0, 0, 200, 120), "") is None

    # Scene-to-pixel conversion: scene origin maps to image center.
    bbox = _manifest_pixel_bbox([-7.11, -4.0, 7.11, 4.0], 14.22, 8.0, 200, 120)
    assert bbox == (0, 0, 200, 120)


def test_finalize_review_caps_good_on_self_contradictory_static_denials() -> None:
    payload = _review_payload(
        overall_quality="good",
        b_total="10/12",
        b_scores={"b1": 2, "b2": 2, "b3": 2, "b4": 2, "b5": 2, "b6": 0},
    )
    payload["b_scores"]["b6"] = 2
    payload["b_total"] = "12/12"
    payload["frame_descriptions"] = [
        "第 1 帧 @ 1.0s: 题目 ｜变化: 是",
        "第 2 帧 @ 3.0s: 相同 ｜变化: 否",
        "第 3 帧 @ 5.0s: 相同 ｜变化: 否",
        "第 4 帧 @ 7.0s: 相同 ｜变化: 否",
        "第 5 帧 @ 9.0s: 相同 ｜变化: 否",
    ]
    metrics = {
        "adjacent_frame_difference": [0.001, 0.001, 0.001, 0.001],
        "manifest_change_expected_flags": [True, True, True, True],
    }
    overall, _ = _finalize_review(payload, metrics, [], {}, "v.mp4", [1, 3, 5, 7, 9])
    assert overall == "acceptable"
    assert "score_inconsistency" in payload

    # Without manifest-expected changes the same denials stay "good" (a
    # legitimate hold during narration must not be punished).
    payload2 = _review_payload(
        overall_quality="good",
        b_total="12/12",
        b_scores={"b1": 2, "b2": 2, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
    )
    payload2["frame_descriptions"] = list(payload["frame_descriptions"])
    metrics2 = {
        "adjacent_frame_difference": [0.001, 0.001, 0.001, 0.001],
        "manifest_change_expected_flags": [False, False, False, False],
    }
    overall2, _ = _finalize_review(payload2, metrics2, [], {}, "v.mp4", [1, 3, 5, 7, 9])
    assert overall2 == "good"


def test_phrasing_critique_is_not_a_machine_checkable_blocker() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _machine_checkable_blocking_issue,
    )

    # The exact field failure: a direction-wording critique must not veto.
    assert not _machine_checkable_blocking_issue(
        "步骤3中的文字描述与运算结果矛盾：运算显示每只兔子比鸡多2只脚（4-2=2），"
        "但文字描述为“每只兔子少算2只脚”，逻辑方向错误且表述不准确。"
    )
    # A genuine numeric contradiction with the convention still blocks.
    assert _machine_checkable_blocking_issue(
        "BLOCKING: 步骤2 结果错误 observed=25 expected=24"
    )


# ---------------------------------------------------------------------------
# Post-field-test fixes: blacklist fragments, thin motion, balance policy,
# limit-approach beats, plan parse retry, pacing passthrough
# ---------------------------------------------------------------------------


def test_unrecognized_blacklist_fragment_never_confirms() -> None:
    # Field failure: the VLM wrote "PPT 翻页 (采样帧 1-2 仅文字变化, 采样帧
    # 11-12 仅文字变化)" and comma-splitting produced a fragment that matched
    # no known name yet was treated as a confirmed hit.
    payload = _review_payload(
        b_total="11/12",
        b_scores={"b1": 2, "b2": 1, "b3": 2, "b4": 2, "b5": 2, "b6": 2},
        blacklist_hits=["采样帧 11-12 仅文字变化)"],
    )
    overall, _ = _finalize_review(payload, {}, [], {}, "v.mp4", [])
    assert overall in {"good", "acceptable"}
    assert payload["blacklist_hits"] == []
    assert payload["blacklist_downgraded"] == ["采样帧 11-12 仅文字变化)"]


def test_thin_object_motion_counts_as_active_interval() -> None:
    # A scan line sweeping a curve barely moves the mean-intensity diff but
    # flips a visible fraction of pixels; the activity gate must see it.
    metrics = {
        "width": 1280,
        "height": 720,
        "fps": 30,
        "duration_s": 20,
        "visible_fraction_by_frame": [0.1] * 12,
        "adjacent_frame_difference": [0.002] * 11,
        "changed_pixel_fraction": [0.05] * 11,
    }
    critical, _ = _derive_technical_issues(metrics)
    assert not any("变化覆盖不足" in item for item in critical)
    assert not any("静态幻灯片" in item for item in critical)
    assert metrics["active_transition_fraction"] == 1.0

    # Without the pixel signal the same means are static.
    static_metrics = {
        "width": 1280,
        "height": 720,
        "fps": 30,
        "duration_s": 20,
        "visible_fraction_by_frame": [0.1] * 12,
        "adjacent_frame_difference": [0.002] * 11,
        "changed_pixel_fraction": [0.001] * 11,
    }
    critical, _ = _derive_technical_issues(static_metrics)
    assert any("静态" in item or "变化覆盖不足" in item for item in critical)


def test_middle_grade_linear_equation_abstains_to_balance_director() -> None:
    def solve_state(expression: str, roots: list[Any]) -> dict[str, Any]:
        return {
            "solution_verified": True,
            "verify_math_request": {
                "engine": "sympy",
                "symbols": {"x": {"domain": "real"}},
                "operations": [
                    {
                        "id": "solve_eq",
                        "op": "solve",
                        "expression": expression,
                        "variable": "x",
                    }
                ],
                "claims": [
                    {"relation": "equal", "left": "$solve_eq", "right": str(roots)}
                ],
            },
            "verify_math_evidence": {
                "success": True,
                "all_claims_passed": True,
                "operations": [
                    {"id": "solve_eq", "result": [str(r) for r in roots]}
                ],
            },
        }

    # Middle-school linear equation → abstain (director owns it with the
    # balance metaphor). Same problem at high school keeps the curve.
    linear = solve_state("2*x + 5 - 13", [4])
    assert (
        build_grounded_math_visual_plan(ToolContext("s", 3, "middle", "p", dict(linear)))
        is None
    )
    assert (
        build_grounded_math_visual_plan(ToolContext("s", 3, "high", "p", dict(linear)))
        is not None
    )
    # A middle-school QUADRATIC (multi-root) keeps the curve representation.
    quadratic = solve_state("x**2 - 4*x + 3", [1, 3])
    assert (
        build_grounded_math_visual_plan(
            ToolContext("s", 3, "middle", "p", dict(quadratic))
        )
        is not None
    )


def test_neighborhood_plan_shows_anchor_points_and_two_sided_approach() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import _validate_plan

    state = {
        "solution_verified": True,
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {"x": {"domain": "real"}},
            "operations": [
                {
                    "id": "limit_value",
                    "op": "limit",
                    "expression": "sin(x)/x",
                    "variable": "x",
                    "point": 0,
                }
            ],
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "limit_value", "result": "1"}],
        },
    }
    ctx = ToolContext("s", 3, "high", "求 sin(x)/x 在 0 处的极限", state)
    plan = build_grounded_math_visual_plan(ctx)
    assert plan is not None
    object_ids = {item["id"] for item in plan["visual_objects"]}
    # Why-this-curve: sampled anchor dots precede the curve; the approach:
    # marker points march toward the target from BOTH sides.
    assert "grounded_anchor_points" in object_ids
    assert "grounded_approach_left" in object_ids
    assert "grounded_approach_right" in object_ids
    assert _validate_plan(plan, "high") == []
    roles = [scene["role"] for scene in plan["scenes"]]
    assert roles[0] == "setup" and "transform" in roles and "verify" in roles
    setup_targets = [
        target
        for action in plan["scenes"][0]["actions"]
        for target in action["targets"]
    ]
    assert "grounded_anchor_points" in setup_targets
    ctx.state["visual_plan"] = plan
    code = build_verified_fallback_code(ctx)
    compile(code, "<limit-approach>", "exec")


def test_visual_plan_parse_failure_gets_one_compact_retry() -> None:
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.visual_plan import VisualPlanTool

    class TruncatingLLM:
        calls = 0

        async def chat_complete(self, **kwargs: Any) -> Any:
            TruncatingLLM.calls += 1

            class Done:
                text = '{"visual_thesis": "被截断的'
                reasoning = ""
                finish_reason = "length"

            return Done()

    TruncatingLLM.calls = 0
    tool = VisualPlanTool(TruncatingLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        3,
        "elementary",
        "鸡兔同笼",
        {"solution_verified": True, "solution_answer": "12", "solution_steps": [{}]},
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is False
    assert result.error == "parse_failed"
    # One compact retry happened (two authoring calls, no more).
    assert TruncatingLLM.calls == 2
    assert "压缩重试" in result.summary


def test_fallback_ir_keeps_duration_budget() -> None:
    from math_tutor.infrastructure.agent.tools.compile_video import _fallback_visual_ir

    plan = _quantity_plan_base()
    ir = _fallback_visual_ir(plan)
    assert ir is not None
    durations = [scene.get("duration_s") for scene in ir["scenes"]]
    assert durations[0] == 4.0 and durations[1] == 6.0


# ---------------------------------------------------------------------------
# Verify-stage resilience: format exhaustion degrades instead of dying
# ---------------------------------------------------------------------------


def test_verify_format_exhaustion_degrades_and_saves_raw_output() -> None:
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class GarbageLLM:
        async def chat_complete(self, **kwargs: Any) -> Any:
            class Done:
                text = "完全不含验证 section 的输出"
                reasoning = ""

            return Done()

    tool = VerifySolutionTool(GarbageLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        2,
        "elementary_upper",
        "鸡兔同笼，头35，脚94",
        {
            "solution_answer": "鸡 23 只，兔 12 只",
            "solution_steps": [{"description": "假设法", "operation": "35*2=70", "result": "70"}],
            "solve_math_evidence": {
                "success": True,
                "applicable": True,
                "all_claims_passed": True,
            },
        },
    )

    first = asyncio.run(tool.execute({}, ctx))
    assert first.success is False
    assert any(a.kind == "raw_model_output" for a in first.artifacts)

    second = asyncio.run(tool.execute({}, ctx))
    assert second.success is False
    # After two format failures the tool forces logical mode for attempt 3.
    assert ctx.state.get("force_logical_verification") is True

    third = asyncio.run(tool.execute({}, ctx))
    # The forced-logical attempt also failed on format: degrade with a
    # warning backed by solve-side evidence — never die to formatting.
    assert third.success is True
    assert third.data["verification_downgraded"] is True
    assert third.data["solve_evidence_backed"] is True
    assert ctx.state["solution_verified"] is True
    assert "verification_downgraded" in ctx.state


def test_verify_downgrade_without_solve_evidence_still_delivers_with_warning() -> None:
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class GarbageLLM:
        async def chat_complete(self, **kwargs: Any) -> Any:
            class Done:
                text = "无效输出"
                reasoning = ""

            return Done()

    tool = VerifySolutionTool(GarbageLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        2,
        "elementary_upper",
        "题目",
        {
            "solution_answer": "42",
            "solution_steps": [{"description": "步骤"}],
            "solve_math_evidence": {"success": True, "applicable": False},
        },
    )
    for _ in range(2):
        assert asyncio.run(tool.execute({}, ctx)).success is False
    third = asyncio.run(tool.execute({}, ctx))
    assert third.success is True
    assert third.data["solve_evidence_backed"] is False
    assert "无确定性证据" in ctx.state["verification_downgraded"]


# ---------------------------------------------------------------------------
# Failure-surface audit fixes: parsing tolerance, format retry, re-solve grant
# ---------------------------------------------------------------------------


def test_parse_solution_accepts_heading_synonyms_and_step_shapes() -> None:
    from math_tutor.infrastructure.agent.tools.solve_problem import _parse_solution

    def done_with(text: str) -> Any:
        class Done:
            reasoning = ""

        Done.text = text
        return Done()

    for heading in ("解题", "解题定稿", "解答", "解题过程"):
        payload = _parse_solution(
            done_with(
                f"## {heading}\n**最终答案**: 4\n### 第 1 步\n- 描述: 求解\n- 结果: 4\n"
            )
        )
        assert payload and payload["steps"], heading

    # Level-4 step headings.
    payload = _parse_solution(
        done_with("## 解题\n**最终答案**: 4\n#### 第 1 步\n- 描述: 求解\n- 结果: 4\n")
    )
    assert payload and payload["steps"]

    # Bold inline step markers.
    payload = _parse_solution(
        done_with(
            "## 解题\n**最终答案**: 4\n**第1步**：\n- 描述: 求解\n- 结果: 4\n"
            "**第2步**：\n- 描述: 核对\n- 结果: 成立\n"
        )
    )
    assert payload and len(payload["steps"]) == 2


def test_solve_format_failure_gets_one_retry_with_feedback() -> None:
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.solve_problem import SolveProblemTool

    good = "\n".join(
        [
            "## 分析",
            "**难度**: easy",
            "## 确定性计算",
            '```json\n{"engine": "none", "reason": "简单算术"}\n```',
            "## 解题",
            "**策略**: 直接计算",
            "**最终答案**: 3",
            "### 第 1 步",
            "- 描述: 相减",
            "- 运算: 5 - 2 = 3",
            "- 解释: 拿走 2 个",
            "- 结果: 3",
        ]
    )

    class FlakyLLM:
        calls = 0

        async def chat_complete(self, **kwargs: Any) -> Any:
            FlakyLLM.calls += 1

            class Done:
                reasoning = ""
                finish_reason = "stop"

            # First call: prose without any parseable section; retry: good.
            Done.text = "这是一段没有结构的说明文字。" if FlakyLLM.calls == 1 else good
            if FlakyLLM.calls == 2:
                prompt = kwargs.get("messages")[0].content
                assert "上次输出格式无法解析" in prompt
            return Done()

    FlakyLLM.calls = 0
    tool = SolveProblemTool(FlakyLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext("s", 1, "elementary", "5-2", {})
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert FlakyLLM.calls == 2
    assert ctx.state["solution_answer"] == "3"


def test_loop_grants_one_resolve_after_math_rejection() -> None:
    class NeverCalledLLM:
        def chat_stream(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("controller LLM must not run")

    class MemoryStore:
        def __init__(self) -> None:
            self.updated: dict[str, Any] = {}
            self.artifact_id = 0

        async def create_session(self, **kwargs: Any) -> str:
            return "session"

        async def append_message(self, *args: Any, **kwargs: Any) -> int:
            return 1

        async def record_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def complete_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def update_session(self, session_id: str, **kwargs: Any) -> None:
            self.updated = kwargs

        async def save_text_artifact(self, *args: Any, **kwargs: Any) -> tuple[int, str]:
            self.artifact_id += 1
            return self.artifact_id, "a.json"

        async def add_artifact(self, *args: Any, **kwargs: Any) -> int:
            self.artifact_id += 1
            return self.artifact_id

    class StageTool(ITool):
        solve_calls = 0
        verify_calls = 0

        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        @property
        def description(self) -> str:
            return self._name

        @property
        def parameters(self) -> dict[str, Any]:
            return {"type": "object", "properties": {}, "required": []}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            state = ctx.state
            if self.name == "solve_problem":
                StageTool.solve_calls += 1
                state["solution_steps"] = [{"description": f"v{StageTool.solve_calls}"}]
                state["solution_answer"] = str(StageTool.solve_calls)
                state["solution_verified"] = False
                state.pop("last_verify_failure", None)
                return ToolResult(success=True, summary="solved")
            if self.name == "verify_solution":
                StageTool.verify_calls += 1
                if StageTool.verify_calls == 1:
                    # Mathematical rejection routes back to solve.
                    state["solution_verified"] = False
                    state["last_verify_failure"] = "答案与独立验算不符"
                    return ToolResult(success=False, summary="rejected", error="bad math")
                state["solution_verified"] = True
                return ToolResult(success=True, summary="ok")
            if self.name == "direct_video":
                state["visual_plan"] = _open_world_plan()
            elif self.name == "compile_video":
                state["latest_video_path"] = "v.mp4"
                state["latest_video_url"] = "/v.mp4"
            elif self.name == "watch_video":
                state["last_visual_review"] = {"overall_quality": "good"}
                state["last_visual_failed"] = False
            return ToolResult(success=True, summary="ok")

    StageTool.solve_calls = 0
    StageTool.verify_calls = 0
    registry = ToolRegistry()
    for name in (
        "solve_problem",
        "verify_solution",
        "direct_video",
        "compile_video",
        "watch_video",
    ):
        registry.register(StageTool(name))
    store = MemoryStore()
    loop = AgentLoop(
        llm=NeverCalledLLM(),  # type: ignore[arg-type]
        registry=registry,
        composer=PromptComposer(),
        store=store,  # type: ignore[arg-type]
        use_latex=False,
        max_turns=10,
        deterministic_workflow=True,
    )

    async def collect() -> list[Any]:
        return [event async for event in loop.run(problem="p", grade="middle")]

    events = asyncio.run(collect())
    done = [event for event in events if isinstance(event, DoneEvent)][-1]
    # The math rejection earned one re-solve; the session completed.
    assert StageTool.solve_calls == 2
    assert done.status == "ok"
    assert store.updated.get("status") == "done"


def test_verify_llm_outage_routes_through_degradation_ladder() -> None:
    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class DeadLLM:
        async def chat_complete(self, **kwargs: Any) -> Any:
            raise ConnectionError("LM Studio unreachable")

    tool = VerifySolutionTool(DeadLLM(), PromptLibrary())  # type: ignore[arg-type]
    ctx = ToolContext(
        "s",
        2,
        "elementary",
        "p",
        {
            "solution_answer": "3",
            "solution_steps": [{"description": "d"}],
            "solve_math_evidence": {
                "success": True,
                "applicable": True,
                "all_claims_passed": True,
            },
        },
    )
    assert asyncio.run(tool.execute({}, ctx)).success is False
    assert asyncio.run(tool.execute({}, ctx)).success is False
    third = asyncio.run(tool.execute({}, ctx))
    # Persistent outage degrades with solve-evidence backing instead of
    # exhausting the stage budget into a dead session.
    assert third.success is True
    assert third.data["verification_downgraded"] is True


# ---------------------------------------------------------------------------
# Field diagnosis (qwen3.7-27b runs): audit slicing, near-miss normalization
# ---------------------------------------------------------------------------


def test_audit_filter_does_not_slice_subexpressions() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _machine_checkable_blocking_issue,
    )

    # The field misfire: "2*4+5=13" is TRUE, but the old three-token pattern
    # sliced out "4+5=13" and vetoed a zero-violation balance plan.
    assert not _machine_checkable_blocking_issue(
        "BLOCKING: 验证步骤的视觉实现与代数逻辑矛盾; observed=计划中 verify 场景仅操作 "
        "x_single (1个x) 和 const_4 (4个红点)，并声称'左边显示 2 个 x (即 8) 加 5 个红点'; "
        "expected=根据题目 2x+5=13，验证时需展示 2*4+5=13。"
    )
    # A genuinely false full equality still blocks.
    assert _machine_checkable_blocking_issue(
        "BLOCKING: 数值错误 observed=按计划 3*4+5=20 expected=17"
    )
    # Single-number observed/expected contradiction still blocks.
    assert _machine_checkable_blocking_issue(
        "BLOCKING: 顶点错误 observed=7 expected=12"
    )


def test_normalize_repairs_quantity_verb_near_misses() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _normalize_plan,
        _validate_plan,
    )

    plan = _quantity_plan_base()
    # Field shapes from the chicken-rabbit run: invalid style and a result
    # id that was never declared.
    plan["scenes"][1]["actions"][1]["style"] = "transform"
    plan["scenes"][1]["actions"].append(
        {
            "op": "transform",
            "targets": ["removed_box"],
            "result": "undeclared_result_box",
            "meaning": "分组结果",
        }
    )
    normalized = _normalize_plan(plan)
    take = normalized["scenes"][1]["actions"][1]
    assert take["style"] == "fly"
    declared = {item["id"] for item in normalized["visual_objects"]}
    assert "undeclared_result_box" in declared
    errors = _validate_plan(normalized, "elementary")
    assert not any("style" in error for error in errors)
    assert not any("undeclared_result_box" in error for error in errors)


def test_validator_flags_silent_set_text_trap() -> None:
    code = "\n".join(
        [
            "from manim import *",
            "class SolutionScene(Scene):",
            "    def construct(self):",
            "        label = Text('0')",
            "        label.add_updater(lambda m: m.set_text('1'))",
            "        self.add(label)",
        ]
    )
    issues = _check_animation_api_misuse(ast.parse(code))
    assert any("set_text" in issue for issue in issues)


def test_minimal_narrative_plan_always_validates() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _validate_plan,
        build_minimal_narrative_plan,
    )

    # With numbers.
    ctx = ToolContext(
        "s",
        3,
        "middle",
        "p",
        {"solution_answer": "x = 4", "solution_steps": [{"result": "2x = 8"}]},
    )
    plan = build_minimal_narrative_plan(ctx)
    assert plan is not None and _validate_plan(plan, "middle") == []
    # Without any numbers (proof-style answers) it still builds.
    ctx2 = ToolContext(
        "s", 3, "high", "p", {"solution_answer": "命题成立", "solution_steps": []}
    )
    plan2 = build_minimal_narrative_plan(ctx2)
    assert plan2 is not None and _validate_plan(plan2, "high") == []


# ---------------------------------------------------------------------------
# Review timeout resilience and verify selector near-misses
# ---------------------------------------------------------------------------


def test_watch_timeout_delivers_degraded_instead_of_stranding_session() -> None:
    class NeverCalledLLM:
        def chat_stream(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("controller LLM must not run")

    class MemoryStore:
        def __init__(self) -> None:
            self.updated: dict[str, Any] = {}
            self.artifact_id = 0

        async def create_session(self, **kwargs: Any) -> str:
            return "session"

        async def append_message(self, *args: Any, **kwargs: Any) -> int:
            return 1

        async def record_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def complete_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def update_session(self, session_id: str, **kwargs: Any) -> None:
            self.updated = kwargs

        async def save_text_artifact(self, *args: Any, **kwargs: Any) -> tuple[int, str]:
            self.artifact_id += 1
            return self.artifact_id, "a.json"

        async def add_artifact(self, *args: Any, **kwargs: Any) -> int:
            self.artifact_id += 1
            return self.artifact_id

    class StageTool(ITool):
        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        @property
        def description(self) -> str:
            return self._name

        @property
        def parameters(self) -> dict[str, Any]:
            return {"type": "object", "properties": {}, "required": []}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            state = ctx.state
            if self.name == "solve_problem":
                state["solution_steps"] = [{"description": "d"}]
                state["solution_answer"] = "3"
                state["solution_verified"] = False
            elif self.name == "verify_solution":
                state["solution_verified"] = True
            elif self.name == "direct_video":
                state["visual_plan"] = _open_world_plan()
            elif self.name == "compile_video":
                state["latest_video_path"] = "v.mp4"
                state["latest_video_url"] = "/v.mp4"
            elif self.name == "watch_video":
                # Simulate a mid-repair kill: the plan replan already cleared
                # the delivered candidate, then the composite hangs.
                state.pop("latest_video_path", None)
                state.pop("latest_video_url", None)
                state["best_visual_candidate"] = {
                    "video_path": "best.mp4",
                    "video_url": "/best.mp4",
                    "code": "code",
                    "score": 8,
                }
                await asyncio.sleep(30)
            return ToolResult(success=True, summary="ok")

    registry = ToolRegistry()
    for name in (
        "solve_problem",
        "verify_solution",
        "direct_video",
        "compile_video",
        "watch_video",
    ):
        registry.register(StageTool(name))
    store = MemoryStore()
    loop = AgentLoop(
        llm=NeverCalledLLM(),  # type: ignore[arg-type]
        registry=registry,
        composer=PromptComposer(),
        store=store,  # type: ignore[arg-type]
        use_latex=False,
        max_turns=8,
        deterministic_workflow=True,
        tool_timeout_s=0.05,
    )

    async def collect() -> list[Any]:
        return [event async for event in loop.run(problem="p", grade="middle")]

    events = asyncio.run(collect())
    done = [event for event in events if isinstance(event, DoneEvent)][-1]
    # The timed-out review restores the best candidate and completes the
    # session as a degraded delivery instead of dying at a later budget.
    assert done.status == "ok"
    assert done.final_video_path == "best.mp4"
    assert store.updated.get("status") == "done"


def test_math_runtime_accepts_string_key_and_field_selector_shapes() -> None:
    from math_tutor.infrastructure.agent.math_runtime import execute_math_request

    base_ops = [
        {
            "id": "solve_system",
            "op": "solve",
            "expression": ["chicken + rabbit - 35", "2*chicken + 4*rabbit - 94"],
            "variables": ["chicken", "rabbit"],
        }
    ]
    symbols = {
        "chicken": {"domain": "nonnegative"},
        "rabbit": {"domain": "nonnegative"},
    }
    # Field shapes from the chicken-rabbit verify attempts: string subscript
    # and direct field access without [0].
    for left in (
        "$solve_system[0]['chicken']",
        "$solve_system['chicken']",
        "$solve_system.chicken",
        "$solve_system[0].chicken",
    ):
        result = execute_math_request(
            {
                "engine": "sympy",
                "symbols": symbols,
                "operations": base_ops,
                "claims": [
                    {"id": "c", "relation": "equal", "left": left, "right": "23"}
                ],
            }
        )
        assert result.success and result.all_claims_passed, (left, result.errors, result.claims)


# ---------------------------------------------------------------------------
# Linear-mix structure: first-shot deterministic assumption-swap plan
# ---------------------------------------------------------------------------


def _mix_state() -> dict[str, Any]:
    return {
        "solution_verified": True,
        "solution_answer": "鸡有 23 只，兔有 12 只",
        "solution_steps": [{"description": "假设法", "result": "12"}],
        "verify_math_request": {
            "engine": "sympy",
            "symbols": {
                "chicken": {"domain": "nonnegative"},
                "rabbit": {"domain": "nonnegative"},
            },
            "operations": [
                {
                    "id": "solve_system",
                    "op": "solve",
                    "expression": ["chicken + rabbit - 35", "2*chicken + 4*rabbit - 94"],
                    "variables": ["chicken", "rabbit"],
                }
            ],
            "claims": [],
        },
        "verify_math_evidence": {
            "success": True,
            "all_claims_passed": True,
            "operations": [{"id": "solve_system", "result": "ok"}],
        },
    }


def test_extract_linear_mix_structure_by_coefficient_shape() -> None:
    from math_tutor.infrastructure.agent.math_runtime import extract_linear_mix_structure

    mix = extract_linear_mix_structure(_mix_state()["verify_math_request"])
    assert mix is not None
    assert mix["total_units"] == 35
    assert (mix["value_a"], mix["value_b"]) == (2, 4)
    assert (mix["count_a"], mix["count_b"]) == (23, 12)
    assert mix["total_value"] == 94

    # Orientation normalizes so swaps always ADD marks.
    reversed_request = {
        "operations": [
            {
                "id": "s",
                "op": "solve",
                "expression": ["4*r + 2*c - 94", "r + c - 35"],
                "variables": ["r", "c"],
            }
        ]
    }
    mix2 = extract_linear_mix_structure(reversed_request)
    assert mix2 is not None and mix2["value_a"] < mix2["value_b"]

    # Non-mix shapes abstain: quadratic, one-var, non-integer solutions.
    assert extract_linear_mix_structure(
        {
            "operations": [
                {
                    "id": "s",
                    "op": "solve",
                    "expression": "x**2 - 4",
                    "variable": "x",
                }
            ]
        }
    ) is None
    assert extract_linear_mix_structure(
        {
            "operations": [
                {
                    "id": "s",
                    "op": "solve",
                    "expression": ["x + y - 10", "3*x + 7*y - 23"],
                    "variables": ["x", "y"],
                }
            ]
        }
    ) is None  # solution not integral


def test_mix_swap_plan_builds_validates_and_compiles() -> None:
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _validate_plan,
        build_mix_swap_visual_plan,
    )

    ctx = ToolContext("s", 3, "elementary_upper", "鸡兔同笼，头35，脚94", _mix_state())
    plan = build_mix_swap_visual_plan(ctx)
    assert plan is not None
    assert plan["grounding_source"] == "linear_mix_swap"
    assert _validate_plan(plan, "elementary_upper") == []
    swap = next(
        action
        for scene in plan["scenes"]
        for action in scene["actions"]
        if action["op"] == "swap_units"
    )
    assert swap["count"] == 12
    assert swap["expect"] == 4
    assert swap["expect_total"] == 94
    # Template compiles the plan end to end.
    ctx.state["visual_plan"] = plan
    code = build_verified_fallback_code(ctx)
    compile(code, "<mix-swap>", "exec")
    assert "swap_units" in code


def test_direct_video_prefers_mix_swap_over_llm_director() -> None:
    from math_tutor.infrastructure.agent.tools.direct_video import DirectVideoTool

    class NeverCalledPlanner:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise AssertionError("LLM director must not run for a verified mix structure")

    ctx = ToolContext("s", 3, "elementary_upper", "鸡兔同笼", _mix_state())
    result = asyncio.run(DirectVideoTool(NeverCalledPlanner()).execute({}, ctx))  # type: ignore[arg-type]
    assert result.success is True
    assert ctx.state["visual_plan"]["grounding_source"] == "linear_mix_swap"
