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
    
    # Common visualization emphasis for ALL grades
    visualization_emphasis = """
【核心要求 - 可视化思维】
- 不要只是罗列解题步骤，要用可视化的方式解释数学原理
- 每个关键步骤都要说明"为什么这样做"，而不只是"怎么做"
- 用图形、表格、类比等方式帮助理解抽象概念
- 强调数学思维过程，让学生"看见"数学的美"""

    # Grade-specific method guidance
    method_guidance = {
        "elementary_lower": """
【小学低年级(1-3年级)】
- 禁止使用: 方程、未知数x/y、代数式
- 推荐方法: 画图法、实物演示、逐步数数、凑十法
- 语言要求: 简单易懂，用"个"、"只"等具象单位
- 可视化: 用苹果、小动物等生活化例子，配合图示说明""",
        
        "elementary_upper": """
【小学高年级(4-6年级)】
- 优先使用: 假设法、列表法、画图分析、逆推法
- 对于"鸡兔同笼"类问题: 必须用"假设法"（假设全是鸡/兔），不要用方程
- 五六年级可选: 简单的设未知数方法
- 可视化: 用表格对比、画图推理、分步图解""",

        "middle": """
【初中】
- 可使用: 代数方程、函数思想、几何证明
- 推荐: 列方程组解决实际问题
- 可视化: 用坐标图、函数图像、几何图形辅助理解""",

        "high": """
【高中】
- 仍以初等数学思想为主，向高等数学思想过渡
- 可使用: 函数与方程、数形结合、分类讨论、化归转化
- 限制: 不要过多使用大学水平的方法（如极限、微积分思想仅作了解）
- 可视化: 用函数图像、向量图示、空间几何模型""",
        
        "advanced": """
【高等数学】
- 面向大学及以上水平
- 可使用: 微积分、线性代数、概率统计等高等数学方法
- 可视化: 用三维图形、动态变化图、数学软件辅助理解""",
    }
    
    guidance = method_guidance.get(grade_level, method_guidance["elementary_upper"])
    
    return f"""你是一个专业的数学老师，面向{grade_level}学生。

{visualization_emphasis}

{guidance}

请根据题目给出详细的解题过程，输出JSON格式：
{{
  "strategy": "解题策略名称（如：假设法、画图法）",
  "steps": [
    {{"step_number": 1, "description": "步骤描述", "operation": "运算式或推理过程", "explanation": "为什么这样做", "result": "结果"}},
    ...
  ],
  "answer": "最终答案（完整句子）",
  "visualization_hint": "给Manim可视化提示：如何用动画展示这个解题过程",
  "key_points": ["数学思维要点1", "数学思维要点2"]
}}"""


SIMPLE_SOLVING_PROMPT = """你是一个数学解题专家。这是一道简单题目，请直接给出解答。

输出JSON格式：
{
  "strategy": "直接计算",
  "steps": [{"step_number": 1, "description": "计算", "operation": "运算式", "result": "结果"}],
  "answer": "答案"
}"""


async def solving_node(state: dict[str, Any], model: ChatOpenAI, skill_repo: Any = None) -> dict[str, Any]:
    """
    Solve complex problems with detailed steps.
    """
    problem_text = state.get("problem_text", "")
    analysis = state.get("analysis", {})
    solve_attempts = state.get("solve_attempts", 0)
    grade_level = state.get("grade_level", "elementary_upper")
    
    logger.info(f"Solving (attempt {solve_attempts + 1}): {problem_text[:50]}...")
    
    # Context retrieval using Skills
    skill_context = ""
    if skill_repo:
        # Try to find a matching skill based on problem text or analysis concepts
        # First try precise matching if analysis has concepts
        best_skill = None
        
        # 1. Search by concepts from analysis (if available)
        if analysis and "concepts" in analysis:
            for concept in analysis["concepts"]:
                skill = skill_repo.find_best_match(concept, grade_level)
                if skill:
                    best_skill = skill
                    break
        
        # 2. Fallback to problem text search
        if not best_skill:
            best_skill = skill_repo.find_best_match(problem_text, grade_level)
            
        if best_skill:
            logger.info(f"Matched skill: {best_skill.name}")
            skill_context = f"""
【参考技能：{best_skill.name}】
{best_skill.description}

关键点：{', '.join(best_skill.keywords)}
"""
    
    context = f"题目：{problem_text}"
    if analysis:
        context += f"\n\n分析结果：{json.dumps(analysis, ensure_ascii=False)}"
    
    if skill_context:
        context += f"\n\n{skill_context}"
    
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
