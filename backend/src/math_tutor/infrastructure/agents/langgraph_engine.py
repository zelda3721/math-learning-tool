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


# State type definition using TypedDict for proper LangGraph state merging
from typing import TypedDict, Annotated
from operator import add


def _replace_reducer(current, update):
    """Simple reducer that replaces old value with new value"""
    return update if update is not None else current


class WorkflowState(TypedDict, total=False):
    """
    Workflow state with proper type hints.
    All fields are optional to allow partial updates.
    """
    problem_text: str
    grade_level: str
    problem_type: str  # "simple", "complex", "geometry", "word"
    problem_difficulty: str  # "easy", "medium", "hard"
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
    error_type: str  # "syntax", "runtime", "structure", "none"
    debug_attempts: int
    status: str  # "pending", "success", "failed", "fallback"
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
    
    # Create graph with typed state schema
    workflow = StateGraph(WorkflowState)
    
    # Add nodes - use sync wrapper functions
    workflow.add_node("classify", lambda s: _sync_classifier(s, model))
    workflow.add_node("understand", lambda s: _sync_understanding(s, model))
    workflow.add_node("solve_simple", lambda s: _sync_solve_simple(s, model))
    workflow.add_node("solve", lambda s: _sync_solving(s, model))
    workflow.add_node("validate", lambda s: _sync_validator(s, model))
    workflow.add_node("visualize", lambda s: _sync_visualize(s, model))
    workflow.add_node("execute", lambda s: _sync_execute(s, manim_executor))
    workflow.add_node("debug", lambda s: _sync_debug(s, model))
    workflow.add_node("fallback", lambda s: _sync_fallback(s))
    
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
# ============================================================
# Synchronous Wrapper Functions for LangGraph Nodes
# These wrap the async node functions using thread-based execution
# to avoid uvloop compatibility issues
# ============================================================

import concurrent.futures
import functools

def _run_in_thread(async_func, timeout_seconds: int = 60):
    """Run an async function in a separate thread with its own event loop"""
    import asyncio
    
    def run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(async_func)
        finally:
            loop.close()
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run)
        return future.result(timeout=timeout_seconds)  # Configurable timeout


def _sync_classifier(state: dict, model) -> dict:
    """Sync wrapper for classifier_node"""
    try:
        return _run_in_thread(classifier_node(state, model))
    except Exception as e:
        logger.exception(f"Classifier failed: {e}")
        return {"problem_type": "complex", "problem_difficulty": "medium"}


def _sync_understanding(state: dict, model) -> dict:
    """Sync wrapper for understanding_node"""
    try:
        return _run_in_thread(understanding_node(state, model))
    except Exception as e:
        logger.exception(f"Understanding failed: {e}")
        return {"analysis": None}


def _sync_solve_simple(state: dict, model) -> dict:
    """Sync wrapper for solve_simple_node"""
    try:
        return _run_in_thread(solve_simple_node(state, model))
    except Exception as e:
        logger.exception(f"Solve simple failed: {e}")
        return {"solution": None, "answer": ""}


def _sync_solving(state: dict, model) -> dict:
    """Sync wrapper for solving_node"""
    try:
        result = _run_in_thread(solving_node(state, model))
        result["solve_attempts"] = state.get("solve_attempts", 0) + 1
        return result
    except Exception as e:
        logger.exception(f"Solving failed: {e}")
        return {"solution": None, "answer": "", "solve_attempts": state.get("solve_attempts", 0) + 1}


def _sync_validator(state: dict, model) -> dict:
    """Sync wrapper for validator_node"""
    try:
        return _run_in_thread(validator_node(state, model))
    except Exception as e:
        logger.exception(f"Validator failed: {e}")
        return {"is_valid": True}  # Skip validation on error


def _sync_visualize(state: dict, model) -> dict:
    """Sync wrapper for visualize_node"""
    try:
        return _run_in_thread(visualize_node(state, model))
    except Exception as e:
        logger.exception(f"Visualize failed: {e}")
        return {"manim_code": ""}


def _sync_execute(state: dict, manim_executor) -> dict:
    """Sync wrapper for execute_node"""
    try:
        return _run_in_thread(execute_node(state, manim_executor))
    except Exception as e:
        logger.exception(f"Execute failed: {e}")
        return {"video_path": None, "error_message": str(e), "error_type": "runtime", "debug_attempts": state.get("debug_attempts", 0) + 1}


def _sync_debug(state: dict, model) -> dict:
    """Sync wrapper for debug_node"""
    try:
        result = _run_in_thread(debug_node(state, model))
        result["debug_attempts"] = state.get("debug_attempts", 0) + 1
        return result
    except Exception as e:
        logger.exception(f"Debug failed: {e}")
        return {"manim_code": state.get("manim_code", ""), "debug_attempts": state.get("debug_attempts", 0) + 1}


def _sync_fallback(state: dict) -> dict:
    """Sync wrapper for fallback_node"""
    try:
        return _run_in_thread(fallback_node(state))
    except Exception as e:
        logger.exception(f"Fallback failed: {e}")
        return {"status": "fallback", "fallback_content": "无法生成可视化，请查看文字解答。"}


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
    
    # Check total attempts (debug + visualize) to prevent infinite loops
    if debug_attempts >= 3:
        logger.warning("Max debug attempts reached, falling back")
        return "fallback"
    
    if error_type == "syntax":
        logger.info("Syntax error, attempting debug")
        return "debug"
    
    if error_type == "structure":
        # Structure errors go back to debug, not visualize (to prevent infinite loop)
        logger.info("Structure error, attempting debug")
        return "debug"
    
    # Runtime error - try debug
    return "debug"
    
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
        
        try:
            # Run the workflow
            final_state = self.app.invoke(initial_state)
            logger.info(f"Workflow completed with status: {final_state.get('status')}")
        except Exception as e:
            logger.exception(f"Workflow failed with exception: {e}")
            return {
                "status": "failed",
                "problem": problem_text,
                "grade": grade.value,
                "analysis": None,
                "solution": None,
                "visualization_code": None,
                "video_path": None,
                "error": str(e),
                "fallback_content": None,
            }
        
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
