"""解题升级梯：首解走常规 reasoner；verify 打回过的重解换更强的模型。"""
from __future__ import annotations

from types import SimpleNamespace

from math_tutor.infrastructure.agent.tools.solve_problem import SolveProblemTool


def test_wall_clock_budget_switches_to_escalation_model() -> None:
    import time

    tool = SolveProblemTool.__new__(SolveProblemTool)
    tool._escalation_llm = object()
    ctx = SimpleNamespace(state={})
    moe = object()
    # 预算内：不切换
    llm, escalated = tool._maybe_escalate_mid(ctx, moe, False, time.monotonic(), "s")
    assert llm is moe and escalated is False
    # 超预算：切换并留痕
    started = time.monotonic() - tool._ESCALATION_AFTER_S - 1
    llm, escalated = tool._maybe_escalate_mid(ctx, moe, False, started, "structured_write")
    assert llm is tool._escalation_llm and escalated is True
    assert ctx.state.get("solve_escalated_mid") == "structured_write"
    # 已升级：不重复切换
    llm2, escalated2 = tool._maybe_escalate_mid(ctx, llm, True, started, "s")
    assert llm2 is llm and escalated2 is True


def test_no_answer_solve_reruns_itself_with_escalation() -> None:
    """无答案/调用故障时 solve 内部自升级——循环模型两次无视'请重解'指示的教训。"""
    import asyncio

    tool = SolveProblemTool.__new__(SolveProblemTool)
    tool._escalation_llm = object()
    calls = []

    async def fake_execute(args, ctx):
        calls.append(dict(ctx.state))
        return "rerun-sentinel"

    tool.execute = fake_execute  # type: ignore[method-assign]
    ctx = SimpleNamespace(state={})
    # 模拟无答案分支的判定逻辑：未升级 + 有升级模型 → 递归重跑
    escalated = False
    ctx.state["solve_no_answer_count"] = 1
    if tool._escalation_llm is not None and not escalated:
        result = asyncio.run(tool.execute({}, ctx))
    assert result == "rerun-sentinel"
    assert calls and calls[0]["solve_no_answer_count"] == 1


def test_no_answer_count_triggers_escalation() -> None:
    # 实机：素解降级导致解题无答案——重解必须直接上升级模型
    tool = SolveProblemTool.__new__(SolveProblemTool)
    tool._llm, tool._vision_llm = object(), object()
    tool._escalation_llm = object()
    ctx = SimpleNamespace(state={"solve_no_answer_count": 1})
    text_llm, vision_llm, escalated = tool._pick_llms(ctx)
    assert escalated is True
    assert text_llm is tool._escalation_llm and vision_llm is tool._escalation_llm


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
