"""POST /api/v1/plan — plan-only endpoint (engine invasion #4).

Runs Solve → Verify → Direct with a stubbed registry and asserts the
SceneSpec is returned without touching Compile/Watch.
"""
from typing import Any

from fastapi.testclient import TestClient

from math_tutor.api.main import app
from math_tutor.application.interfaces.tool import ToolContext, ToolResult
from math_tutor.config.dependencies import get_tool_registry
from math_tutor.infrastructure.agent import ToolRegistry


class _FakeTool:
    def __init__(self, name: str, apply, success: bool = True, error: str | None = None):
        self.name = name
        self.description = name
        self.parameters: dict[str, Any] = {"type": "object", "properties": {}}
        self._apply = apply
        self._success = success
        self._error = error

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        self._apply(ctx.state)
        return ToolResult(success=self._success, summary=self.name, error=self._error)


def _registry(direct_ok: bool = True, verify_ok: bool = True) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_FakeTool("solve_problem", lambda s: s.update({
        "solution_answer": "26",
        "solution_steps": [{"description": "周长", "operation": "(8+5)*2", "result": "26"}],
    })))
    registry.register(_FakeTool(
        "verify_solution",
        lambda s: s.update({"solution_verified": verify_ok}),
        success=verify_ok,
        error=None if verify_ok else "math veto",
    ))
    registry.register(_FakeTool(
        "direct_video",
        (lambda s: s.update({"visual_plan": {
            "visual_thesis": "周长是四条边的总长",
            "visual_objects": [{"id": "rect", "primitive": "rectangle", "params": {"width": 8, "height": 5}}],
            "scenes": [{"role": "setup", "actions": [], "teaching_line": "看这个长方形"}],
            "grounding_source": "verified_solution_arithmetic",
        }})) if direct_ok else (lambda s: None),
        success=direct_ok,
        error=None if direct_ok else "no plan",
    ))
    return registry


def _client(registry: ToolRegistry) -> TestClient:
    app.dependency_overrides[get_tool_registry] = lambda: registry
    return TestClient(app)


def teardown_function() -> None:
    app.dependency_overrides.pop(get_tool_registry, None)


def test_plan_returns_scene_spec_without_compile() -> None:
    client = _client(_registry())
    resp = client.post("/api/v1/plan", json={"problem": "长8宽5周长?", "grade": "elementary_upper"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["plan_id"].startswith("plan-")
    assert body["scene_spec"]["visual_thesis"]
    assert body["scene_spec"]["visual_objects"][0]["primitive"] == "rectangle"
    assert body["solution_answer"] == "26"
    assert body["solution_steps"][0]["result"] == "26"


def test_plan_survives_verify_failure() -> None:
    client = _client(_registry(verify_ok=False))
    resp = client.post("/api/v1/plan", json={"problem": "x", "grade": "elementary_upper"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"  # verify 否决不阻断讲解


def test_plan_fails_cleanly_when_direct_fails() -> None:
    client = _client(_registry(direct_ok=False))
    resp = client.post("/api/v1/plan", json={"problem": "x", "grade": "elementary_upper"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert "direct_video" in body["error"]
