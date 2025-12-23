"""
调试Agent，负责修复Manim代码中的错误
"""
import json
import logging
import re
from typing import Dict, Any, List, Optional, Tuple
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from skills.skill_loader import skill_loader

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class DebuggingAgent(BaseAgent):
    """调试Agent类"""
    
    def __init__(self, model: ChatOpenAI):
        """
        初始化调试Agent
        
        Args:
            model: LLM模型实例
        """
        # 从skills系统获取提示词
        system_prompt = skill_loader.get_agent_prompt('debugging')
        
        super().__init__(
            name="调试Agent",
            description="修复Manim代码中的错误",
            system_prompt=system_prompt,
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