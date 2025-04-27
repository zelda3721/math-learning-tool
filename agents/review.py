"""
审查Agent，负责检查和优化Manim代码的布局和场景切换
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

# 审查Agent的系统提示词
REVIEW_AGENT_PROMPT = """你是一个专业的Manim代码审查专家，专注于优化数学可视化代码的布局和场景切换。
你的任务是分析Manim代码，识别并修复以下问题：

1. **元素重叠问题**：
   - 检查元素定位是否合理，避免文字与图形、图形与图形之间的重叠
   - 确保所有元素都在屏幕可见范围内，不会被裁剪
   - 优化元素的大小和位置，确保视觉清晰度

2. **场景切换问题**：
   - 检查场景之间的过渡是否流畅
   - 确保上一个场景的元素在新场景开始前被适当清除或移动
   - 优化动画序列，避免突兀的变化

3. **布局优化**：
   - 使用VGroup和arrange方法组织相关元素
   - 实现一致的布局策略（如标题在顶部，说明在中间，图形在底部）
   - 确保文字和图形的大小适中，不会占据过多屏幕空间

4. **动画流畅性**：
   - 检查动画时间是否合理，避免过快或过慢
   - 确保相关元素的动画连贯，表现出逻辑关系
   - 添加适当的等待时间，让观众有足够时间理解内容

请分析代码并提供具体的修改建议，重点关注布局和场景切换问题。你的修改应该保持原代码的功能和意图不变，只优化视觉表现。

输出格式：
```python
# 完整的、优化后的Manim代码
from manim import *

class MathVisualization(Scene):
    def construct(self):
        # 优化后的代码
        ...
        请确保你的修改是最小必要的，保留原始代码的意图和结构，同时解决所有布局和场景切换问题。"""

class ReviewAgent(BaseAgent):
    """审查Agent类"""
    def __init__(self, model: ChatOpenAI):
        """
        初始化审查Agent
        
        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="审查Agent",
            description="检查和优化Manim代码的布局和场景切换",
            system_prompt=REVIEW_AGENT_PROMPT,
            model=model
        )
        logger.info("审查Agent初始化完成")

    async def review_code(self, code: str, problem_text: str = "", error_message: str = "") -> str:
        """
        审查并优化代码布局和场景切换
        
        Args:
            code: 原始Manim代码
            problem_text: 题目文本（可选）
            error_message: 之前遇到的错误信息（可选）
            
        Returns:
            优化后的代码
        """
        # 构建提示词，包含代码和可能的错误信息
        prompt = f"""请审查并优化以下Manim代码的布局和场景切换。
        {'题目：\n' + problem_text + '\n\n' if problem_text else ''}
{'之前遇到的问题：\n' + error_message + '\n\n' if error_message else ''}

当前代码：
{code}
请重点检查以下问题：

1. 元素重叠：确保文字与图形、图形与图形之间不会重叠
2. 场景切换：确保场景之间的过渡流畅，上一个场景的元素在新场景开始前被适当清除或移动
3. 布局优化：使用VGroup和arrange方法组织相关元素，实现一致的布局策略
4. 动画流畅性：确保动画时间合理，相关元素的动画连贯
请提供优化后的完整代码。"""
        response = await self.arun(prompt)
        logger.info(f"审查Agent优化完成: {response[:100]}...")
    
        try:
            # 尝试从响应中提取Python代码
            if "```python" in response and "```" in response.split("```python", 1)[1]:
                reviewed_code = response.split("```python", 1)[1].split("```", 1)[0].strip()
            elif "```" in response and "```" in response.split("```", 1)[1]:
                reviewed_code = response.split("```", 1)[1].split("```", 1)[0].strip()
            else:
                # 尝试直接提取Python代码
                import re
                # 查找从'from manim import'或'import manim'开始的代码块
                match = re.search(r'(from\s+manim\s+import.*|import\s+manim.*)', response, re.DOTALL)
                if match:
                    reviewed_code = match.string[match.start():].strip()
                else:
                    # 如果找不到导入语句，可能整个响应就是代码
                    reviewed_code = response.strip()
            
            # 检查是否有优化后的代码
            if not reviewed_code:
                logger.warning("无法从审查Agent响应中提取代码")
                return code  # 返回原始代码
            
            # 尝试编译代码检查语法
            try:
                compile(reviewed_code, "<string>", "exec")
                logger.info("审查Agent优化的代码通过了语法检查")
            except SyntaxError as e:
                logger.warning(f"审查Agent优化的代码存在语法错误: {e}")
                # 返回原始代码，避免引入新的语法错误
                return code
            
            return reviewed_code
        except Exception as e:
            logger.error(f"处理审查Agent响应时出错: {e}")
            return code  # 出错时返回原始代码

    async def analyze_layout_issues(self, code: str) -> Dict[str, Any]:
        """
        分析代码中的布局问题并提供详细报告
        
        Args:
            code: Manim代码
            
        Returns:
            布局问题分析报告
        """
        prompt = f"""请分析以下Manim代码中可能存在的布局和场景切换问题，并提供详细报告。
        {code}
        请重点分析以下几个方面：

1. 元素重叠问题
2. 场景切换问题
3. 布局不合理问题
4. 动画流畅性问题
输出格式：
```json
{{
  "问题总数": 数字,
  "元素重叠问题": [
    {{
      "行号": "大约行号",
      "问题描述": "具体描述",
      "修复建议": "建议"
    }},
    ...
  ],
  "场景切换问题": [...],
  "布局问题": [...],
  "动画问题": [...],
  "总体评价": "总体评价",
  "优化建议": "整体优化建议"
}}
请提供尽可能详细的分析。"""
        response = await self.arun(prompt)
        logger.info(f"布局问题分析完成: {response[:100]}...")
        
        try:
            # 尝试从响应中提取JSON
            if "```json" in response and "```" in response.split("```json", 1)[1]:
                json_text = response.split("```json", 1)[1].split("```", 1)[0].strip()
            elif "```" in response and "```" in response.split("```", 1)[1]:
                json_text = response.split("```", 1)[1].split("```", 1)[0].strip()
            else:
                json_text = response.strip()
                
            analysis_result = json.loads(json_text)
            return analysis_result
        except json.JSONDecodeError as e:
            logger.error(f"JSON解析错误: {e}")
            # 返回一个基本结构
            return {
                "问题总数": 0,
                "元素重叠问题": [],
                "场景切换问题": [],
                "布局问题": [],
                "动画问题": [],
                "总体评价": "分析失败",
                "优化建议": "请重试分析"
            }
        except Exception as e:
            logger.error(f"处理响应时出错: {e}")
            return {
                "问题总数": 0,
                "元素重叠问题": [],
                "场景切换问题": [],
                "布局问题": [],
                "动画问题": [],
                "总体评价": "处理出错",
                "优化建议": str(e)
            }