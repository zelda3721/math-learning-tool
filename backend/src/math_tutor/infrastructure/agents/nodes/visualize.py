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
    visualization_patterns = ""
    
    if skill_repo:
        # Try to get the visualization agent prompt (core quality requirements)
        agent_system_prompt = skill_repo.get_agent_prompt("visualization") or ""
        # Get animation guidelines (detailed animation standards)
        animation_guidelines = skill_repo.get_animation_guidelines() or ""
        # Get relevant visualization patterns for this problem type
        visualization_patterns = skill_repo.get_visualization_patterns(problem_text, problem_type)
        
        if not skill_context:
            best_skill = skill_repo.find_best_match(problem_text, grade_level)
            
            if best_skill:
                skill_name = best_skill.name
                logger.info(f"Matched visualization skill: {best_skill.name}")
                
                # TEMPLATE-FIRST STRATEGY: If skill has code template, use it directly!
                if best_skill.code_template and len(best_skill.code_template) > 100:
                    logger.info(f"Using template code directly (len={len(best_skill.code_template)})")
                    
                    # Sanitize and validate template code
                    template_code = _sanitize_code(best_skill.code_template)
                    valid, error = _validate_syntax(template_code)
                    
                    if valid:
                        quality_ok, quality_error = _check_code_quality(template_code)
                        if quality_ok:
                            return {
                                "manim_code": template_code,
                                "skill_name": skill_name,
                                "skill_context_str": f"【直接使用模板：{skill_name}】",
                                "template_used": True,
                            }
                        else:
                            logger.warning(f"Template quality issue: {quality_error}")
                    else:
                        logger.warning(f"Template syntax error: {error}")
                
                # Fallback: use prompt_template as context for LLM
                skill_context = f"""
【匹配到专用技能：{best_skill.name}】

{best_skill.prompt_template}

---
**重要：严格按照上述代码模板的结构和动画效果来实现！**
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

    # Add animation guidelines - MANDATORY RULES
    animation_section = """
## ⚠️ 强制执行规则（违反任何一条即为失败）

### 规则1：禁止元素重叠
- 所有元素必须使用 VGroup + arrange() 或 arrange_in_grid()
- 所有主视觉元素必须 scale(0.5~0.7) 防止溢出屏幕
- 文字标签必须用 next_to(obj, DOWN/UP, buff=0.3)

### 规则2：禁止一次性呈现多个元素
- 3个以上元素必须用 LaggedStart 逐个出现
- 示例：self.play(LaggedStart(*[FadeIn(i) for i in items], lag_ratio=0.1))

### 规则3：必须有渐进变换过程
- 数量变化必须用动画展示（如脚的增加要用 GrowFromCenter）
- 颜色变化必须用 animate.set_color() 过渡
- 禁止直接 FadeIn 结果

### 规则4：必须有等待时间
- 题目展示后: self.wait(2)
- 每个步骤后: self.wait(1.5)
- 最终答案后: self.wait(3)
- 场景切换前: self.wait(0.5)

### 规则5：必须用VGroup组织元素
- 示例：circles = VGroup(*[Circle() for _ in range(n)])
- 必须：circles.arrange_in_grid(rows=3, buff=0.2).scale(0.6)

### 规则6：场景切换必须清理旧元素
- 必须：self.play(FadeOut(old_group))
- 然后：self.wait(0.3)
- 最后：self.play(FadeIn(new_group))

### 规则7：图形化表达数学概念
- 数量用 Circle 表示（能数出来）
- 脚/腿用 Line 表示
- 变化过程用动画展示（不是纯文字）

### 规则8：屏幕分区（防止文字图形重叠）
- 标题区：title.to_edge(UP, buff=0.3)
- 步骤文字：step.next_to(title, DOWN, buff=0.2)
- 图形区：graphics.scale(0.6).move_to(ORIGIN)
- 答案区：answer.to_edge(DOWN, buff=0.5)
- ⚠️ 文字永远在图形上方或下方，不得与图形同一Y坐标
"""

    # Build the final prompt
    if skill_context:
        prompt = f"""{base_prompt}

{latex_constraint}

{animation_section}

---

# ⚠️ 禁止使用的 Manim 对象
以下对象有 API 兼容问题，**绝对禁止使用**：
- Sector（参数冲突）
- AnnularSector（参数冲突）
- Annulus（复杂几何）
- ThreeDScene（不支持3D）
- MathTex / Tex（无LaTeX环境）

替代方案：
- 用 Arc + Line 组合代替 Sector
- 用 Axes.plot() 画函数曲线
- 用 Text() 显示公式

---

# 🔒 必须复制的完整代码模板

你**必须**严格按照以下模板代码来生成。不要自己设计新方法！
直接复制模板中的 class 结构，只修改参数数值。

{skill_context}

---

# 生成要求（必须遵守）
1. 从 from manim import * 开始
2. ⚠️ 直接复制上面模板的代码结构
3. ⚠️ 只修改题目中的具体数值
4. ⚠️ 禁止使用 Sector、MathTex 等被禁对象
5. 类名为 SolutionScene

直接输出完整Python代码："""
    else:
        # Build patterns section if available
        patterns_section = ""
        if visualization_patterns:
            patterns_section = f"""
## 可复用的可视化模式
以下是适用于此题型的代码模式，请参考使用：

{visualization_patterns}
"""

        prompt = f"""{base_prompt}

{latex_constraint}

{animation_section}

{patterns_section}

---

# 生成要求
1. 从 from manim import * 开始
2. 必须使用图形元素（Circle, Rectangle, Line, Arrow等）展示解题过程
3. 所有计算过程通过图形动画展示，不是纯文字
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


def _validate_syntax(code: str) -> tuple[bool, str]:
    """Validate Python syntax before execution"""
    try:
        compile(code, "<string>", "exec")
        return True, ""
    except SyntaxError as e:
        return False, f"Line {e.lineno}: {e.msg}"


def _check_code_quality(code: str) -> tuple[bool, str]:
    """Check code quality constraints"""
    # Check length
    if len(code) > 8000:
        return False, f"代码太长 ({len(code)} 字符)，请简化到 5000 字符以内"
    
    # Check for banned objects
    banned = ["Sector", "AnnularSector", "Annulus", "ThreeDScene", "Surface"]
    found = [obj for obj in banned if obj in code]
    if found:
        return False, f"使用了禁用对象: {', '.join(found)}"
    
    # Check for required class
    if "class SolutionScene" not in code and "class MathVisualization" not in code:
        return False, "缺少必需的 SolutionScene 类"
    
    return True, ""


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
