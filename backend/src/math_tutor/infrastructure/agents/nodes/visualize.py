"""
Visualize Node - Generate Manim visualization code
"""
import logging
import re
from typing import Any

from ...config import get_settings
from ...application.interfaces import ISkillRepository
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

VISUALIZE_PROMPT = """你是一个Manim可视化专家。请为数学题目生成可视化代码。

要求：
1. 生成完整的Scene类代码
2. 使用图形化展示，不要只有文字
3. 每个步骤都有动画过渡
4. 最后展示答案

输出格式：直接输出完整Python代码，从 from manim import * 开始。"""


async def visualize_node(state: dict[str, Any], model: ChatOpenAI, skill_repo: Any = None) -> dict[str, Any]:
    """
    Generate Manim visualization code.
    Uses Skill System to retrieve code templates and visualization principles.
    """
    problem_text = state.get("problem_text", "")
    problem_type = state.get("problem_type", "complex")
    grade_level = state.get("grade_level", "elementary_upper")
    solution = state.get("solution", {})
    steps = state.get("steps", [])
    answer = state.get("answer", "")
    
    logger.info(f"Generating visualization for: {problem_text[:50]}...")
    
    # Context Engineering: Retrieve relevant skill
    skill_context = ""
    if skill_repo:
        best_skill = skill_repo.find_best_match(problem_text, grade_level)
        
        if best_skill:
            logger.info(f"Matched visualization skill: {best_skill.name}")
            skill_context = f"""
【参考可视化模板：{best_skill.name}】
{best_skill.prompt_template}

### 代码模板（请参考此结构实现，但要适配具体题目数据）
```python
{best_skill.code_template}
```
"""

    # Format steps
    steps_text = "\n".join(
        f"{s.get('step_number', i+1)}. {s.get('description', '')}: {s.get('operation', '')}"
        for i, s in enumerate(steps)
    )
    
    problem_context = f"""
题目：{problem_text}
题型：{problem_type}
年级：{grade_level}

解题步骤：
{steps_text}

答案：{answer}
"""
    
    settings = get_settings()
    
    base_prompt = "你是一个Manim可视化专家。请为数学题目生成可视化代码。"
    
    latex_constraint = ""
    if not settings.manim_use_latex:
        latex_constraint = """
重要限制（CRITICAL）：
1. 系统【没有安装LaTeX】环境。
2. 严禁使用 MathTex, Tex, Matrix 等需要LaTeX编译的类。
3. 所有文本必须使用 Text 类。
4. 显示数学公式时，用普通字符串表示，例如 Text("x² + y² = 1")。
"""
    else:
        # If LaTeX is enabled, we still prefer Text for Chinese to avoid font issues
        latex_constraint = """
注意事项： 
1. 中文内容推荐使用 Text(..., font="Microsoft YaHei")。
2. 确实需要优美公式时可以使用 MathTex。
"""

    system_prompt = f"{base_prompt}\n{latex_constraint}"
    
    if skill_context:
        prompt = f"""{system_prompt}

请基于以下参考模板为题目生成代码：
        
{skill_context}

基本要求：
1. 生成完整的Scene类代码 (从 from manim import * 开始)
2. 使用模板中的可视化原则
3. 动态计算和展示题目中的具体数值
4. 确保所有变量在使用前定义
5. 支持中文显示 (font="Microsoft YaHei" 或类似)

输出格式：直接输出完整Python代码。"""
    else:
        # Default prompt if no skill matched
        prompt = f"""{system_prompt}

要求：
1. 生成完整的Scene类代码
2. 使用图形化展示，不要只有文字
3. 每个步骤都有动画过渡
4. 最后展示答案
5. 所有文本使用 Text 类，font="Microsoft YaHei"

输出格式：直接输出完整Python代码，从 from manim import * 开始。"""
        
    try:
        response = await model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=problem_context),
        ])
        
        code = _extract_code(response.content)
        code = _sanitize_code(code)
        
        return {
            "manim_code": code,
        }
    except Exception as e:
        logger.error(f"Visualization failed: {e}")
        return {
            "manim_code": _fallback_code(problem_text, answer),
            "error_type": "structure",
            "error_message": str(e)
        }


def _extract_code(content: str) -> str:
    """Extract Python code from response"""
    # Look for code blocks
    match = re.search(r"```python\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    match = re.search(r"```\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    return content.strip()


def _sanitize_code(code: str) -> str:
    """Fix common LLM hallucinations"""
    # Remove invalid rate_func
    code = re.sub(r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)", "", code)
    
    # Replace invalid colors
    for color in ["ORANGE_E", "BLUE_D", "BLUE_E", "RED_A", "GREEN_E", "GREEN_D", "YELLOW_E"]:
        code = re.sub(rf"\b{color}\b", "BLUE", code)
    
    return code


def _fallback_code(problem: str, answer: str) -> str:
    """Generate simple fallback visualization"""
    return f'''from manim import *

class MathVisualization(Scene):
    def construct(self):
        title = Text("数学题目", font_size=36)
        title.to_edge(UP)
        self.play(Write(title))
        
        problem_text = Text("{problem[:30]}...", font_size=24)
        problem_text.move_to(ORIGIN)
        self.play(Write(problem_text))
        self.wait(2)
        
        answer_text = Text("答案: {answer}", font_size=32, color=GREEN)
        answer_text.to_edge(DOWN)
        self.play(Write(answer_text))
        self.wait(2)
'''
