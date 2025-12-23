"""
审查Agent，负责检查和优化Manim代码的布局和场景切换
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

class ReviewAgent(BaseAgent):
    """审查Agent类"""
    def __init__(self, model: ChatOpenAI):
        """
        初始化审查Agent
        
        Args:
            model: LLM模型实例
        """
        # 从skills系统获取提示词
        system_prompt = skill_loader.get_agent_prompt('review')
        
        super().__init__(
            name="审查Agent",
            description="检查和优化Manim代码的布局和场景切换",
            system_prompt=system_prompt,
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
        context_parts = ["请审查并优化以下Manim代码的布局和场景切换。"]
        
        if problem_text:
            context_parts.append(f"题目：\n{problem_text}\n")
        
        if error_message:
            context_parts.append(f"之前遇到的问题：\n{error_message}\n")
        
        context_parts.extend([
            f"当前代码：\n{code}",
            "",
            "请重点检查以下问题：",
            "1. 元素重叠：确保文字与图形、图形与图形之间不会重叠",
            "2. 场景切换：确保场景之间的过渡流畅，上一个场景的元素在新场景开始前被适当清除或移动",
            "3. 布局优化：使用VGroup和arrange方法组织相关元素，实现一致的布局策略",
            "4. 动画流畅性：确保动画时间合理，相关元素的动画连贯",
            "",
            "请提供优化后的完整代码。"
        ])
        
        prompt = "\n".join(context_parts)
        
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

代码内容：
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
    }}
  ],
  "场景切换问题": [...],
  "布局问题": [...],
  "动画问题": [...],
  "总体评价": "总体评价",
  "优化建议": "整体优化建议"
}}
```

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
                "总体评价": "处理失败",
                "优化建议": str(e)
            }