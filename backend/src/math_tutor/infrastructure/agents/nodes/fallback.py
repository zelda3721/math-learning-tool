"""
Fallback Node - Graceful degradation when video generation fails
"""
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def fallback_node(state: dict[str, Any]) -> dict[str, Any]:
    """
    Handle fallback when visualization fails.
    
    Provides text-only solution as degraded output.
    """
    problem_text = state.get("problem_text", "")
    solution = state.get("solution", {})
    steps = state.get("steps", [])
    answer = state.get("answer", "")
    
    logger.info("Falling back to text-only output")
    
    # Build text content
    lines = ["## 解题过程\n"]
    
    for step in steps:
        num = step.get("step_number", "")
        desc = step.get("description", "")
        op = step.get("operation", "")
        result = step.get("result", "")
        lines.append(f"**步骤 {num}**: {desc}")
        lines.append(f"   {op} = {result}\n")
    
    lines.append(f"\n**答案**: {answer}")
    
    fallback_content = "\n".join(lines)
    
    return {
        "status": "fallback",
        "fallback_content": fallback_content,
    }
