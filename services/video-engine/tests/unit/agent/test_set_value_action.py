"""set_value 动作：词表接受它，生成的 Manim 脚本也真的会画。

为什么要这两条一起：
- 只在词表里加名字，闸门放行了、播放器也认了，但 Manim 那条路会掉进
  「Indicate 一下」的兜底——旁白说"吃掉 3 个，还剩 9 个"，画面上的条一直是 12。
  那是画了个假话，而且没有任何地方会报错。
- 反过来只改模板不改词表，导演写了也会被校验器拦下来。
"""
from __future__ import annotations

from math_tutor.infrastructure.agent.tools.compile_video import (
    _build_visual_ir_fallback_code,
)
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _MUTATING_VISUAL_ACTIONS,
    _VISUAL_ACTIONS,
)


def test_vocabulary_accepts_set_value() -> None:
    assert "set_value" in _VISUAL_ACTIONS
    # 它确实改变画面：不进"会改变画面"的集合，某些重排/门禁会当它是纯标注
    assert "set_value" in _MUTATING_VISUAL_ACTIONS


def test_generated_script_compiles_and_handles_set_value() -> None:
    code = _build_visual_ir_fallback_code(
        problem="篮子里有 12 个苹果，吃掉 3 个，还剩几个？",
        answer="9",
        visual_ir={
            "objects": [
                {
                    "id": "basket",
                    "primitive": "quantity_bar",
                    "meaning": "篮子里剩下的苹果数",
                    "params": {"value": 12},
                }
            ],
            "scenes": [
                {
                    "id": "s1",
                    "role": "setup",
                    "teaching_line": "篮子里有 12 个苹果",
                    "duration_s": 3,
                    "actions": [
                        {"op": "create", "targets": ["basket"], "meaning": "12 个苹果"},
                    ],
                },
                {
                    "id": "s2",
                    "role": "transform",
                    "teaching_line": "吃掉 3 个，还剩 9 个",
                    "duration_s": 3,
                    "actions": [
                        {
                            "op": "set_value",
                            "targets": ["basket"],
                            "value": 9,
                            "meaning": "条缩短到 9",
                        },
                    ],
                },
            ],
        },
    )

    # 生成的脚本必须是合法 Python（模板是原始字符串，写错一个引号就整段失效）
    compile(code, "<generated-solution-scene>", "exec")
    # 且真的带上了这个分支——否则会静默落进 Indicate 兜底
    assert 'elif op == "set_value"' in code
    # 重画同一根条靠的是这个辅助方法，不能又内联一份形状代码
    assert "def bar_body(" in code
