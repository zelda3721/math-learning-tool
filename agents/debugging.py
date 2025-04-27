"""
调试Agent，负责修复Manim代码中的错误
"""
import json
import logging
import re
from typing import Dict, Any, List, Optional, Tuple
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 调试Agent的系统提示词
DEBUGGING_AGENT_PROMPT = """你是一个专业的Python和Manim代码调试专家，精通修复代码中的错误。
你的任务是分析并修复Manim可视化代码中的错误，确保代码能够正确执行生成视频。

当你收到错误信息和代码时，请按照以下步骤进行调试：
1. 仔细分析错误信息，确定错误类型和位置。
2. 检查代码中的语法错误、逻辑错误或Manim特定的问题。
3. 提供一个完整的、修复后的代码版本。
4. **重要：修复错误时，请最大限度地保留原始代码的逻辑结构、动画步骤和可视化意图。修复应尽可能局部化，避免对未出错部分进行不必要的修改或简化。确保修复后的代码仍然能够完整、准确地反映解题过程。**
5. 确保代码遵循Manim的最佳实践。

请注意：
- 返回的代码必须是完整的、可直接执行的Python脚本。
- 只返回修复后的代码，不需要解释或分析。
- 确保代码中包含至少一个继承自Scene的类。
- 使用ManimCE (Community Edition)的语法。
- 如果代码包含中文注释或字符串，确保它们能在Python中正确运行。

输出格式：
```python
# 完整的、修复后的Manim代码
from manim import *

class MathVisualization(Scene):
    def construct(self):
        # 这里是完整的可视化代码
        ...
```

请确保你的修复是最小必要的，保留原始代码的意图和结构，同时解决所有错误。"""

class DebuggingAgent(BaseAgent):
    """调试Agent类"""
    
    def __init__(self, model: ChatOpenAI):
        """
        初始化调试Agent
        
        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="调试Agent",
            description="修复Manim代码中的错误",
            system_prompt=DEBUGGING_AGENT_PROMPT,
            model=model
        )
        logger.info("调试Agent初始化完成")
    
    async def debug_code(self, code: str, error_message: str, attempt: int) -> str:
        """
        调试代码
        
        Args:
            code: 原始代码
            error_message: 错误信息
            attempt: 当前尝试次数
            
        Returns:
            修复后的代码
        """
        # 构建提示词，包含代码和错误信息
        prompt = f"""请帮我修复以下Manim代码中的错误。

错误信息：
{error_message}

当前代码：
```python
{code}
```

这是第{attempt}次尝试修复。请提供一个完整的、修复后的代码版本。"""
        
        response = await self.arun(prompt)
        logger.info(f"调试Agent修复完成: {response[:100]}...")
        
        try:
            # 尝试从响应中提取Python代码
            if "```python" in response and "```" in response.split("```python", 1)[1]:
                fixed_code = response.split("```python", 1)[1].split("```", 1)[0].strip()
            elif "```" in response and "```" in response.split("```", 1)[1]:
                fixed_code = response.split("```", 1)[1].split("```", 1)[0].strip()
            else:
                # 尝试直接提取Python代码
                import re
                # 查找从'from manim import'或'import manim'开始的代码块
                match = re.search(r'(from\s+manim\s+import.*|import\s+manim.*)', response, re.DOTALL)
                if match:
                    fixed_code = match.string[match.start():].strip()
                else:
                    # 如果找不到导入语句，可能整个响应就是代码
                    fixed_code = response.strip()
            
            # 检查是否有修复后的代码
            if not fixed_code:
                logger.warning("无法从调试Agent响应中提取代码")
                return code  # 返回原始代码
            
            # 尝试编译代码检查语法
            try:
                compile(fixed_code, "<string>", "exec")
                logger.info("调试Agent修复的代码通过了语法检查")
            except SyntaxError as e:
                logger.warning(f"调试Agent修复的代码存在语法错误: {e}")
                # 尝试简单清理代码
                fixed_code = self._clean_code(fixed_code)
            
            return fixed_code
        except Exception as e:
            logger.error(f"处理调试Agent响应时出错: {e}")
            return code  # 出错时返回原始代码
    
    def _clean_code(self, code: str) -> str:
        """
        简单清理代码中的常见问题
        
        Args:
            code: 原始代码
            
        Returns:
            清理后的代码
        """
        # 分割代码行
        lines = code.split('\n')
        clean_lines = []
        
        for line in lines:
            # 跳过非代码行（如果包含非ASCII字符且不是注释）
            if any(ord(c) > 127 for c in line) and not line.strip().startswith('#'):
                clean_lines.append(f"# {line}")  # 转换为注释
            else:
                clean_lines.append(line)
        
        return '\n'.join(clean_lines)