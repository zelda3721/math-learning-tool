"""
Execute Node - Run Manim code to generate video
"""
import logging
from typing import Any

from ...manim import ManimExecutor

logger = logging.getLogger(__name__)


async def execute_node(state: dict[str, Any], executor: ManimExecutor) -> dict[str, Any]:
    """
    Execute Manim code and generate video.
    """
    manim_code = state.get("manim_code", "")
    
    if not manim_code:
        return {
            "video_path": None,
            "error_message": "No Manim code to execute",
            "error_type": "structure",
        }
    
    logger.info("Executing Manim code...")
    
    result = executor.execute_code(manim_code)
    
    if result.success:
        logger.info(f"Video generated: {result.video_path}")
        return {
            "video_path": result.video_path,
            "error_message": "",
            "error_type": "none",
            "status": "success",
        }
    else:
        error_type = _classify_error(result.error_message)
        logger.warning(f"Execution failed ({error_type}): {result.error_message[:100]}")
        return {
            "video_path": None,
            "error_message": result.error_message,
            "error_type": error_type,
        }


def _classify_error(error: str) -> str:
    """Classify error type for routing"""
    error_lower = error.lower()
    
    if "syntaxerror" in error_lower or "indentationerror" in error_lower:
        return "syntax"
    elif "nameerror" in error_lower or "attributeerror" in error_lower:
        return "runtime"
    elif "scene" in error_lower or "class" in error_lower:
        return "structure"
    else:
        return "runtime"
