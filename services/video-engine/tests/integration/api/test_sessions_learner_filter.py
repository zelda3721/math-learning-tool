"""
GET /api/v1/sessions — ?learner_id= filtering and response field pass-through.
"""
import pytest
from fastapi.testclient import TestClient

from math_tutor.api.main import app
from math_tutor.config.dependencies import get_conversation_store
from math_tutor.infrastructure.storage.conversation_store import ConversationStore
from math_tutor.infrastructure.storage.database import Database
from math_tutor.infrastructure.storage.file_archive import FileArchive


@pytest.fixture
def client(tmp_path):
    store = ConversationStore(
        Database(tmp_path / "test.sqlite"), FileArchive(tmp_path / "data")
    )
    app.dependency_overrides[get_conversation_store] = lambda: store
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


async def _seed(client) -> dict[str, str]:
    store = app.dependency_overrides[get_conversation_store]()
    return {
        "alice": await store.create_session("p1", "elementary_upper", learner_id="alice"),
        "bob": await store.create_session("p2", "elementary_upper", learner_id="bob"),
        "anon": await store.create_session("p3", "elementary_upper"),
    }


class TestSessionsLearnerFilter:
    async def test_filter_by_learner_id(self, client):
        ids = await _seed(client)
        resp = client.get("/api/v1/sessions", params={"learner_id": "alice"})
        assert resp.status_code == 200
        rows = resp.json()
        assert [r["id"] for r in rows] == [ids["alice"]]
        assert rows[0]["learner_id"] == "alice"

    async def test_unfiltered_list_includes_learner_id_field(self, client):
        await _seed(client)
        rows = client.get("/api/v1/sessions").json()
        assert len(rows) == 3
        assert all("learner_id" in r for r in rows)
        assert {r["learner_id"] for r in rows} == {"alice", "bob", None}

    async def test_unknown_learner_returns_empty(self, client):
        await _seed(client)
        rows = client.get("/api/v1/sessions", params={"learner_id": "nobody"}).json()
        assert rows == []
