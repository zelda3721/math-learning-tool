"""
LangGraph Workflow Engine

Builds and compiles the StateGraph for the math tutor agent workflow.
"""
import logging
from typing import Any, Literal

from langgraph.graph import StateGraph, END
from langchain_openai import ChatOpenAI

from .nodes import (
    classifier_node,
    understanding_node,
    solving_node,
    solve_simple_node,
    validator_node,
    visualize_node,
    execute_node,
    debug_node,
    fallback_node,
)
from ..manim import ManimExecutor
from ...domain.value_objects import EducationLevel
from ...config import get_settings

logger = logging.getLogger(__name__)


# State type definition
class WorkflowState(dict):
    """Workflow state dictionary with type hints"""
    problem_text: str
    grade_level: str
    problem_type: Literal["simple", "complex", "geometry", "word"]
    problem_difficulty: Literal["easy", "medium", "hard"]
    analysis: dict | None
    solution: dict | None
    steps: list[dict]
    answer: str
    is_valid: bool
    validation_errors: list[str]
    solve_attempts: int
    manim_code: str
    video_path: str | None
    error_message: str
    error_type: Literal["syntax", "runtime", "structure", "none"]
    debug_attempts: int
    status: Literal["pending", "success", "failed", "fallback"]
    fallback_content: str | None


def build_workflow(
    model: ChatOpenAI | None = None,
    manim_executor: ManimExecutor | None = None,
) -> StateGraph:
    """
    Build the LangGraph workflow for math problem processing.
    
    The workflow follows this pattern:
    1. Classify problem → route based on complexity
    2. Understand (complex only) → Solve
    3. Validate solution → retry if invalid
    4. Visualize → Execute Manim
    5. Debug on error → Fallback if too many failures
    """
    settings = get_settings()
    
    if model is None:
        model = ChatOpenAI(
            model=settings.llm_model,
            openai_api_base=settings.llm_api_base,
            openai_api_key=settings.llm_api_key,
            temperature=settings.llm_temperature,
        )
    
    if manim_executor is None:
        manim_executor = ManimExecutor()
    
    # Create graph
    workflow = StateGraph(dict)
    
    # Add nodes with bound dependencies
    workflow.add_node("classify", lambda s: _run_async(classifier_node(s, model)))
    workflow.add_node("understand", lambda s: _run_async(understanding_node(s, model)))
    workflow.add_node("solve_simple", lambda s: _run_async(solve_simple_node(s, model)))
    workflow.add_node("solve", lambda s: _run_async(solving_node(s, model)))
    workflow.add_node("validate", lambda s: _run_async(validator_node(s, model)))
    workflow.add_node("visualize", lambda s: _run_async(visualize_node(s, model)))
    workflow.add_node("execute", lambda s: _run_async(execute_node(s, manim_executor)))
    workflow.add_node("debug", lambda s: _run_async(debug_node(s, model)))
    workflow.add_node("fallback", lambda s: _run_async(fallback_node(s)))
    
    # Set entry point
    workflow.set_entry_point("classify")
    
    # Conditional edges
    workflow.add_conditional_edges("classify", _route_after_classify)
    workflow.add_conditional_edges("validate", _route_after_validate)
    workflow.add_conditional_edges("execute", _route_after_execute)
    
    # Regular edges
    workflow.add_edge("understand", "solve")
    workflow.add_edge("solve_simple", "validate")
    workflow.add_edge("solve", "validate")
    workflow.add_edge("visualize", "execute")
    workflow.add_edge("debug", "execute")
    workflow.add_edge("fallback", END)
    
    return workflow


def _run_async(coro):
    """Helper to run async nodes synchronously"""
    import asyncio
    loop = asyncio.get_event_loop()
    if loop.is_running():
        import nest_asyncio
        nest_asyncio.apply()
    return loop.run_until_complete(coro)


def _route_after_classify(state: dict) -> str:
    """Route based on problem classification"""
    problem_type = state.get("problem_type", "complex")
    difficulty = state.get("problem_difficulty", "medium")
    
    if problem_type == "simple" or difficulty == "easy":
        logger.info("Routing to simple solver")
        return "solve_simple"
    
    logger.info("Routing to deep understanding")
    return "understand"


def _route_after_validate(state: dict) -> str:
    """Route based on validation result"""
    is_valid = state.get("is_valid", True)
    solve_attempts = state.get("solve_attempts", 0)
    
    if is_valid:
        return "visualize"
    
    if solve_attempts < 2:
        logger.info("Validation failed, retrying solve")
        return "solve"
    
    logger.warning("Max solve attempts reached, proceeding anyway")
    return "visualize"


def _route_after_execute(state: dict) -> str:
    """Route based on execution result"""
    video_path = state.get("video_path")
    error_type = state.get("error_type", "none")
    debug_attempts = state.get("debug_attempts", 0)
    
    if video_path:
        return END
    
    if debug_attempts >= 3:
        logger.warning("Max debug attempts reached, falling back")
        return "fallback"
    
    if error_type == "syntax":
        logger.info("Syntax error, attempting debug")
        return "debug"
    
    if error_type == "structure":
        logger.info("Structure error, regenerating visualization")
        return "visualize"
    
    # Runtime error - try debug
    return "debug"


class LangGraphEngine:
    """
    High-level interface for the LangGraph workflow.
    
    Implements ILLMService interface for drop-in replacement.
    """
    
    def __init__(
        self,
        model: ChatOpenAI | None = None,
        manim_executor: ManimExecutor | None = None,
    ):
        self.workflow = build_workflow(model, manim_executor)
        self.app = self.workflow.compile()
    
    async def process_problem(
        self,
        problem_text: str,
        grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER,
    ) -> dict[str, Any]:
        """
        Process a math problem through the full workflow.
        
        Args:
            problem_text: The problem text
            grade: Education level
            
        Returns:
            Result dictionary with all outputs
        """
        initial_state = {
            "problem_text": problem_text,
            "grade_level": grade.value,
            "problem_type": "complex",
            "problem_difficulty": "medium",
            "analysis": None,
            "solution": None,
            "steps": [],
            "answer": "",
            "is_valid": False,
            "validation_errors": [],
            "solve_attempts": 0,
            "manim_code": "",
            "video_path": None,
            "error_message": "",
            "error_type": "none",
            "debug_attempts": 0,
            "status": "pending",
            "fallback_content": None,
        }
        
        logger.info(f"Processing problem: {problem_text[:50]}...")
        
        # Run the workflow
        final_state = self.app.invoke(initial_state)
        
        return {
            "status": final_state.get("status", "failed"),
            "problem": problem_text,
            "grade": grade.value,
            "analysis": final_state.get("analysis"),
            "solution": final_state.get("solution"),
            "visualization_code": final_state.get("manim_code"),
            "video_path": final_state.get("video_path"),
            "error": final_state.get("error_message") if final_state.get("status") == "failed" else None,
            "fallback_content": final_state.get("fallback_content"),
        }
