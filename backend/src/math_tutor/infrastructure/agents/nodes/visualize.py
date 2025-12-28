"""
Visualize Node - Generate Manim visualization code
"""
import logging
import re
from typing import Any

from math_tutor.config import get_settings
from math_tutor.application.interfaces import ISkillRepository
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
    
    # Context Engineering: Retrieve relevant skill using pre-fetched data or repo
    skill_context = state.get("skill_context_str", "")
    skill_name = state.get("skill_name", None)
    
    # Get visualization agent system prompt (defines strict quality requirements)
    agent_system_prompt = ""
    animation_guidelines = ""
    
    if skill_repo:
        # Try to get the visualization agent prompt (core quality requirements)
        agent_system_prompt = skill_repo.get_agent_prompt("visualization") or ""
        # Get animation guidelines (detailed animation standards)
        animation_guidelines = skill_repo.get_animation_guidelines() or ""
        
        if not skill_context:
            best_skill = skill_repo.find_best_match(problem_text, grade_level)
            
            if best_skill:
                skill_name = best_skill.name
                logger.info(f"Matched visualization skill: {best_skill.name}")
                skill_context = f"""
【匹配到专用技能：{best_skill.name}】

{best_skill.prompt_template}

### 代码模板（严格参考此结构和动画效果）
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
# 当前题目
题目：{problem_text}
题型：{problem_type}
年级：{grade_level}

解题步骤：
{steps_text}

答案：{answer}
"""
    
    settings = get_settings()
    
    # Build comprehensive system prompt
    latex_constraint = ""
    if not settings.manim_use_latex:
        latex_constraint = """
## ⚠️ 环境限制
系统【没有安装LaTeX】环境。必须：
- 严禁使用 MathTex, Tex, Matrix 等需要LaTeX编译的类
- 所有文本使用 Text 类
- 公式用普通字符串表示，如 Text("x² + y² = 1")
"""
    else:
        latex_constraint = """
## 环境说明
已安装 LaTeX。可以使用 MathTex 显示公式，但中文推荐使用 Text。
"""

    # Construct the full prompt with all quality guidelines
    if agent_system_prompt:
        # Use the full visualization agent prompt as base (strict quality requirements)
        base_prompt = agent_system_prompt
    else:
        # Fallback minimal prompt
        base_prompt = """# Visualization Agent
你是一个Manim可视化专家。

## 核心原则
1. **禁止纯文字罗列**：不能只是把解题步骤用Text显示出来
2. **禁止PPT式动画**：不能只是文字的淡入淡出
3. **图形优先**：每个概念都要用图形表示（Circle, Rectangle, Line, Arrow等）
4. **可数可见**：数量用具体的物体表示，让学生能数
5. **动态变化**：操作过程用动画展示
"""

    # Add animation guidelines (truncated for context window)
    animation_section = ""
    if animation_guidelines:
        # Only include key parts to avoid token overflow
        animation_section = """
## 动画规范要点
1. 使用 LaggedStart 错开显示多个元素
2. 使用 rate_func=smooth 让动画流畅
3. 使用 VGroup.arrange() 和 next_to() 防止重叠
4. 使用 FadeOut 清理旧元素后再显示新内容
5. 题目等2秒、步骤等1.5秒、答案等3秒
"""

    # Build the final prompt
    if skill_context:
        prompt = f"""{base_prompt}

{latex_constraint}

{animation_section}

---

# 专用模板参考

{skill_context}

---

# 生成要求
1. 从 from manim import * 开始
2. 严格按照模板的动画流程和图形设计
3. 动态计算题目中的具体数值
4. 使用 VGroup、arrange、next_to 组织布局
5. 中文使用 font="Microsoft YaHei" 或 "Noto Sans CJK SC"
6. 类名为 SolutionScene

直接输出完整Python代码："""
    else:
        prompt = f"""{base_prompt}

{latex_constraint}

{animation_section}

---

# 生成要求
1. 从 from manim import * 开始
2. 必须使用图形元素（Circle, Rectangle, Line, Arrow等）
3. 操作过程用动画展示（移动、变色、消失）
4. 使用 VGroup、arrange、next_to 组织布局
5. 中文使用 font="Microsoft YaHei"
6. 类名为 SolutionScene

直接输出完整Python代码："""
        
    try:
        response = await model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=problem_context),
        ])
        
        code = _extract_code(response.content)
        code = _sanitize_code(code)
        
        return {
            "manim_code": code,
            "skill_name": skill_name,
            "skill_context_str": skill_context,
        }
    except Exception as e:
        logger.error(f"Visualization generation failed: {e}")
        return {
            "manim_code": _fallback_code(problem_text, answer),
            "skill_name": skill_name,
            "skill_context_str": skill_context,
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
