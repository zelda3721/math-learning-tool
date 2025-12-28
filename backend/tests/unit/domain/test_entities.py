"""
Unit tests for domain entities
"""
import pytest
from math_tutor.domain.entities import Problem, Solution, SolutionStep, Skill
from math_tutor.domain.value_objects import EducationLevel


class TestProblem:
    """Tests for Problem entity"""
    
    def test_create_problem(self):
        problem = Problem(text="2 + 3 = ?")
        assert problem.text == "2 + 3 = ?"
        assert problem.grade_level == EducationLevel.ELEMENTARY_UPPER
        assert not problem.is_analyzed
    
    def test_problem_with_grade(self):
        problem = Problem(
            text="求导 f(x) = x²",
            grade_level=EducationLevel.UNIVERSITY,
        )
        assert problem.grade_level == EducationLevel.UNIVERSITY
    
    def test_problem_is_analyzed(self):
        problem = Problem(text="test")
        assert not problem.is_analyzed
        
        problem.problem_type = "加法"
        assert problem.is_analyzed


class TestSolution:
    """Tests for Solution entity"""
    
    def test_create_solution(self):
        solution = Solution(strategy="直接计算")
        assert solution.strategy == "直接计算"
        assert solution.steps == []
        assert not solution.is_solved
    
    def test_solution_with_steps(self):
        steps = [
            SolutionStep(step_number=1, description="加法", operation="2+3=5"),
        ]
        solution = Solution(strategy="直接计算", steps=steps, answer="5")
        assert len(solution.steps) == 1
        assert solution.is_solved


class TestSkill:
    """Tests for Skill entity"""
    
    def test_create_skill(self):
        skill = Skill(name="addition", description="加法技能")
        assert skill.name == "addition"
        assert skill.category == "visualization"
    
    def test_skill_matches_grade(self):
        skill = Skill(
            name="calculus",
            description="微积分",
            grade_levels=[EducationLevel.UNIVERSITY],
        )
        assert skill.matches_grade(EducationLevel.UNIVERSITY)
        assert not skill.matches_grade(EducationLevel.ELEMENTARY_UPPER)
    
    def test_skill_matches_all_grades_when_empty(self):
        skill = Skill(name="basic", description="基础", grade_levels=[])
        assert skill.matches_grade(EducationLevel.ELEMENTARY_LOWER)
        assert skill.matches_grade(EducationLevel.UNIVERSITY)
