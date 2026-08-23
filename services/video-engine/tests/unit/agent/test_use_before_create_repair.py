"""use-before-create 自动修复与 Math IR 保留名放宽的回归。

实机（2026-08-23 照片题）：二稿三个错全是「eq_node 未 create 就 highlight/verify」，
导演因此降级；verify 曾因运算取名 diff 被硬报错白重试 80s+。
"""

from math_tutor.infrastructure.agent.math_runtime import execute_math_request
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _repair_use_before_create,
    _validate_plan,
)


def _plan_with_late_conclusion() -> dict:
    return {
        "visual_thesis": "两块面积的和保持不变，重组后差值就是答案",
        "essence_rationale": "因为总量守恒，两块重组前后面积之和不变，差值直接可见",
        "symbol_ledger": ["蓝色 = 已知部分", "绿色 = 结论部分"],
        "visual_objects": [
            {"id": "part_a", "primitive": "rectangle", "meaning": "已知面积块",
             "label": "12", "color": "blue", "params": {}},
            {"id": "part_b", "primitive": "rectangle", "meaning": "待求面积块",
             "label": "16", "color": "green", "params": {}},
            {"id": "eq_node_m", "primitive": "relation_node", "meaning": "守恒结论",
             "label": "守恒", "color": "yellow", "params": {}},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "B2-E5", "key_objects": "part_a",
             "action": "建立", "invariant": "无，当前建立初始状态",
             "attention_target": "已知块", "exit_condition": "可见",
             "teaching_line": "先看已知", "formula": None, "duration_s": 4,
             "actions": [{"op": "create", "targets": ["part_a", "part_b"],
                          "result": "", "meaning": "出现"}]},
            {"role": "transform", "anchor_zone": "B2-E5", "key_objects": "part_a",
             "action": "重组", "invariant": "总量不变", "attention_target": "变化",
             "exit_condition": "重组完成", "teaching_line": "看重组",
             "formula": "28 - 12 = 16", "duration_s": 5,
             "actions": [{"op": "transform", "targets": ["part_a"],
                          "result": "part_b", "meaning": "重组"}]},
            {"role": "verify", "anchor_zone": "B2-E5", "key_objects": "eq_node_m",
             "action": "核对", "invariant": "结论成立", "attention_target": "结论",
             "exit_condition": "核对完成", "teaching_line": "最后核对",
             "formula": None, "duration_s": 4,
             # eq_node_m 从未 create——实机导演二稿的完整错误模式
             "actions": [{"op": "highlight", "targets": ["eq_node_m"],
                          "result": "", "meaning": "点亮结论"},
                         {"op": "verify", "targets": ["eq_node_m", "part_b"],
                          "result": "", "meaning": "核对"}]},
        ],
    }


def test_late_conclusion_object_gets_auto_created() -> None:
    plan = _plan_with_late_conclusion()
    _repair_use_before_create(plan)
    verify_actions = plan["scenes"][2]["actions"]
    assert verify_actions[0]["op"] == "create"
    assert verify_actions[0]["targets"] == ["eq_node_m"]
    assert plan.get("auto_repairs")
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "在对象出现前执行" in e]


def test_repair_does_not_touch_quantity_verbs() -> None:
    plan = _plan_with_late_conclusion()
    plan["scenes"][2]["actions"] = [
        {"op": "combine", "targets": ["eq_node_m", "part_b"], "result": "part_a",
         "meaning": "合并", "source": None, "destination": None, "count": None},
    ]
    _repair_use_before_create(plan)
    assert plan["scenes"][2]["actions"][0]["op"] == "combine"  # 不注入 create
    assert not plan.get("auto_repairs")


def test_operation_id_may_shadow_function_names() -> None:
    result = execute_math_request(
        {
            "variables": [],
            "operations": [
                {"id": "diff", "op": "evaluate", "expression": "28 - 12"},
                {"id": "total", "op": "evaluate", "expression": "diff + 4"},
            ],
            "claims": [{"relation": "equal", "left": "$total", "right": 20}],
        }
    )
    assert result.success, result.errors
    assert result.all_claims_passed is True
