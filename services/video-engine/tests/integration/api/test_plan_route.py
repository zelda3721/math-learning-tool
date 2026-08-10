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


# ── route 开关：谁来设计画面 ────────────────────────────────────────────

_HTML = (
    '<article data-explain="1">'
    '<section data-beat="0" data-teach="长 8 宽 5">'
    '<div data-claim="sides=4">'
    '<span data-unit="side"></span><span data-unit="side"></span>'
    '<span data-unit="side"></span><span data-unit="side"></span></div></section>'
    '<section data-beat="1" data-teach="周长 26">'
    '<div data-measure="perimeter=26"></div></section>'
    "</article>"
)


class _FakeHtmlTool:
    """内部注册的 generate_web_explanation 替身。"""

    name = "generate_web_explanation"
    description = name
    parameters: dict[str, Any] = {"type": "object", "properties": {}}

    def __init__(self, *, success: bool = True) -> None:
        self._success = success
        self.calls = 0

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        self.calls += 1
        gate = {"ok": self._success, "errors": [] if self._success else ["答案不许画错"], "warnings": []}
        return ToolResult(
            success=self._success,
            summary="web 讲解",
            data={"html": _HTML, "gate": gate},
            error=None if self._success else "web_explanation_contract_violation",
        )


def _registry_with_html(html_tool: _FakeHtmlTool, direct_ok: bool = True) -> ToolRegistry:
    registry = _registry(direct_ok=direct_ok)
    registry.register_internal(html_tool)
    return registry


def _client_with_data_dir(registry: ToolRegistry, data_dir) -> TestClient:
    """settings 带缓存，改环境变量没用——直接覆盖依赖，把数据集写进临时目录。"""
    from math_tutor.config.dependencies import get_settings

    real = get_settings()
    patched = real.model_copy(update={"data_dir": str(data_dir)})
    app.dependency_overrides[get_tool_registry] = lambda: registry
    app.dependency_overrides[get_settings] = lambda: patched
    return TestClient(app)


def test_缺省仍走_SceneSpec_不惊动模型写码(tmp_path):
    html_tool = _FakeHtmlTool()
    client = _client_with_data_dir(_registry_with_html(html_tool), tmp_path)
    try:
        body = client.post("/api/v1/plan", json={"problem": "长8宽5周长?"}).json()
    finally:
        app.dependency_overrides.clear()
    assert body["status"] == "ok"
    assert body["scene_spec"]["grounding_source"] == "verified_solution_arithmetic"
    assert body["html"] is None
    assert html_tool.calls == 0


def test_route_html_让模型写页面并回传门禁判定(tmp_path):
    html_tool = _FakeHtmlTool()
    client = _client_with_data_dir(_registry_with_html(html_tool), tmp_path)
    try:
        body = client.post(
            "/api/v1/plan", json={"problem": "长8宽5周长?", "route": "html"}
        ).json()
    finally:
        app.dependency_overrides.clear()
    assert body["status"] == "ok"
    assert body["html"] == _HTML
    assert body["html_gate"]["ok"] is True
    assert html_tool.calls == 1
    # html 路线不该顺手跑一遍 direct（省一次生成）
    assert body["scene_spec"] is None


def test_route_both_两条都跑_一条失败不拖垮另一条(tmp_path):
    html_tool = _FakeHtmlTool(success=False)
    client = _client_with_data_dir(_registry_with_html(html_tool), tmp_path)
    try:
        body = client.post(
            "/api/v1/plan", json={"problem": "长8宽5周长?", "route": "both"}
        ).json()
    finally:
        app.dependency_overrides.clear()
    # 攒对比数据时，一条路挂掉不该让整次请求失败
    assert body["status"] == "ok"
    assert body["scene_spec"] is not None
    assert body["html"] is None
    assert body["html_gate"]["ok"] is False
    assert html_tool.calls == 1


def test_每次生成都往数据集追加一行(tmp_path):
    from math_tutor.infrastructure.agent.generation_dataset import read_records, summarize

    client = _client_with_data_dir(_registry_with_html(_FakeHtmlTool()), tmp_path)
    try:
        client.post("/api/v1/plan", json={"problem": "长8宽5周长?", "route": "both"})
    finally:
        app.dependency_overrides.clear()

    rows = list(read_records(tmp_path))
    assert len(rows) == 2
    routes = {r["route"] for r in rows}
    assert routes == {"deterministic", "llm_html"}
    for row in rows:
        # 训练要用的：题干、地面真值、产物、判定，一个都不能缺
        assert row["problem"] == "长8宽5周长?"
        assert row["artifact"]
        assert "ok" in row["gate"]
    assert summarize(tmp_path)["total"] == 2
