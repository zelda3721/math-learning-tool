"""
Anthropic Skills 风格的技能加载器

这个模块实现了类似 Anthropic Skills 的声明式技能系统：
1. 技能定义在独立的 Markdown 文件中
2. 通过 prompt 注入的方式工作
3. LLM 可以根据技能描述决定何时使用
4. 支持参数化和模板替换
"""
import os
import re
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class Skill:
    """单个技能的表示"""

    def __init__(self, name: str, filepath: str):
        """
        初始化技能

        Args:
            name: 技能名称
            filepath: Markdown文件路径
        """
        self.name = name
        self.filepath = filepath
        self.content = ""
        self.description = ""
        self.when_to_use = ""
        self.parameters = {}
        self.code_template = ""

        self._load()

    def _load(self):
        """从Markdown文件加载技能内容"""
        try:
            with open(self.filepath, 'r', encoding='utf-8') as f:
                self.content = f.read()

            # 解析描述
            desc_match = re.search(r'## 描述\s*\n(.*?)(?=\n##|\Z)', self.content, re.DOTALL)
            if desc_match:
                self.description = desc_match.group(1).strip()

            # 解析何时使用
            when_match = re.search(r'## 何时使用\s*\n(.*?)(?=\n##|\Z)', self.content, re.DOTALL)
            if when_match:
                self.when_to_use = when_match.group(1).strip()

            # 提取代码模板
            code_blocks = re.findall(r'```python\s*\n(.*?)\n```', self.content, re.DOTALL)
            if code_blocks:
                self.code_template = '\n\n'.join(code_blocks)

            # 提取参数说明
            params_match = re.search(r'## 参数说明\s*\n(.*?)(?=\n##|\Z)', self.content, re.DOTALL)
            if params_match:
                params_text = params_match.group(1)
                # 解析参数：- `{name}`: 描述
                param_lines = re.findall(r'-\s*`\{(\w+)\}`:\s*(.*)', params_text)
                for param_name, param_desc in param_lines:
                    self.parameters[param_name] = param_desc.strip()

            logger.info(f"技能加载成功: {self.name} ({len(self.parameters)} 个参数)")

        except Exception as e:
            logger.error(f"加载技能失败 {self.name}: {e}")
            raise

    def get_prompt(self, include_code: bool = True) -> str:
        """
        获取技能的 prompt 内容

        Args:
            include_code: 是否包含代码模板

        Returns:
            Prompt 文本
        """
        if include_code:
            return self.content
        else:
            # 移除代码块，只保留说明
            content_without_code = re.sub(r'```python.*?```', '', self.content, flags=re.DOTALL)
            return content_without_code

    def render(self, **params) -> str:
        """
        渲染技能（替换参数）

        Args:
            **params: 参数值

        Returns:
            渲染后的代码
        """
        rendered = self.code_template

        # 替换所有参数
        for param_name, param_value in params.items():
            placeholder = f"{{{param_name}}}"
            rendered = rendered.replace(placeholder, str(param_value))

        # 检查是否还有未替换的参数
        remaining = re.findall(r'\{(\w+)\}', rendered)
        if remaining:
            logger.warning(f"技能 {self.name} 有未替换的参数: {remaining}")

        return rendered

    def match_score(self, problem_text: str, step_data: Optional[Dict] = None) -> float:
        """
        计算技能与问题的匹配度

        Args:
            problem_text: 题目文本
            step_data: 步骤数据

        Returns:
            匹配分数 (0-1)
        """
        score = 0.0

        # 提取"何时使用"中的关键词
        keywords = re.findall(r'[""]([^""]+)[""]', self.when_to_use)

        # 在题目和步骤中搜索关键词
        search_text = problem_text
        if step_data:
            search_text += " " + step_data.get("步骤说明", "") + " " + step_data.get("具体操作", "")

        # 计算匹配的关键词数量
        matches = sum(1 for kw in keywords if kw in search_text)

        if keywords:
            score = matches / len(keywords)

        return score


class SkillLoader:
    """技能加载器 - 类似 Anthropic Skills"""

    def __init__(self, skills_dir: Optional[str] = None):
        """
        初始化技能加载器

        Args:
            skills_dir: 技能目录路径（包含 .md 文件）
        """
        if skills_dir is None:
            # 默认使用 skills/prompts 目录
            current_dir = Path(__file__).parent
            skills_dir = current_dir / "prompts"

        self.skills_dir = Path(skills_dir)
        self.skills: Dict[str, Skill] = {}

        self._load_all_skills()

    def _load_all_skills(self):
        """加载所有技能"""
        if not self.skills_dir.exists():
            logger.warning(f"技能目录不存在: {self.skills_dir}")
            return

        # 查找所有 .md 文件
        md_files = list(self.skills_dir.glob("*.md"))

        logger.info(f"发现 {len(md_files)} 个技能文件")

        for md_file in md_files:
            skill_name = md_file.stem
            try:
                skill = Skill(name=skill_name, filepath=str(md_file))
                self.skills[skill_name] = skill
                logger.info(f"✓ 加载技能: {skill_name}")
            except Exception as e:
                logger.error(f"✗ 加载技能失败 {skill_name}: {e}")

        logger.info(f"技能加载器初始化完成，共 {len(self.skills)} 个技能")

    def get_skill(self, name: str) -> Optional[Skill]:
        """
        获取技能

        Args:
            name: 技能名称

        Returns:
            技能对象，如果不存在则返回 None
        """
        return self.skills.get(name)

    def list_skills(self) -> List[str]:
        """列出所有可用技能"""
        return list(self.skills.keys())

    def find_best_skill(
        self,
        problem_text: str,
        step_data: Optional[Dict] = None,
        threshold: float = 0.3
    ) -> Optional[Tuple[str, float]]:
        """
        找到最匹配的技能

        Args:
            problem_text: 题目文本
            step_data: 步骤数据
            threshold: 最低匹配阈值

        Returns:
            (技能名称, 匹配分数) 或 None
        """
        best_skill = None
        best_score = 0.0

        for skill_name, skill in self.skills.items():
            score = skill.match_score(problem_text, step_data)
            if score > best_score:
                best_score = score
                best_skill = skill_name

        if best_score >= threshold:
            logger.info(f"找到匹配技能: {best_skill} (分数: {best_score:.2f})")
            return (best_skill, best_score)
        else:
            logger.info(f"未找到匹配技能 (最高分数: {best_score:.2f} < {threshold})")
            return None

    def get_skills_catalog(self) -> str:
        """
        获取技能目录（用于LLM选择）

        Returns:
            技能目录的文本描述
        """
        catalog = ["# 可用的可视化技能\n"]

        for skill_name, skill in self.skills.items():
            catalog.append(f"## {skill_name}")
            catalog.append(f"**描述**: {skill.description}")
            catalog.append(f"**何时使用**: {skill.when_to_use}")

            if skill.parameters:
                params_list = ", ".join(f"`{p}`" for p in skill.parameters.keys())
                catalog.append(f"**参数**: {params_list}")

            catalog.append("")

        return "\n".join(catalog)

    def create_skill_selection_prompt(
        self,
        problem_text: str,
        step_data: Optional[Dict] = None
    ) -> str:
        """
        创建技能选择提示词（给LLM用）

        Args:
            problem_text: 题目文本
            step_data: 步骤数据

        Returns:
            Prompt 文本
        """
        prompt = f"""你是一个数学可视化专家。请根据题目和解题步骤，选择最合适的可视化技能。

**题目**: {problem_text}

"""

        if step_data:
            prompt += f"""**当前步骤**:
- 说明: {step_data.get('步骤说明', '')}
- 操作: {step_data.get('具体操作', '')}
- 结果: {step_data.get('结果', '')}

"""

        prompt += self.get_skills_catalog()

        prompt += """

**请选择最合适的技能，并提供参数值。**

输出格式：
```json
{
  "skill": "技能名称（如 addition, subtraction, multiplication）",
  "parameters": {
    "param1": value1,
    "param2": value2
  },
  "reason": "选择原因"
}
```

只输出JSON，无其他文字。"""

        return prompt


# 全局技能加载器实例
skill_loader = SkillLoader()
