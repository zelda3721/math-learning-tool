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

def _get_solving_prompt(grade_level: str) -> str:
    """Get grade-appropriate solving prompt"""
    
    # Grade-specific method guidance
    method_guidance = {
        "elementary_lower": """
【解题方法要求 - 小学低年级(1-3年级)】
- 禁止使用: 方程、未知数x/y、代数式
- 推荐方法: 画图法、实物演示、逐步数数、凑十法
- 语言要求: 简单易懂，用"个"、"只"等具象单位
- 举例说明: 用苹果、小动物等生活化例子""",
        
        "elementary_upper": """
【解题方法要求 - 小学高年级(4-6年级)】
- 优先使用: 假设法、列表法、画图分析、逆推法
- 对于"鸡兔同笼"类问题: 必须用"假设法"（假设全是鸡/兔），不要用方程
- 五六年级可选: 简单的设未知数方法
- 语言要求: 清晰的步骤说明，强调数学思维过程""",

        "middle": """
【解题方法要求 - 初中】
- 可使用: 代数方程、函数思想、几何证明
- 推荐: 列方程组解决实际问题
- 强调: 解题思路的完整性和逻辑性""",

        "high": """
【解题方法要求 - 高中】
- 可使用: 高等数学方法、复杂函数、数列、向量
- 强调: 数学建模思想、抽象概括能力""",
    }
    
    guidance = method_guidance.get(grade_level, method_guidance["elementary_upper"])
    
    return f"""你是一个针对{grade_level}学生的数学解题专家。

{guidance}

请根据题目给出详细的解题步骤，输出JSON格式：
{{
  "strategy": "解题策略名称（如：假设法、画图法）",
  "steps": [
    {{"step_number": 1, "description": "步骤描述", "operation": "运算式或推理过程", "result": "结果"}},
    ...
  ],
  "answer": "最终答案（完整句子）",
  "key_points": ["思维要点1", "思维要点2"]
}}"""


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
    problem_text = state.get("problem_text", "")
    analysis = state.get("analysis", {})
    solve_attempts = state.get("solve_attempts", 0)
    grade_level = state.get("grade_level", "elementary_upper")
    
    logger.info(f"Solving (attempt {solve_attempts + 1}): {problem_text[:50]}...")
    
    context = f"题目：{problem_text}"
    if analysis:
        context += f"\n\n分析结果：{json.dumps(analysis, ensure_ascii=False)}"
    
    # Get grade-appropriate prompt
    solving_prompt = _get_solving_prompt(grade_level)
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=solving_prompt),
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
    problem_text = state.get("problem_text", "")
    
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
