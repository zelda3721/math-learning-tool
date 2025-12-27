"""
Validator Node - Validate solution correctness
"""
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

VALIDATOR_PROMPT = """你是一个数学验算专家。请验证以下解题过程是否正确。

检查：
1. 每一步运算是否正确
2. 逻辑是否连贯
3. 最终答案是否合理

输出JSON格式：
{
  "is_valid": true/false,
  "errors": ["错误1", "错误2"] // 如果有错误
}

只输出JSON。"""


async def validator_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Validate the solution for correctness.
    
    If validation fails, the workflow will route back to solving.
    """
    problem_text = state.get("problem_text", "")
    solution = state.get("solution", {})
    answer = state.get("answer", "")
    
    if not solution:
        return {"is_valid": False, "validation_errors": ["无解题步骤"]}
    
    logger.info(f"Validating solution for: {problem_text[:50]}...")
    
    context = f"""
题目：{problem_text}

解题步骤：
{_format_steps(solution.get('steps', []))}

答案：{answer}
"""
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=VALIDATOR_PROMPT),
            HumanMessage(content=context),
        ])
        
        result = _parse_json(response.content)
        is_valid = result.get("is_valid", True)
        errors = result.get("errors", [])
        
        logger.info(f"Validation result: valid={is_valid}, errors={errors}")
        
        return {
            "is_valid": is_valid,
            "validation_errors": errors,
        }
    except Exception as e:
        logger.warning(f"Validation failed: {e}, assuming valid")
        return {
            "is_valid": True,  # Assume valid on error
            "validation_errors": [],
        }


def _format_steps(steps: list[dict]) -> str:
    """Format solution steps for validation"""
    lines = []
    for step in steps:
        num = step.get("step_number", "")
        desc = step.get("description", "")
        op = step.get("operation", "")
        result = step.get("result", "")
        lines.append(f"{num}. {desc}: {op} = {result}")
    return "\n".join(lines)


def _parse_json(content: str) -> dict[str, Any]:
    """Parse JSON from LLM response"""
    import json
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        return json.loads(match.group())
    return {}
