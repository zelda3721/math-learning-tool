"""解题升级梯：首解走常规 reasoner；verify 打回过的重解换更强的模型。"""
from __future__ import annotations

from types import SimpleNamespace

from math_tutor.infrastructure.agent.tools.solve_problem import SolveProblemTool


def _tool(escalation):
    tool = SolveProblemTool.__new__(SolveProblemTool)
    tool._llm = "fast"
    tool._vision_llm = "fast-vision"
    tool._escalation_llm = escalation
    return tool


def _ctx(**state):
    return SimpleNamespace(state=state)


def test_首解用常规reasoner():
    text, vision, escalated = _tool("strong")._pick_llms(_ctx())
    assert (text, vision, escalated) == ("fast", "fast-vision", False)


def test_verify打回后升级_文本与图都换强模型():
    text, vision, escalated = _tool("strong")._pick_llms(_ctx(last_verify_failure="结论不成立"))
    assert (text, vision, escalated) == ("strong", "strong", True)
    text, vision, escalated = _tool("strong")._pick_llms(_ctx(verify_format_failure_count=2))
    assert escalated and text == "strong"


def test_未配置升级模型时行为不变():
    text, vision, escalated = _tool(None)._pick_llms(_ctx(last_verify_failure="x"))
    assert (text, vision, escalated) == ("fast", "fast-vision", False)
