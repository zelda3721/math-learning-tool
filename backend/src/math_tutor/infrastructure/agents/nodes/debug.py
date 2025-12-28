import json
"""
Debug Node - Fix Manim code errors
"""
import logging
import re
from typing import Any

from math_tutor.config import get_settings
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

DEBUG_PROMPT = """你是一个Manim代码调试专家。请修复以下代码中的错误。

常见问题：
1. 语法错误：缩进、括号匹配
2. API错误：使用不存在的方法或颜色
3. 逻辑错误：对象未定义就使用

请直接输出修复后的完整代码，从 from manim import * 开始。"""


LATEX_FIX_PROMPT = """你是一个Manim代码调试专家。系统报错提示环境缺少 LaTeX。
请修复代码，【将所有 MathTex, Tex 和 Matrix 对象替换为 Text 对象】。
严禁使用任何 LaTeX 语法。
请直接输出修复后的完整代码，从 from manim import * 开始。"""


REGENERATE_PROMPT = """你是一个Manim可视化专家。之前的代码生成失败。请重新生成高质量的Manim代码。

## 强制执行规则（必须遵守）

### 屏幕分区（防止文字图形重叠）
- 标题：title.to_edge(UP, buff=0.3)
- 步骤文字：step.next_to(title, DOWN, buff=0.2)
- 图形：graphics.scale(0.6).move_to(ORIGIN)
- 答案：answer.to_edge(DOWN, buff=0.5)
- ⚠️ 文字永远在图形上方或下方，不得重叠！

### 其他规则
1. **防止重叠**：所有元素用 VGroup + arrange_in_grid 组织，scale(0.5~0.6)
2. **逐个出现**：多个元素用 LaggedStart
3. **渐进变换**：变化过程用动画展示，不要直接显示结果
4. **等待时间**：题目2秒、步骤1.5秒、答案3秒
5. **图形表达**：数量用 Circle，禁止纯文字

## 代码要求
1. 从 from manim import * 开始
2. 类名为 SolutionScene
3. 【严禁使用 MathTex/Tex】，全部使用 Text 类
4. 中文用 font="Microsoft YaHei"

请直接输出完整代码。"""


# Required patterns for quality code
QUALITY_PATTERNS = [
    (r"arrange|arrange_in_grid", "布局函数 (arrange)"),
    (r"scale\s*\(\s*0\.[4-7]", "缩放 (scale 0.4-0.7)"),
    (r"LaggedStart", "逐个出现 (LaggedStart)"),
    (r"self\.wait\s*\(", "等待时间 (wait)"),
    (r"VGroup", "元素组织 (VGroup)"),
]

# Layout patterns to prevent overlap
LAYOUT_PATTERNS = [
    (r"to_edge\s*\(\s*UP", "标题在顶部 (to_edge UP)"),
    (r"to_edge\s*\(\s*DOWN", "答案在底部 (to_edge DOWN)"),
    (r"move_to\s*\(\s*ORIGIN|move_to\s*\(\s*DOWN|move_to\s*\(\s*UP", "图形定位 (move_to)"),
    (r"next_to\s*\(", "相对定位 (next_to)"),
]


def validate_code_quality(code: str) -> list[str]:
    """
    检查代码是否符合质量规范。
    返回缺失的模式列表。
    """
    missing = []
    for pattern, description in QUALITY_PATTERNS:
        if not re.search(pattern, code):
            missing.append(description)
    return missing


def validate_layout(code: str) -> list[str]:
    """
    检查代码是否遵循屏幕分区布局规范。
    返回缺失的布局模式列表。
    """
    missing = []
    for pattern, description in LAYOUT_PATTERNS:
        if not re.search(pattern, code):
            missing.append(description)
    return missing


async def debug_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Debug and fix Manim code errors.
    If code is missing (e.g. timeout), regenerate it.
    """
    manim_code = state.get("manim_code", "")
    error_message = state.get("error_message", "")
    debug_attempts = state.get("debug_attempts", 0)
    
    # Context retrieval
    problem_text = state.get("problem_text", "")
    solution = state.get("solution", {})
    
    logger.info(f"Debugging code (attempt {debug_attempts + 1})... Code length: {len(manim_code)}")
    
    # Case 0: LaTeX Error -> Special fix (more precise detection)
    # Only trigger for actual LaTeX-related errors, not just any message containing "latex"
    is_latex_error = any([
        "filenotfounderror" in error_message.lower() and "latex" in error_message.lower(),
        "no such file or directory" in error_message.lower() and "latex" in error_message.lower(),
        "dvipng" in error_message.lower(),
        "dvisvgm" in error_message.lower(),
        "latex error converting" in error_message.lower(),  # From manim error output
        "mathtex" in error_message.lower() and ("failed" in error_message.lower() or "error" in error_message.lower()),
        "compilation failed" in error_message.lower() and "tex" in error_message.lower(),
    ])
    
    if is_latex_error:
        logger.warning("LaTeX error detected. Switching to Text-only mode.")
        prompt = LATEX_FIX_PROMPT
        context = f"错误：{error_message}\n\n当前代码：\n```python\n{manim_code}\n```"

    # Case 1: Timeout or missing code -> Regenerate
    elif not manim_code or "Timeout" in error_message:
        logger.warning(f"No code found (len={len(manim_code)}) or timeout detected. Regenerating...")
        
        skill_ctx = state.get("skill_context_str", "")
        if skill_ctx:
            logger.info("Regenerating using preserved Skill Context")
            settings = get_settings()
            latex_note = "【严禁使用 MathTex/Tex】，全部使用 Text 类" if not settings.manim_use_latex else "可以使用 MathTex"
            
            prompt = f"""你是一个Manim可视化专家。之前的代码生成失败。
请基于以下参考模板重新生成高质量代码。

{skill_ctx}

## 强制执行规则（必须遵守）
1. **防止重叠**：VGroup + arrange_in_grid + scale(0.5~0.6)
2. **逐个出现**：LaggedStart(*[FadeIn(i) for i in items], lag_ratio=0.1)
3. **渐进变换**：变化过程用动画展示
4. **等待时间**：题目2秒、步骤1.5秒、答案3秒
5. **图形表达**：数量用 Circle，脚用 Line

## 代码要求
1. 从 from manim import * 开始
2. 严格遵循模板的可视化逻辑
3. 类名为 SolutionScene
4. {latex_note}
5. 中文用 font="Microsoft YaHei"

请直接输出完整代码。"""
        else:
            prompt = REGENERATE_PROMPT
            
        context = f"题目：{problem_text}\n\n解答：{json.dumps(solution, ensure_ascii=False)}\n\n错误：{error_message}"
    
    # Case 2: Existing code with error -> Fix
    else:
        context = f"""
错误信息：
{error_message}

当前代码：
```python
{manim_code}
```

这是第 {debug_attempts + 1} 次调试。请修复所有错误。
"""
        prompt = DEBUG_PROMPT
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=context),
        ])
        
        fixed_code = _extract_code(response.content)
        fixed_code = _sanitize_code(fixed_code)
        
        return {
            "manim_code": fixed_code,
            "debug_attempts": debug_attempts + 1,
        }
    except Exception as e:
        logger.error(f"Debug failed: {e}")
        return {
            "debug_attempts": debug_attempts + 1,
        }


def _extract_code(content: str) -> str:
    """Extract Python code from response"""
    match = re.search(r"```python\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    match = re.search(r"```\n(.*?)```", content, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    return content.strip()


def _sanitize_code(code: str) -> str:
    """Fix common issues"""
    code = re.sub(r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)", "", code)
    
    for color in ["ORANGE_E", "BLUE_D", "BLUE_E", "RED_A", "GREEN_E", "GREEN_D", "YELLOW_E"]:
        code = re.sub(rf"\b{color}\b", "BLUE", code)
    
    return code
