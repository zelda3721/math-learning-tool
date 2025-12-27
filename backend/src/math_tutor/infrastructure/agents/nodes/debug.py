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


REGENERATE_PROMPT = """你是一个Manim可视化专家。之前的代码生成失败或超时。请根据题目重新生成完整的Manim代码。

要求：
1. 从 from manim import * 开始
2. 使用简单的动画（Write, FadeIn, Create）
3. 确保类名为 SolutionScene
4. 代码要短小精悍，不要太复杂以免超时
5. 【严禁使用 MathTex/Tex】，全部使用 Text 类（因系统无LaTeX）

请直接输出完整代码。"""


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
    
    # Case 0: LaTeX Error -> Special fix
    if "latex" in error_message.lower() or "dvipng" in error_message.lower():
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
            
            prompt = f"""你是一个Manim可视化专家。之前的代码生成失败或超时。
请基于以下参考模板重新生成代码。

{skill_ctx}

要求：
1. 从 from manim import * 开始
2. 严格遵循模板的可视化逻辑（如假设法动画步骤）
3. 确保类名为 SolutionScene
4. {latex_note}
5. 保持代码逻辑清晰，但不要过度复杂

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
