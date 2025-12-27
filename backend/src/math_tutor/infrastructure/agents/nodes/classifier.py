"""
Classifier Node - Determines problem type and complexity

This is the entry point of the graph that routes problems
to appropriate processing paths.
"""
import re
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

CLASSIFIER_PROMPT = """你是一个数学题目分类专家。请分析题目并判断：

1. 题目类型 (problem_type):
   - simple: 简单的一步计算（如 2+3=?）
   - complex: 多步骤运算题
   - geometry: 几何图形题
   - word: 复杂应用题

2. 难度 (difficulty):
   - easy: 一步即可解决
   - medium: 需要2-3步
   - hard: 需要多步推理

请以JSON格式输出：
{"problem_type": "...", "difficulty": "..."}

只输出JSON，不要其他内容。"""


async def classifier_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Classify the problem type and difficulty.
    
    Returns:
        Updated state with problem_type and problem_difficulty
    """
    problem_text = state.get("problem_text", "")
    
    # Quick heuristics for obvious cases
    if _is_simple_arithmetic(problem_text):
        logger.info("Classified as simple (heuristic)")
        return {
            "problem_type": "simple",
            "problem_difficulty": "easy",
        }
    
    if _is_geometry(problem_text):
        logger.info("Classified as geometry (heuristic)")
        return {
            "problem_type": "geometry",
            "problem_difficulty": "medium",
        }
    
    # Use LLM for complex classification
    try:
        response = await model.ainvoke([
            SystemMessage(content=CLASSIFIER_PROMPT),
            HumanMessage(content=f"题目：{problem_text}"),
        ])
        
        result = _parse_json(response.content)
        logger.info(f"Classified as {result}")
        
        return {
            "problem_type": result.get("problem_type", "complex"),
            "problem_difficulty": result.get("difficulty", "medium"),
        }
    except Exception as e:
        logger.warning(f"Classification failed: {e}, defaulting to complex")
        return {
            "problem_type": "complex",
            "problem_difficulty": "medium",
        }


def _is_simple_arithmetic(text: str) -> bool:
    """Check if problem is simple arithmetic"""
    # Pattern: "X + Y = ?" or similar
    simple_patterns = [
        r"^\s*\d+\s*[\+\-\×\÷\*\/]\s*\d+\s*=\s*\??\s*$",
        r"^计算[：:]\s*\d+\s*[\+\-\×\÷\*\/]\s*\d+",
    ]
    return any(re.match(p, text) for p in simple_patterns)


def _is_geometry(text: str) -> bool:
    """Check if problem involves geometry"""
    geometry_keywords = ["面积", "周长", "三角形", "矩形", "圆", "正方形", "长方形", "图形"]
    return any(kw in text for kw in geometry_keywords)


def _parse_json(content: str) -> dict[str, Any]:
    """Parse JSON from LLM response"""
    import json
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {}
