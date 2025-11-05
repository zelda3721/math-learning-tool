"""
知识点提取Agent - 从章节内容中提取结构化知识点
支持概念定义、定理公式、证明推导、例题应用等
"""
import logging
import json
import re
from typing import Dict, Any, List, Optional
from agents.base import BaseAgent
from langchain_openai import ChatOpenAI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class KnowledgeExtractorAgent(BaseAgent):
    """知识点提取Agent"""

    def __init__(self, model: ChatOpenAI):
        """
        初始化知识点提取Agent

        Args:
            model: LLM模型实例
        """
        system_prompt = self._get_system_prompt()

        super().__init__(
            name="Knowledge Extractor",
            description="从教材章节中提取结构化知识点",
            system_prompt=system_prompt,
            model=model
        )

    def _get_system_prompt(self) -> str:
        """获取系统提示词"""
        return """你是一位资深的教育专家和知识工程师，擅长从大学教材中提取和组织知识点。

**核心任务**：分析教材章节内容，提取结构化的知识点，为后续视频讲解提供清晰的知识框架。

**知识点类型**：
1. **定义（Definition）**：核心概念的精确定义
2. **定理（Theorem）**：重要定理、法则、原理
3. **公式（Formula）**：关键数学公式和方程
4. **推导（Derivation）**：证明过程和推导步骤
5. **性质（Property）**：概念的重要性质和特征
6. **例题（Example）**：典型例题和应用场景
7. **方法（Method）**：解题方法和技巧
8. **注意（Note）**：易错点、特殊情况、注意事项

**分析维度**：
- **重要性**：high（核心知识点）、medium（重要知识点）、low（补充知识点）
- **难度**：basic（基础）、intermediate（中等）、advanced（高级）
- **依赖关系**：需要哪些先修知识
- **可视化提示**：如何用图形/动画展示

**输出格式**（严格JSON）：
```json
{
  "chapter_title": "章节标题",
  "subject": "学科领域（数学/经济学/计算机等）",
  "difficulty_level": "overall_difficulty（basic/intermediate/advanced）",
  "estimated_time": "预计讲解时长（分钟）",
  "knowledge_points": [
    {
      "id": "kp_001",
      "type": "definition/theorem/formula/derivation/property/example/method/note",
      "title": "知识点标题",
      "content": "知识点详细内容",
      "importance": "high/medium/low",
      "difficulty": "basic/intermediate/advanced",
      "prerequisites": ["前置知识点1", "前置知识点2"],
      "formulas": ["相关公式1", "相关公式2"],
      "visualization_hint": "可视化建议",
      "explanation_points": ["讲解要点1", "讲解要点2"],
      "common_mistakes": ["易错点1", "易错点2"]
    }
  ],
  "knowledge_structure": {
    "core_concepts": ["核心概念1", "核心概念2"],
    "key_theorems": ["关键定理1", "关键定理2"],
    "important_formulas": ["重要公式1", "重要公式2"],
    "typical_problems": ["典型问题类型1", "典型问题类型2"]
  },
  "learning_path": [
    {
      "order": 1,
      "knowledge_point_id": "kp_001",
      "reason": "为什么这个顺序"
    }
  ],
  "summary": "章节核心内容总结（2-3句话）"
}
```

**质量标准**：
- 知识点提取完整，不遗漏核心内容
- 分类准确，重要性和难度判断合理
- 依赖关系清晰，学习路径符合认知规律
- 提供实用的可视化建议和讲解要点
- 只输出JSON格式，不要其他文字说明

**示例**（线性代数-矩阵乘法）：
```json
{
  "chapter_title": "矩阵运算",
  "subject": "线性代数",
  "difficulty_level": "intermediate",
  "estimated_time": 15,
  "knowledge_points": [
    {
      "id": "kp_001",
      "type": "definition",
      "title": "矩阵乘法定义",
      "content": "设A是m×n矩阵，B是n×p矩阵，则C=AB是m×p矩阵，其中c_ij = Σ(a_ik * b_kj)",
      "importance": "high",
      "difficulty": "intermediate",
      "prerequisites": ["矩阵基础", "求和符号"],
      "formulas": ["(AB)_ij = Σ_{k=1}^{n} a_ik * b_kj"],
      "visualization_hint": "用颜色高亮显示第i行和第j列的对应元素相乘",
      "explanation_points": [
        "强调行列对应关系",
        "用2×2矩阵举具体例子",
        "动画展示逐个元素的计算过程"
      ],
      "common_mistakes": [
        "忘记检查维度是否匹配",
        "混淆行列顺序"
      ]
    },
    {
      "id": "kp_002",
      "type": "property",
      "title": "矩阵乘法不满足交换律",
      "content": "一般情况下AB ≠ BA，即矩阵乘法不满足交换律",
      "importance": "high",
      "difficulty": "basic",
      "prerequisites": ["kp_001"],
      "formulas": ["AB ≠ BA"],
      "visualization_hint": "用具体例子演示AB和BA的不同结果",
      "explanation_points": [
        "用2×2矩阵举反例",
        "解释为什么不满足交换律（维度角度）"
      ],
      "common_mistakes": ["错误地认为AB=BA"]
    }
  ],
  "knowledge_structure": {
    "core_concepts": ["矩阵乘法", "维度匹配"],
    "key_theorems": ["矩阵乘法结合律", "分配律"],
    "important_formulas": ["(AB)_ij = Σ a_ik * b_kj"],
    "typical_problems": ["计算矩阵乘积", "证明性质"]
  },
  "learning_path": [
    {"order": 1, "knowledge_point_id": "kp_001", "reason": "先理解定义"},
    {"order": 2, "knowledge_point_id": "kp_002", "reason": "基于定义理解性质"}
  ],
  "summary": "矩阵乘法是线性代数的核心运算，需要注意维度匹配和不满足交换律"
}
```
"""

    async def extract_knowledge(self, chapter_content: str, metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        从章节内容中提取知识点

        Args:
            chapter_content: 章节文本内容
            metadata: 可选的元数据（章节标题、学科等）

        Returns:
            结构化的知识点数据
        """
        # 构建用户输入
        user_input = f"""请分析以下教材章节内容，提取结构化的知识点：

【章节内容】
{chapter_content[:8000]}  # 限制长度避免token超限

"""
        if metadata:
            user_input += f"\n【元数据】\n"
            if "title" in metadata:
                user_input += f"章节标题: {metadata['title']}\n"
            if "subject" in metadata:
                user_input += f"学科: {metadata['subject']}\n"
            if "keywords" in metadata:
                user_input += f"关键词: {', '.join(metadata['keywords'])}\n"

        user_input += "\n请严格按照JSON格式输出知识点结构。"

        # 调用LLM
        response = await self.arun(user_input)

        # 解析JSON响应
        try:
            knowledge_data = self._parse_json_response(response)
            logger.info(f"Extracted {len(knowledge_data.get('knowledge_points', []))} knowledge points")
            return knowledge_data
        except Exception as e:
            logger.error(f"Failed to parse knowledge extraction response: {str(e)}")
            # 返回默认结构
            return {
                "chapter_title": metadata.get("title", "未知章节") if metadata else "未知章节",
                "subject": metadata.get("subject", "未知学科") if metadata else "未知学科",
                "knowledge_points": [],
                "error": str(e),
                "raw_response": response
            }

    def _parse_json_response(self, response: str) -> Dict[str, Any]:
        """解析JSON响应"""
        # 尝试提取JSON部分
        json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
        if json_match:
            json_str = json_match.group(1)
        else:
            # 尝试直接解析
            json_str = response.strip()

        # 清理可能的markdown标记
        json_str = json_str.replace('```json', '').replace('```', '').strip()

        # 解析JSON
        return json.loads(json_str)

    def enhance_with_examples(self, knowledge_points: List[Dict]) -> List[Dict]:
        """
        为知识点补充例题
        （可选功能，后续可以调用LLM生成具体例题）
        """
        # 这里可以实现例题生成逻辑
        # 暂时返回原始知识点
        return knowledge_points

    def build_dependency_graph(self, knowledge_points: List[Dict]) -> Dict[str, List[str]]:
        """
        构建知识点依赖图

        Args:
            knowledge_points: 知识点列表

        Returns:
            依赖关系图 {kp_id: [prerequisite_ids]}
        """
        dependency_graph = {}

        for kp in knowledge_points:
            kp_id = kp.get("id", "")
            prerequisites = kp.get("prerequisites", [])

            # 将prerequisite名称映射到id
            prerequisite_ids = []
            for prereq in prerequisites:
                # 如果已经是id格式
                if prereq.startswith("kp_"):
                    prerequisite_ids.append(prereq)
                else:
                    # 尝试查找匹配的知识点
                    for other_kp in knowledge_points:
                        if prereq.lower() in other_kp.get("title", "").lower():
                            prerequisite_ids.append(other_kp.get("id", ""))
                            break

            dependency_graph[kp_id] = prerequisite_ids

        return dependency_graph

    def filter_by_importance(self, knowledge_points: List[Dict], min_importance: str = "medium") -> List[Dict]:
        """
        按重要性筛选知识点

        Args:
            knowledge_points: 知识点列表
            min_importance: 最低重要性（low/medium/high）

        Returns:
            筛选后的知识点
        """
        importance_levels = {"low": 1, "medium": 2, "high": 3}
        min_level = importance_levels.get(min_importance, 2)

        filtered = [
            kp for kp in knowledge_points
            if importance_levels.get(kp.get("importance", "medium"), 2) >= min_level
        ]

        logger.info(f"Filtered knowledge points: {len(filtered)}/{len(knowledge_points)} (importance >= {min_importance})")
        return filtered

    def organize_by_difficulty(self, knowledge_points: List[Dict]) -> Dict[str, List[Dict]]:
        """
        按难度组织知识点

        Args:
            knowledge_points: 知识点列表

        Returns:
            按难度分组的知识点 {difficulty: [kps]}
        """
        organized = {
            "basic": [],
            "intermediate": [],
            "advanced": []
        }

        for kp in knowledge_points:
            difficulty = kp.get("difficulty", "intermediate")
            if difficulty in organized:
                organized[difficulty].append(kp)

        return organized
