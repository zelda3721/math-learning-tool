"""
Solving Node - Generate solution steps
"""
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

SOLVING_PROMPT = """你是一个数学解题专家。请根据题目和分析结果，给出详细的解题步骤。

输出JSON格式：
{
  "strategy": "解题策略",
  "steps": [
    {"step_number": 1, "description": "步骤描述", "operation": "运算式", "result": "结果"},
    ...
  ],
  "answer": "最终答案",
  "key_points": ["要点1", "要点2"]
}"""

SIMPLE_SOLVING_PROMPT = """你是一个数学解题专家。这是一道简单题目，请直接给出解答。

输出JSON格式：
{
  "strategy": "直接计算",
  "steps": [{"step_number": 1, "description": "计算", "operation": "运算式", "result": "结果"}],
  "answer": "答案"
}"""


async def solving_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Solve complex problems with detailed steps.
    """
    problem_text = state["problem_text"]
    analysis = state.get("analysis", {})
    solve_attempts = state.get("solve_attempts", 0)
    
    logger.info(f"Solving (attempt {solve_attempts + 1}): {problem_text[:50]}...")
    
    context = f"题目：{problem_text}"
    if analysis:
        context += f"\n\n分析结果：{json.dumps(analysis, ensure_ascii=False)}"
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=SOLVING_PROMPT),
            HumanMessage(content=context),
        ])
        
        solution = _parse_json(response.content)
        
        return {
            "solution": solution,
            "steps": solution.get("steps", []),
            "answer": solution.get("answer", ""),
            "solve_attempts": solve_attempts + 1,
        }
    except Exception as e:
        logger.error(f"Solving failed: {e}")
        return {
            "solution": {},
            "steps": [],
            "answer": "",
            "solve_attempts": solve_attempts + 1,
        }


async def solve_simple_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Solve simple problems directly without deep analysis.
    """
    problem_text = state["problem_text"]
    
    logger.info(f"Simple solving: {problem_text[:50]}...")
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=SIMPLE_SOLVING_PROMPT),
            HumanMessage(content=f"题目：{problem_text}"),
        ])
        
        solution = _parse_json(response.content)
        
        return {
            "solution": solution,
            "steps": solution.get("steps", []),
            "answer": solution.get("answer", ""),
            "solve_attempts": 1,
        }
    except Exception as e:
        logger.error(f"Simple solving failed: {e}")
        return {
            "solution": {},
            "steps": [],
            "answer": "",
            "solve_attempts": 1,
        }


def _parse_json(content: str) -> dict[str, Any]:
    """Parse JSON from LLM response"""
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {}
