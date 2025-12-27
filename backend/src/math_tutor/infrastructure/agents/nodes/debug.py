"""
Debug Node - Fix Manim code errors
"""
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

DEBUG_PROMPT = """你是一个Manim代码调试专家。请修复以下代码中的错误。

常见问题：
1. 语法错误：缩进、括号匹配
2. API错误：使用不存在的方法或颜色
3. 逻辑错误：对象未定义就使用

请直接输出修复后的完整代码，从 from manim import * 开始。"""


async def debug_node(state: dict[str, Any], model: ChatOpenAI) -> dict[str, Any]:
    """
    Debug and fix Manim code errors.
    """
    manim_code = state.get("manim_code", "")
    error_message = state.get("error_message", "")
    debug_attempts = state.get("debug_attempts", 0)
    
    logger.info(f"Debugging code (attempt {debug_attempts + 1})...")
    
    context = f"""
错误信息：
{error_message}

当前代码：
```python
{manim_code}
```

这是第 {debug_attempts + 1} 次调试。请修复所有错误。
"""
    
    try:
        response = await model.ainvoke([
            SystemMessage(content=DEBUG_PROMPT),
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
