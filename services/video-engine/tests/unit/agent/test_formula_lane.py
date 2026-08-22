"""板书带（formula lane）契约：真算式专位渲染，字幕/文字卡不再承载等式。

2026-08-22 人工评审定案：推导必须写出真算式，不能用文字描述堆叠；
实机反例是导演创建 label 为「算式」的卡片压在字幕带上，等式却散落在字幕里。
"""

from math_tutor.infrastructure.agent.tools.compile_video import (
    _build_visual_ir_fallback_code,
    _fallback_visual_ir,
)
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _placeholder_formula_text,
    _validate_plan,
)


def _scene(role: str, *, teaching_line: str = "看这里", formula: str | None = None,
           targets: list[str] | None = None, op: str = "create") -> dict:
    return {
        "role": role,
        "anchor_zone": "B2-E5",
        "key_objects": "part_a, part_b",
        "action": "对象出现并被核对",
        "invariant": "总量不变",
        "attention_target": "两块的关系",
        "exit_condition": "关系可见",
        "teaching_line": teaching_line,
        "formula": formula,
        "duration_s": 5,
        "actions": [
            {"op": op, "targets": targets or ["part_a", "part_b"], "result": "",
             "meaning": "建立对象"},
        ],
    }


def _plan(**overrides) -> dict:
    plan = {
        "visual_thesis": "两块面积的和保持不变，重组后差值就是答案",
        "essence_rationale": "因为总量守恒，两块重组前后面积之和不变，差值直接可见",
        "symbol_ledger": ["蓝色 = 已知部分", "绿色 = 结论部分"],
        "visual_objects": [
            {"id": "part_a", "primitive": "rectangle", "meaning": "已知面积块",
             "label": "12", "color": "blue", "params": {}},
            {"id": "part_b", "primitive": "rectangle", "meaning": "待求面积块",
             "label": "16", "color": "green", "params": {}},
        ],
        "scenes": [
            _scene("setup"),
            _scene("transform", op="transform", targets=["part_a"]) | {
                "actions": [{"op": "transform", "targets": ["part_a"],
                             "result": "part_b", "meaning": "重组"}],
            },
            _scene("verify", op="verify"),
        ],
    }
    plan.update(overrides)
    return plan


def _errors_containing(errors: list[str], keyword: str) -> list[str]:
    return [item for item in errors if keyword in item]


def test_false_formula_equality_blocks_the_plan() -> None:
    plan = _plan()
    plan["scenes"][2]["formula"] = "5 + 8 = 14"
    assert _errors_containing(_validate_plan(plan, "elementary_upper"), "计算错误")


def test_correct_formula_passes_equality_check() -> None:
    plan = _plan()
    plan["scenes"][2]["formula"] = "28 - 12 = 16"
    errors = _validate_plan(plan, "elementary_upper")
    assert not _errors_containing(errors, "计算错误")
    assert not _errors_containing(errors, "teaching_line")


def test_placeholder_formula_word_is_rejected() -> None:
    plan = _plan()
    plan["scenes"][2]["formula"] = "算式"
    assert _errors_containing(_validate_plan(plan, "elementary_upper"), "占位词")


def test_equation_in_teaching_line_without_formula_is_rejected() -> None:
    plan = _plan()
    plan["scenes"][2]["teaching_line"] = "28-12=16，所以答案是 16"
    assert _errors_containing(
        _validate_plan(plan, "elementary_upper"), "把算式写进了 teaching_line"
    )


def test_equation_in_teaching_line_tolerated_when_formula_present() -> None:
    plan = _plan()
    plan["scenes"][2]["teaching_line"] = "核对 28-12=16"
    plan["scenes"][2]["formula"] = "28 - 12 = 16"
    assert not _errors_containing(
        _validate_plan(plan, "elementary_upper"), "把算式写进了 teaching_line"
    )


def test_placeholder_object_label_is_rejected() -> None:
    plan = _plan()
    plan["visual_objects"][1]["label"] = "算式"
    assert _errors_containing(_validate_plan(plan, "elementary_upper"), "占位词")


def test_internal_builder_plans_are_exempt() -> None:
    plan = _plan(grounding_source="verified_solution_arithmetic")
    plan["scenes"][2]["teaching_line"] = "28-12=16"
    plan["visual_objects"][1]["label"] = "算式"
    errors = _validate_plan(plan, "elementary_upper")
    assert not _errors_containing(errors, "占位词")
    assert not _errors_containing(errors, "把算式写进了 teaching_line")


def test_expression_on_both_sides_is_not_a_false_equality() -> None:
    # 守恒惯用式「5 + 8 = 7 + 6」为真（实机回归：曾被截成 5+8=7 连续否掉正确首稿）
    plan = _plan()
    plan["scenes"][2]["formula"] = "5 + 8 = 7 + 6"
    assert not _errors_containing(_validate_plan(plan, "elementary_upper"), "计算错误")
    plan["scenes"][2]["formula"] = "5 + 8 = 7 + 5"
    assert _errors_containing(_validate_plan(plan, "elementary_upper"), "计算错误")


def test_placeholder_text_detector() -> None:
    assert _placeholder_formula_text("算式")
    assert _placeholder_formula_text("等式(II)")
    assert not _placeholder_formula_text("算式：5+8=13")
    assert not _placeholder_formula_text("公式 S = ab")
    assert not _placeholder_formula_text("28 - 12 = 16")


def _raw_ir_plan(formula: str | None) -> dict:
    return {
        "visual_objects": [
            {"id": "part_a", "primitive": "rectangle", "meaning": "已知块",
             "label": "12", "color": "blue", "params": {}},
            {"id": "part_b", "primitive": "rectangle", "meaning": "结论块",
             "label": "16", "color": "green", "params": {}},
        ],
        "scenes": [
            {"role": "setup", "teaching_line": "先看已知", "formula": None,
             "duration_s": 4,
             "actions": [{"op": "create", "targets": ["part_a"], "result": "",
                          "meaning": "出现"}]},
            {"role": "verify", "teaching_line": "核对差值", "formula": formula,
             "duration_s": 4,
             "actions": [{"op": "verify", "targets": ["part_a", "part_b"],
                          "result": "", "meaning": "核对"}]},
        ],
    }


def test_fallback_visual_ir_carries_formula_through() -> None:
    ir = _fallback_visual_ir(_raw_ir_plan("$28 - 12 = 16$"))
    assert ir is not None
    assert ir["scenes"][0]["formula"] == ""
    # LaTeX 装饰被剥掉，内容原样进板书带
    assert ir["scenes"][1]["formula"] == "28 - 12 = 16"


def test_generated_scene_code_renders_the_formula_lane() -> None:
    ir = _fallback_visual_ir(_raw_ir_plan("28 - 12 = 16"))
    assert ir is not None
    code = _build_visual_ir_fallback_code(
        problem="矩形面积差", answer="16", visual_ir=ir
    )
    assert "def show_formula" in code
    assert "self.show_formula(formula, scene.get(\"formula\"))" in code
    # 自由对象窄带不再沉到字幕/板书带（2.95 是实机重叠位）
    assert "DOWN * (2.95" not in code
