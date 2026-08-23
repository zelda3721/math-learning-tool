"""无证据降级放行前必须先升级重解——今天咬了两次的验证洞。

实机：错答案 4 走无证据降级放行拿到 good 成片；正确答案 6 也曾未经独立
核实交付。升级梯配置可用时，空放行改为失败并指路重解。
"""

from types import SimpleNamespace

from math_tutor.application.interfaces import ToolContext
from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool


def _tool(escalation: bool) -> VerifySolutionTool:
    tool = VerifySolutionTool.__new__(VerifySolutionTool)
    tool._escalation_available = escalation
    return tool


def _ctx(state: dict) -> ToolContext:
    return SimpleNamespace(state=state, turn_index=1)


def _degrade(tool, state):
    ctx = _ctx(state)
    # 三次格式失败后进入 count>=3 分支
    state["verify_format_failure_count"] = 2
    done = SimpleNamespace(text="", reasoning="", finish_reason="stop")
    return tool._format_failure_result(ctx, done, "格式失败", error="format"), ctx


def test_no_evidence_degrade_demands_escalated_resolve_first() -> None:
    tool = _tool(escalation=True)
    result, ctx = _degrade(tool, {"solve_math_evidence": {}})
    assert result.success is False
    assert result.error == "needs_escalated_resolve"
    assert "solve_problem" in result.summary
    assert ctx.state.get("last_verify_failure")


def test_no_evidence_degrade_passes_after_escalated_solve() -> None:
    tool = _tool(escalation=True)
    result, ctx = _degrade(tool, {"solve_math_evidence": {}, "solve_was_escalated": True})
    assert result.success is True
    assert ctx.state.get("verification_untrusted") is True  # 仍然不可入库判卷


def test_no_evidence_degrade_passes_when_no_escalation_configured() -> None:
    tool = _tool(escalation=False)
    result, ctx = _degrade(tool, {"solve_math_evidence": {}})
    assert result.success is True
    assert ctx.state.get("verification_untrusted") is True


def test_solve_backed_degrade_is_not_blocked() -> None:
    tool = _tool(escalation=True)
    result, ctx = _degrade(tool, {
        "solve_math_evidence": {"applicable": True, "all_claims_passed": True},
    })
    assert result.success is True
    assert ctx.state.get("verification_untrusted") is None
