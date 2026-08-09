"""
GET /api/v1/contract — engine contract endpoint.

Shape must match packages/schema/src/contract.ts (EngineContractSchema):
    { contract_version, tools: [{name, label_zh, stage, palette}],
      event_types, artifact_url_base }
Tool names must come from the production registry factory
(build_default_registry), not a hand-written list.
"""
import pytest
from fastapi.testclient import TestClient

from math_tutor.api.main import app
from math_tutor.api.routes.contract import EVENT_TYPES, build_contract
from math_tutor.config.dependencies import get_tool_registry
from math_tutor.infrastructure.agent import PromptLibrary
from math_tutor.infrastructure.agent.tools import build_default_registry


class _StubLLM:
    """Tools only store the provider at construction time."""


class _StubVideoGenerator:
    pass


def _production_registry():
    return build_default_registry(
        llm=_StubLLM(),
        fast_llm=_StubLLM(),
        vision_llm=_StubLLM(),
        vision_model="stub-vl",
        video_generator=_StubVideoGenerator(),
        use_latex=False,
        prompts=PromptLibrary(),
        narration=None,
        subtitles_enabled=True,
    )


@pytest.fixture
def client():
    registry = _production_registry()
    app.dependency_overrides[get_tool_registry] = lambda: registry
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


class TestContractEndpoint:
    def test_top_level_shape(self, client):
        resp = client.get("/api/v1/contract")
        assert resp.status_code == 200
        data = resp.json()
        assert set(data.keys()) >= {
            "contract_version",
            "tools",
            "event_types",
            "artifact_url_base",
        }
        assert data["contract_version"] == "open_world_v4"
        assert data["artifact_url_base"] == "/api/v1/media"

    def test_tools_cover_the_five_production_tools(self, client):
        data = client.get("/api/v1/contract").json()
        tools = data["tools"]
        assert len(tools) == 5
        # Names are derived from the registry — verify exact set and that
        # every entry carries the full display metadata for the TS schema.
        assert {t["name"] for t in tools} == {
            "solve_problem",
            "verify_solution",
            "direct_video",
            "compile_video",
            "watch_video",
        }
        for t in tools:
            assert set(t.keys()) == {"name", "label_zh", "stage", "palette"}
            assert t["label_zh"], f"empty label_zh for {t['name']}"
            assert t["stage"], f"empty stage for {t['name']}"
            assert t["palette"], f"empty palette for {t['name']}"

    def test_tool_names_track_registry_not_a_second_list(self):
        registry = _production_registry()
        contract = build_contract(registry)
        assert [t["name"] for t in contract["tools"]] == registry.names()

    def test_event_types_match_the_seven_agent_events(self, client):
        data = client.get("/api/v1/contract").json()
        # 7 events in infrastructure/agent/events.py, in SSE wire naming
        # (chat.py): SessionCreated/TextChunk/ReasoningChunk/ToolCallStart/
        # ToolCallResult/DoneEvent/ErrorEvent.
        assert data["event_types"] == list(EVENT_TYPES)
        assert len(data["event_types"]) == 7
        assert set(data["event_types"]) == {
            "session",
            "text",
            "reasoning",
            "tool_call",
            "tool_result",
            "done",
            "error",
        }
