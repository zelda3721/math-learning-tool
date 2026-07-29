"""
Integration tests for API routes
"""
import pytest
from fastapi.testclient import TestClient

from math_tutor.api.main import app
from math_tutor.config.dependencies import get_agent_loop
from math_tutor.infrastructure.agent.events import DoneEvent, SessionCreated


class _DeterministicFakeLoop:
    async def run(self, **kwargs):
        yield SessionCreated(session_id="integration-session")
        yield DoneEvent(status="ok", text="verified", final_video_path=None)


@pytest.fixture
def client():
    """FastAPI test client"""
    app.dependency_overrides[get_agent_loop] = lambda: _DeterministicFakeLoop()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


class TestHealthEndpoint:
    """Tests for health check endpoint"""
    
    def test_health_check(self, client):
        response = client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"


class TestGradesEndpoint:
    """Tests for grades endpoint"""
    
    def test_list_grades(self, client):
        response = client.get("/api/v1/grades")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 5  # 5 education levels
    
    def test_get_grade_detail(self, client):
        response = client.get("/api/v1/grades/elementary_upper")
        assert response.status_code == 200
        data = response.json()
        assert data["level"] == "elementary_upper"


class TestProblemsEndpoint:
    """Tests for problems endpoint"""
    
    def test_process_problem_requires_body(self, client):
        response = client.post("/api/v1/problems/process")
        assert response.status_code == 422  # Validation error
    
    def test_process_problem_with_body(self, client):
        response = client.post(
            "/api/v1/problems/process",
            json={"problem": "2+3=?", "grade": "elementary_upper"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["problem"] == "2+3=?"
