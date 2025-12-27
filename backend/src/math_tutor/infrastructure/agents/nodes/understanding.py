"""
Understanding Node - Deep analysis for complex problems
"""
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

UNDERSTANDING_PROMPT = """你是一个数学题目分析专家。请深度分析题目，提取：

1. 涉及的数学概念
2. 已知条件
3. 求解目标
4. 关键数值
5. 推荐解题策略

以JSON格式输出：
{
  "concepts": ["概念1", "概念2"],
  "known_conditions": ["条件1", "条件2"],
  "question": "求解目标",
  "key_values": {"名称": 数值},
  "strategy": "推荐策略"
}"""


async def understanding_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Deep analysis for complex problems.
    
    This node is only called for complex problems that need
    detailed understanding before solving.
    """
    problem_text = state["problem_text"]
    
    logger.info(f"Understanding: {problem_text[:50]}...")
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=UNDERSTANDING_PROMPT),
            HumanMessage(content=f"题目：{problem_text}"),
        ])
        
        analysis = _parse_json(response.content)
        
        return {
            "analysis": analysis,
            "concepts": analysis.get("concepts", []),
            "known_conditions": analysis.get("known_conditions", []),
            "question": analysis.get("question", ""),
        }
    except Exception as e:
        logger.error(f"Understanding failed: {e}")
        return {
            "analysis": {},
            "concepts": [],
            "known_conditions": [],
            "question": "",
        }


def _parse_json(content: str) -> dict[str, Any]:
    """Parse JSON from LLM response"""
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {}
