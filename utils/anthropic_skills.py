"""
Anthropic Skills集成 - 可选的高级功能
提供基于Anthropic Claude API的专业技能
"""
import logging
import os
from typing import Dict, Any, List, Optional
import json

# 只在需要时导入anthropic
try:
    from anthropic import Anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False
    logging.warning("Anthropic SDK not available. Skills will be disabled.")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class AnthropicSkillsManager:
    """
    Anthropic Skills管理器
    提供文档理解、数学推理、代码生成等专业技能
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        初始化Skills管理器

        Args:
            api_key: Anthropic API密钥，None时从环境变量读取
        """
        if not ANTHROPIC_AVAILABLE:
            logger.warning("Anthropic SDK not installed. Skills are disabled.")
            self.client = None
            self.enabled = False
            return

        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY")

        if not self.api_key:
            logger.warning("ANTHROPIC_API_KEY not found. Skills are disabled.")
            self.client = None
            self.enabled = False
            return

        self.client = Anthropic(api_key=self.api_key)
        self.enabled = True
        self.default_model = "claude-3-5-sonnet-20241022"

        logger.info("Anthropic Skills enabled")

    def is_enabled(self) -> bool:
        """检查Skills是否可用"""
        return self.enabled

    async def document_understanding_skill(
        self,
        document_content: str,
        task: str = "extract_knowledge"
    ) -> Dict[str, Any]:
        """
        文档理解技能
        利用Claude的长上下文能力深度理解教材内容

        Args:
            document_content: 文档内容（最多200K tokens）
            task: 任务类型 (extract_knowledge/summarize/analyze_structure)

        Returns:
            理解结果
        """
        if not self.enabled:
            return {"error": "Anthropic Skills not enabled"}

        prompts = {
            "extract_knowledge": """请深入分析这份教材内容，提取所有重要的知识点。

对于每个知识点，请识别：
1. 类型（定义/定理/公式/推导/性质/方法）
2. 重要性级别
3. 前置知识要求
4. 学习难度
5. 实际应用场景

以JSON格式输出结构化的知识点列表。""",

            "summarize": """请为这份教材内容生成一个全面的摘要，包括：
1. 主要主题和概念
2. 核心定理和公式
3. 典型例题类型
4. 学习重点和难点
5. 知识点之间的关联

用清晰的中文表达，帮助学生快速把握整体框架。""",

            "analyze_structure": """请分析这份教材的结构组织，包括：
1. 内容分层（章节、小节、知识点）
2. 逻辑递进关系
3. 知识点依赖图
4. 建议的学习路径

以结构化的方式输出分析结果。"""
        }

        prompt = prompts.get(task, prompts["extract_knowledge"])

        try:
            response = self.client.messages.create(
                model=self.default_model,
                max_tokens=8000,
                messages=[
                    {
                        "role": "user",
                        "content": f"{prompt}\n\n【教材内容】\n{document_content[:180000]}"  # 限制长度
                    }
                ]
            )

            result = response.content[0].text

            # 尝试解析JSON
            try:
                return json.loads(result)
            except json.JSONDecodeError:
                return {"text": result}

        except Exception as e:
            logger.error(f"Document understanding skill error: {str(e)}")
            return {"error": str(e)}

    async def mathematical_reasoning_skill(
        self,
        problem: str,
        context: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        数学推理技能
        用于复杂的数学概念讲解和推导

        Args:
            problem: 数学问题或概念
            context: 额外上下文

        Returns:
            推理结果
        """
        if not self.enabled:
            return {"error": "Anthropic Skills not enabled"}

        prompt = f"""作为一位资深的数学教育专家，请为以下数学概念/问题提供深入的讲解。

**要求**：
1. 从基础概念出发，层层递进
2. 提供严格的数学推导和证明
3. 举出具体例子帮助理解
4. 指出常见误区和易错点
5. 给出可视化建议

**数学问题/概念**：
{problem}
"""

        if context:
            prompt += f"\n**额外上下文**：\n{json.dumps(context, ensure_ascii=False, indent=2)}"

        try:
            response = self.client.messages.create(
                model=self.default_model,
                max_tokens=4000,
                messages=[{"role": "user", "content": prompt}]
            )

            return {"explanation": response.content[0].text}

        except Exception as e:
            logger.error(f"Mathematical reasoning skill error: {str(e)}")
            return {"error": str(e)}

    async def manim_code_generation_skill(
        self,
        scene_description: str,
        knowledge_points: List[Dict],
        style: str = "professional"
    ) -> Dict[str, Any]:
        """
        Manim代码生成技能
        专门为大学课程内容生成高质量Manim代码

        Args:
            scene_description: 场景描述
            knowledge_points: 知识点列表
            style: 风格 (professional/3blue1brown/bilibili)

        Returns:
            生成的Manim代码
        """
        if not self.enabled:
            return {"error": "Anthropic Skills not enabled"}

        style_prompts = {
            "professional": "专业学术风格，注重严谨性和清晰度",
            "3blue1brown": "3Blue1Brown风格，强调几何直觉和视觉美感",
            "bilibili": "B站讲解风格，生动有趣，注重互动"
        }

        prompt = f"""请生成高质量的Manim代码，用于讲解以下内容。

**风格要求**：{style_prompts.get(style, style)}

**场景描述**：
{scene_description}

**知识点**：
{json.dumps(knowledge_points[:5], ensure_ascii=False, indent=2)}

**技术要求**：
1. 使用Manim Community Edition
2. 中文使用font="Noto Sans CJK SC"
3. 合理使用动画（Transform, FadeIn, Write等）
4. 布局清晰，避免元素重叠
5. 添加必要的注释

请生成完整的可执行代码。
"""

        try:
            response = self.client.messages.create(
                model=self.default_model,
                max_tokens=6000,
                messages=[{"role": "user", "content": prompt}]
            )

            code = response.content[0].text

            # 提取Python代码块
            if "```python" in code:
                code = code.split("```python")[1].split("```")[0].strip()

            return {"code": code}

        except Exception as e:
            logger.error(f"Manim code generation skill error: {str(e)}")
            return {"error": str(e)}

    async def quality_assurance_skill(
        self,
        content: str,
        content_type: str = "script"
    ) -> Dict[str, Any]:
        """
        质量保证技能
        审核脚本、代码等内容的质量

        Args:
            content: 要审核的内容
            content_type: 类型 (script/code/knowledge_points)

        Returns:
            审核结果和改进建议
        """
        if not self.enabled:
            return {"error": "Anthropic Skills not enabled"}

        prompts = {
            "script": """请审核这份讲解脚本的质量，评估：
1. 逻辑连贯性
2. 语言流畅度
3. 概念准确性
4. 易理解程度
5. 时间分配合理性

给出评分（1-10）和具体改进建议。""",

            "code": """请审核这份Manim代码的质量，检查：
1. 代码正确性
2. 动画流畅度
3. 布局合理性
4. 性能优化
5. 代码规范

给出评分和优化建议。""",

            "knowledge_points": """请审核这些知识点的提取质量，评估：
1. 完整性（是否遗漏重要知识）
2. 准确性（描述是否准确）
3. 结构化程度
4. 难度评估合理性
5. 依赖关系准确性

给出评分和改进建议。"""
        }

        prompt = prompts.get(content_type, prompts["script"])

        try:
            response = self.client.messages.create(
                model=self.default_model,
                max_tokens=3000,
                messages=[
                    {
                        "role": "user",
                        "content": f"{prompt}\n\n【待审核内容】\n{content[:15000]}"
                    }
                ]
            )

            return {"review": response.content[0].text}

        except Exception as e:
            logger.error(f"Quality assurance skill error: {str(e)}")
            return {"error": str(e)}


# 全局单例
_skills_manager = None


def get_skills_manager(api_key: Optional[str] = None) -> AnthropicSkillsManager:
    """获取全局Skills管理器"""
    global _skills_manager

    if _skills_manager is None:
        _skills_manager = AnthropicSkillsManager(api_key)

    return _skills_manager
