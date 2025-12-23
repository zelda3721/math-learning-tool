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
            # 默认使用 skills/definitions 目录（新架构）
            current_dir = Path(__file__).parent
            skills_dir = current_dir / "definitions"
            
            # 如果新目录不存在，回退到旧目录（兼容）
            if not skills_dir.exists():
                skills_dir = current_dir / "prompts"

        self.skills_dir = Path(skills_dir)
        self.skills: Dict[str, Skill] = {}

        self._load_all_skills()

    def _load_all_skills(self):
        """加载所有技能（递归加载子目录）"""
        if not self.skills_dir.exists():
            logger.warning(f"技能目录不存在: {self.skills_dir}")
            return

        # 递归查找所有 .md 文件（包括子目录）
        md_files = list(self.skills_dir.glob("**/*.md"))

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

    def get_system_skill(self, name: str) -> Optional[str]:
        """
        获取系统级技能的prompt内容（如reasoning）
        
        Args:
            name: 技能名称
            
        Returns:
            技能的完整prompt内容，用于注入到Agent系统提示词中
        """
        skill = self.get_skill(name)
        if skill:
            return skill.get_prompt(include_code=False)
        return None

    def get_agent_prompt(self, agent_name: str) -> str:
        """
        获取Agent的系统提示词
        
        Args:
            agent_name: Agent名称 (understanding, solving, debugging, review)
            
        Returns:
            Agent的系统提示词内容
        """
        skill = self.get_skill(agent_name)
        if skill:
            # 提取系统提示词部分（从角色定义开始到输出格式结束）
            content = skill.content
            
            # 构建完整的系统提示词
            prompt_parts = []
            
            # 提取角色定义
            if "## 角色定义" in content:
                role_match = re.search(r'## 角色定义\s*\n(.*?)(?=\n##|$)', content, re.DOTALL)
                if role_match:
                    prompt_parts.append(role_match.group(1).strip())
            
            # 提取核心任务
            if "## 核心任务" in content:
                task_match = re.search(r'## 核心任务\s*\n(.*?)(?=\n##|$)', content, re.DOTALL)
                if task_match:
                    prompt_parts.append(f"\n**核心任务**：{task_match.group(1).strip()}")
            
            # 提取其他部分（分析维度/解题原则等）
            for section in ["## 分析维度", "## 解题原则", "## 调试原则", "## 审查维度"]:
                if section in content:
                    section_match = re.search(f'{section}\\s*\\n(.*?)(?=\\n##|$)', content, re.DOTALL)
                    if section_match:
                        prompt_parts.append(f"\n{section.replace('## ', '**')}**：\n{section_match.group(1).strip()}")
            
            # 提取输出格式
            if "## 输出格式" in content:
                format_match = re.search(r'## 输出格式\s*\n(.*?)(?=\n##|$)', content, re.DOTALL)
                if format_match:
                    prompt_parts.append(f"\n**输出格式**：\n{format_match.group(1).strip()}")
            
            if prompt_parts:
                return "\n".join(prompt_parts)
            
            # 如果无法解析，返回完整内容
            return content
        
        logger.warning(f"未找到Agent技能: {agent_name}")
        return ""
    
    def get_reasoning_principles(self) -> str:
        """
        获取推理规划原则（从reasoning skill提取核心原则）
        
        Returns:
            推理原则的精简版本，适合注入到系统提示词
        """
        reasoning_skill = self.get_skill('reasoning')
        if reasoning_skill:
            # 提取核心原则部分
            content = reasoning_skill.content
            # 查找"核心推理原则"部分
            if "## 核心推理原则" in content:
                start = content.find("## 核心推理原则")
                end = content.find("## 应用于可视化", start)
                if end == -1:
                    end = len(content)
                return content[start:end].strip()
        
        # 降级：返回基本原则
        return """
## 核心推理原则
1. 分析约束条件：先检查规则和限制
2. 评估风险：考虑操作的潜在问题
3. 规划操作顺序：确保步骤间逻辑连贯
4. 持续验证：根据结果调整策略
"""

    def get_visualization_skills(self, exclude_system: bool = True) -> Dict[str, 'Skill']:
        """
        获取所有可视化技能（排除系统级技能）
        
        Args:
            exclude_system: 是否排除系统级技能（reasoning, quality_validator, animation_guidelines）
            
        Returns:
            可视化技能字典
        """
        system_skills = {'reasoning', 'quality_validator', 'animation_guidelines'}
        
        if exclude_system:
            return {k: v for k, v in self.skills.items() if k not in system_skills}
        return self.skills

    def get_animation_guidelines(self) -> str:
        """
        获取动画增强指南（核心部分）
        
        Returns:
            动画指南的核心原则，用于注入到系统提示词
        """
        guidelines_skill = self.get_skill('animation_guidelines')
        if guidelines_skill:
            content = guidelines_skill.content
            
            # 提取核心动画原则部分
            result = []
            
            # 提取缓动函数说明
            if "### 1.1 缓动函数" in content:
                start = content.find("### 1.1 缓动函数")
                end = content.find("### 1.2", start)
                if end != -1:
                    result.append(content[start:end].strip())
            
            # 提取错开动画说明
            if "### 1.3 错开动画" in content:
                start = content.find("### 1.3 错开动画")
                end = content.find("### 1.4", start)
                if end != -1:
                    result.append(content[start:end].strip())
            
            # 提取循序渐进说明
            if "### 2.1 循序渐进" in content:
                start = content.find("### 2.1 循序渐进")
                end = content.find("### 2.2", start)
                if end != -1:
                    result.append(content[start:end].strip())
            
            if result:
                return "\n\n".join(result)
        
        # 降级：返回基本动画原则
        return """
## 动画增强原则
1. 使用缓动函数: self.play(Write(text), rate_func=smooth)
2. 错开出现: LaggedStart(*animations, lag_ratio=0.15)
3. 适当等待: self.wait(1.5) 给学生理解时间
4. 循序渐进: 一次展示一个概念
"""

    def detect_problem_type(self, problem_text: str) -> List[str]:
        """
        检测题目类型，返回可能匹配的技能列表（按优先级排序）
        
        Args:
            problem_text: 题目文本
            
        Returns:
            匹配的技能名称列表
        """
        matches = []
        
        # 定义关键词到技能的映射（带权重）
        keyword_skill_map = {
            # ===== 奥数专题（高优先级）=====
            # 鸡兔同笼
            'chicken_rabbit': {
                'keywords': ['鸡', '兔', '头', '脚', '腿', '只脚', '同笼'],
                'weight': 2.0,  # 最高优先级
                'min_match': 2
            },
            # 行程相遇
            'travel_meeting': {
                'keywords': ['相遇', '相向', '迎面', '面对面', '同时出发', '相距'],
                'weight': 1.8,
                'min_match': 1
            },
            # 行程追及
            'travel_chasing': {
                'keywords': ['追及', '追上', '同向', '超过', '落后', '追赶'],
                'weight': 1.8,
                'min_match': 1
            },
            # 和差问题
            'sum_difference': {
                'keywords': ['和是', '差是', '两数之和', '两数之差', '大数', '小数'],
                'weight': 1.7,
                'min_match': 2
            },
            # 倍数问题
            'multiple_relation': {
                'keywords': ['是...的几倍', '倍', '几倍', '多少倍'],
                'weight': 1.6,
                'min_match': 1
            },
            # 植树问题
            'tree_planting': {
                'keywords': ['植树', '路灯', '电线杆', '间隔', '两端', '棵'],
                'weight': 1.7,
                'min_match': 2
            },
            # 找规律
            'pattern_finding': {
                'keywords': ['规律', '数列', '第几个', '接下来', '下一个', '...'],
                'weight': 1.5,
                'min_match': 1
            },
            # 巧求周长
            'perimeter_trick': {
                'keywords': ['周长', '不规则', '台阶', '凹凸', '拼接'],
                'weight': 1.6,
                'min_match': 2
            },
            # 等积变形
            'area_transform': {
                'keywords': ['等积', '割补', '剪拼', '变形', '面积不变'],
                'weight': 1.6,
                'min_match': 2
            },
            
            # ===== 基础运算（中优先级）=====
            # 连续运算
            'continuous_operation': {
                'keywords': ['先', '再', '然后', '又', '接着', '之后'],
                'weight': 1.5,
                'min_match': 1
            },
            # 几何题
            'geometry': {
                'keywords': ['长方形', '正方形', '三角形', '圆', '周长', '面积', '半径', '直径', '厘米', '平方'],
                'weight': 1.2,
                'min_match': 2
            },
            # 复杂应用题
            'word_problem': {
                'keywords': ['一共', '共有', '相差', '多少', '几个', '比', '分给', '平均'],
                'weight': 1.0,
                'min_match': 2
            },
            # 除法
            'division': {
                'keywords': ['除', '÷', '平均分', '分成', '每份'],
                'weight': 1.1,
                'min_match': 1
            },
            # 乘法
            'multiplication': {
                'keywords': ['乘', '×', '每个', '组'],
                'weight': 1.1,
                'min_match': 1
            },
            # 比较
            'comparison': {
                'keywords': ['多', '少', '比', '相差', '大', '小'],
                'weight': 1.0,
                'min_match': 2
            },
            # 减法
            'subtraction': {
                'keywords': ['减', '-', '拿走', '吃掉', '用去', '少了', '剩'],
                'weight': 1.0,
                'min_match': 1
            },
            # 加法
            'addition': {
                'keywords': ['加', '+', '一共', '总共', '合', '又', '还有'],
                'weight': 1.0,
                'min_match': 1
            }
        }
        
        scores = []
        
        for skill_name, config in keyword_skill_map.items():
            match_count = sum(1 for kw in config['keywords'] if kw in problem_text)
            
            if match_count >= config['min_match']:
                score = match_count * config['weight']
                scores.append((skill_name, score))
        
        # 按分数排序
        scores.sort(key=lambda x: x[1], reverse=True)
        matches = [s[0] for s in scores]
        
        logger.info(f"题目类型检测结果: {matches}")
        return matches

    def get_combined_skills_prompt(self, skill_names: List[str]) -> str:
        """
        组合多个技能的prompt
        
        Args:
            skill_names: 技能名称列表
            
        Returns:
            组合后的prompt
        """
        prompts = []
        
        for name in skill_names:
            skill = self.get_skill(name)
            if skill:
                prompts.append(f"### {name.upper()} 技能\n{skill.get_prompt()}")
        
        if not prompts:
            return ""
        
        return "\n\n---\n\n".join(prompts)

    def validate_code_with_skill(self, code: str) -> dict:
        """
        使用quality_validator技能验证代码
        
        Args:
            code: Manim代码
            
        Returns:
            验证结果字典
        """
        import re
        
        issues = []
        suggestions = []
        score = 100
        
        # 1. 元素重叠检测
        if code.count('.move_to(ORIGIN)') > 2:
            issues.append({"type": "warning", "message": "多个元素都在ORIGIN，可能重叠"})
            score -= 5
        
        # 2. 场景切换检测
        fadeout_count = code.count('FadeOut')
        transform_count = code.count('Transform')
        write_count = code.count('Write')
        
        if fadeout_count > 5:
            issues.append({
                "type": "warning",
                "message": f"FadeOut使用过多({fadeout_count}次)，建议使用Transform保持连贯"
            })
            score -= 10
            suggestions.append("将FadeOut+Write替换为Transform")
        
        if write_count > 3 and transform_count == 0:
            issues.append({
                "type": "warning",
                "message": "缺少Transform，步骤间建议使用Transform而非重建元素"
            })
            score -= 5
        
        # 3. 中文字体检测
        text_calls = re.findall(r'Text\([^)]+\)', code)
        for text_call in text_calls:
            if 'font=' not in text_call or 'Noto Sans CJK' not in text_call:
                if any(ord(c) > 127 for c in text_call):  # 包含中文
                    issues.append({
                        "type": "error",
                        "message": f"Text缺少中文字体设置"
                    })
                    score -= 15
                    break
        
        # 4. 尺寸检测
        if 'VGroup' in code and '.scale(' not in code:
            issues.append({
                "type": "warning",
                "message": "VGroup未进行scale操作，可能超出屏幕边界"
            })
            score -= 5
            suggestions.append("对VGroup添加.scale(0.7)确保不超出边界")
        
        # 5. 语法检测
        try:
            compile(code, '<string>', 'exec')
        except SyntaxError as e:
            issues.append({
                "type": "error",
                "message": f"语法错误: {str(e)}",
                "line": e.lineno
            })
            score -= 30
        
        # 6. 必要元素检测
        if 'class' not in code or 'Scene' not in code:
            issues.append({
                "type": "error",
                "message": "代码缺少Scene类定义"
            })
            score -= 20
        
        if 'def construct' not in code:
            issues.append({
                "type": "error",
                "message": "代码缺少construct方法"
            })
            score -= 20
        
        return {
            "valid": score >= 60 and not any(i["type"] == "error" for i in issues),
            "score": max(0, score),
            "issues": issues,
            "suggestions": suggestions
        }


# 全局技能加载器实例
skill_loader = SkillLoader()
