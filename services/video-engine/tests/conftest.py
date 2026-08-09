"""
Pytest configuration and fixtures
"""
import pytest
from pathlib import Path
import sys

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


@pytest.fixture
def sample_problem_text() -> str:
    """Sample math problem for testing"""
    return "小明有25个糖果，给了小红8个，又给了小刚5个。现在有多少个糖果？"


@pytest.fixture
def sample_analysis() -> dict:
    """Sample analysis result for testing"""
    return {
        "problem_type": "连续减法",
        "concepts": ["减法", "连续运算"],
        "known_conditions": ["最初25个", "给出8个", "给出5个"],
        "question": "现在有多少糖果",
        "key_values": {"initial": 25, "subtract1": 8, "subtract2": 5},
        "difficulty": "简单",
        "strategy": "依次减去",
    }


@pytest.fixture
def sample_solution() -> dict:
    """Sample solution result for testing"""
    return {
        "strategy": "连续减法",
        "steps": [
            {"step_number": 1, "description": "减去给小红的", "operation": "25 - 8 = 17", "result": "17"},
            {"step_number": 2, "description": "减去给小刚的", "operation": "17 - 5 = 12", "result": "12"},
        ],
        "answer": "12个糖果",
        "key_points": ["注意顺序"],
    }
