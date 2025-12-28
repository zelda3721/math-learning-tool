"""
Integration tests for API routes
"""
import pytest
from fastapi.testclient import TestClient

from math_tutor.api.main import app


@pytest.fixture
def client():
    """FastAPI test client"""
    return TestClient(app)


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
