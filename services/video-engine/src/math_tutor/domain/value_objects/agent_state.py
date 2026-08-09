"""
Agent State - Shared state for LangGraph workflow

This defines the state that flows through all agent nodes in the graph.
"""
from typing import Annotated, Any, Literal
from operator import add
from dataclasses import dataclass, field

from pydantic import BaseModel

from .grade import EducationLevel


class AgentState(BaseModel):
    """
    Shared state for the LangGraph agent workflow.
    
    This state is passed through all nodes and accumulates results
    from each step in the pipeline.
    """
    
    # ==================== Input ====================
    problem_text: str
    grade_level: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    
    # ==================== Classification ====================
    problem_type: Literal["simple", "complex", "geometry", "word"] = "complex"
    problem_difficulty: Literal["easy", "medium", "hard"] = "medium"
    
    # ==================== Analysis ====================
    analysis: dict[str, Any] | None = None
    concepts: list[str] = field(default_factory=list)
    known_conditions: list[str] = field(default_factory=list)
    question: str = ""
    
    # ==================== Solution ====================
    solution: dict[str, Any] | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    answer: str = ""
    is_valid: bool = False
    validation_errors: list[str] = field(default_factory=list)
    solve_attempts: int = 0
    
    # ==================== Visualization ====================
    manim_code: str = ""
    skill_used: str | None = None
    
    # ==================== Execution ====================
    video_path: str | None = None
    error_message: str = ""
    error_type: Literal["syntax", "runtime", "structure", "none"] = "none"
    debug_attempts: int = 0
    
    # ==================== Final Output ====================
    status: Literal["pending", "success", "failed", "fallback"] = "pending"
    fallback_content: str | None = None
    
    model_config = {"arbitrary_types_allowed": True}
    
    def is_simple_problem(self) -> bool:
        """Check if problem should skip deep analysis"""
        return self.problem_type == "simple" or self.problem_difficulty == "easy"
    
    def should_retry_solve(self) -> bool:
        """Check if we should retry solving"""
        return not self.is_valid and self.solve_attempts < 2
    
    def should_retry_debug(self) -> bool:
        """Check if we should retry debugging"""
        return self.debug_attempts < 3 and self.error_type == "syntax"
    
    def to_result_dict(self) -> dict[str, Any]:
        """Convert to result dictionary for API response"""
        return {
            "status": self.status,
            "problem": self.problem_text,
            "grade": self.grade_level.value,
            "analysis": self.analysis,
            "solution": self.solution,
            "visualization_code": self.manim_code,
            "video_path": self.video_path,
            "error": self.error_message if self.status == "failed" else None,
            "fallback_content": self.fallback_content,
        }
