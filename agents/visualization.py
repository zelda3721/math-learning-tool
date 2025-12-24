"""
可视化Agent V2 - 真正集成 Anthropic Skills 风格的技能系统

这个版本真正采用了 Anthropic Skills 的思想：
1. 技能定义在 Markdown 文件中（声明式）
2. LLM 通过 prompt 选择合适的技能
3. 技能通过参数化模板工作
4. 可以组合和链接技能
5. 注入推理规划原则增强决策质量
"""
import json
import logging
import re
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from skills.skill_loader import skill_loader

logger = logging.getLogger(__name__)


class VisualizationAgentV2WithSkills(BaseAgent):
    """可视化Agent V2 - 集成 Anthropic Skills + 推理规划"""

    def __init__(self, model: ChatOpenAI):
        """
        初始化可视化Agent V2

        Args:
            model: LLM模型实例
        """
        # 获取推理规划原则
        reasoning_principles = skill_loader.get_reasoning_principles()
        
        # 获取动画增强指南
        animation_guidelines = skill_loader.get_animation_guidelines()
        
        # 获取可视化Agent基础提示词
        base_prompt = skill_loader.get_agent_prompt('visualization')
        
        # 定义严格的代码规范
        code_guidelines = """
### 🛡️ 严格代码规范 (Critical)
1. **字体强制**: 所有Text/Tex必须指定 `font="Microsoft YaHei"` (Windows环境)。
   - ❌ `Text("你好")` -> 乱码
   - ✅ `Text("你好", font="Microsoft YaHei")`
2. **布局强制**: 
   - 严禁使用绝对坐标 (如 `move_to([2,3,0])`)。
   - 必须使用 `VGroup` + `.arrange()` + `.next_to()`。
3. **防Hallucination**:
   - ❌ 严禁使用不存在的颜色 (如 `ORANGE_E`)。只用: BLUE, RED, GREEN, YELLOW, ORANGE, PURPLE, WHITE, BLACK。
   - ❌ 严禁使用 `brace.get_text()` (内部调用TeX不支持中文)。
   - ✅ 使用 `Brace(obj, DOWN)` + `Text("标签").next_to(brace, DOWN)`。
4. **对象管理**:
   - 所有的Mobject必须在 `construct` 中创建。
   - 复杂图形必须组合成 `VGroup`。
"""

        # 构建增强的系统提示词
        enhanced_prompt = f"""
{base_prompt}

---

{code_guidelines}

---

## 推理规划框架

在生成任何代码之前，请先进行以下推理：

{reasoning_principles}

---

## 动画质量要求（非常重要！）

生成的动画必须遵循以下原则，以确保视频质量和易于学生理解：

{animation_guidelines}

### 关键动画规则
1. **永远使用缓动函数**: `self.play(Write(text), rate_func=smooth)`
2. **元素错开出现**: `LaggedStart(*[FadeIn(x) for x in items], lag_ratio=0.15)`
3. **适当等待时间**: 题目后 `wait(2)`，步骤间 `wait(1.5)`，结果后 `wait(3)`
4. **循序渐进**: 一次只展示一个概念，不要同时显示太多内容
5. **视觉引导**: 用颜色变化、高亮、放大等引导学生注意力
6. **数形结合**: 每个图形元素对应具体数量，让学生能数

---

## 可用技能库

当前加载的技能数量: {len(skill_loader.list_skills())}
可用技能: {', '.join(skill_loader.list_skills())}

请根据题目类型选择合适的技能，并遵循技能中的代码模板。
"""
        
        super().__init__(
            name="可视化Agent V2 (Skills + Reasoning)",
            description="基于 Anthropic Skills 风格 + 推理规划的可视化Agent",
            system_prompt=enhanced_prompt,
            model=model
        )
        
        # 缓存检测到的题目类型
        self._detected_skills = []
        
        logger.info(f"可视化Agent V2 (Skills + Reasoning) 初始化完成，加载了 {len(skill_loader.list_skills())} 个技能")

    async def generate_visualization_code(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any],
        is_retry: bool = False,
        error_message: str = ""
    ) -> str:
        """
        生成Manim可视化代码（使用 Anthropic Skills 方式 + 推理规划）

        增强流程：
        1. 检测题目类型，确定可用技能
        2. 分析每个解题步骤
        3. 根据题目类型优先选择技能
        4. 提取参数并渲染技能模板
        5. 组装成完整代码
        6. 验证代码质量

        Args:
            problem_text: 题目文本
            analysis_result: 理解Agent的分析结果
            solution_result: 解题Agent的解题结果
            is_retry: 是否是重试
            error_message: 错误信息

        Returns:
            Manim可视化代码
        """
        logger.info("[Skills + Reasoning模式] 开始生成可视化代码")

        try:
            # 1. 检测题目类型
            self._detected_skills = skill_loader.detect_problem_type(problem_text)
            logger.info(f"题目类型检测: {self._detected_skills}")
            
            # 2. 检查是否是连续运算题目
            is_continuous = 'continuous_operation' in self._detected_skills
            if is_continuous:
                logger.info("检测到连续运算题目，将使用continuous_operation技能")
            
            # 3. 检查是否是几何题
            is_geometry = 'geometry' in self._detected_skills
            if is_geometry:
                logger.info("检测到几何题，将使用geometry技能")
            
            # 4. 检查是否是复杂应用题
            is_word_problem = 'word_problem' in self._detected_skills and len(problem_text) > 50
            if is_word_problem:
                logger.info("检测到复杂应用题，将使用word_problem技能")

            steps = solution_result.get("详细步骤", [])

            # 如果没有步骤，使用降级方案
            if not steps:
                logger.warning("没有解题步骤，使用简单可视化")
                return self._create_simple_visualization(problem_text, solution_result)

            # 构建代码框架
            code_parts = [
                "from manim import *\n\n",
                "class MathVisualization(Scene):\n",
                "    def construct(self):\n"
            ]

            # 显示题目
            code_parts.append(self._generate_problem_display(problem_text))

            # 根据题目类型选择处理策略
            if is_continuous and len(steps) > 1:
                # 连续运算：使用continuous_operation技能
                step_code = await self._generate_continuous_operation(
                    problem_text, steps, solution_result
                )
                if step_code:
                    code_parts.append(step_code)
            elif is_geometry:
                # 几何题：使用geometry技能  
                step_code = await self._generate_geometry_visualization(
                    problem_text, analysis_result, solution_result
                )
                if step_code:
                    code_parts.append(step_code)
            elif is_word_problem:
                # 复杂应用题：使用word_problem技能
                step_code = await self._generate_word_problem_visualization(
                    problem_text, analysis_result, solution_result
                )
                if step_code:
                    code_parts.append(step_code)
            else:
                # 默认：逐步处理
                for i, step in enumerate(steps[:5], 1):
                    logger.info(f"处理步骤 {i}: {step.get('步骤说明', '')[:30]}...")

                    # 添加步骤之间的过渡 (清除上一步的元素)
                    if i > 1:
                        code_parts.append('''
        # ===== 场景过渡：清除上一步内容 =====
        self.play(*[FadeOut(mob) for mob in self.mobjects], run_time=0.5)
        self.wait(0.3)
''')

                    # 使用检测到的技能优先匹配
                    step_code = await self._match_and_use_skill(
                        problem_text, step, i, self._detected_skills
                    )
                    if step_code:
                        code_parts.append(step_code)
                    else:
                        # 降级到通用步骤
                        step_code = await self._generate_generic_step(step, i, problem_text)
                        code_parts.append(step_code)

            # 显示最终答案
            final_answer = solution_result.get("最终答案", "未知")
            code_parts.append(self._generate_answer_display(final_answer))

            # 组装代码
            full_code = "".join(code_parts)

            logger.info("[Skills模式] 代码生成完成")
            return full_code

        except Exception as e:
            logger.error(f"[Skills模式] 生成代码时出错: {e}", exc_info=True)
            # 降级方案
            return self._create_simple_visualization(problem_text, solution_result)

    async def _use_skill_for_step(
        self,
        skill_name: str,
        step_data: Dict[str, Any],
        problem_text: str,
        step_number: int
    ) -> Optional[str]:
        """
        使用指定技能渲染步骤

        Args:
            skill_name: 技能名称
            step_data: 步骤数据
            problem_text: 题目文本
            step_number: 步骤编号

        Returns:
            渲染后的代码，失败返回None
        """
        skill = skill_loader.get_skill(skill_name)
        if not skill:
            logger.warning(f"技能不存在: {skill_name}")
            return None

        # 从步骤中提取参数
        params = await self._extract_parameters_from_step(step_data, skill.parameters, problem_text=problem_text)

        if not params:
            logger.debug(f"无法从步骤中提取参数，将使用LLM直接生成")
            return None

        # 渲染技能模板
        try:
            rendered_code = skill.render(**params)

            # 添加缩进
            lines = rendered_code.split('\n')
            indented_lines = ['        ' + line if line.strip() else '' for line in lines]

            code = '\n'.join([
                f"\n        # ===== 步骤 {step_number}: {step_data.get('步骤说明', '')} =====",
                f"        # 使用技能: {skill_name}",
                *indented_lines,
                "        self.wait(1)\n"
            ])

            logger.info(f"✓ 技能 {skill_name} 渲染成功")
            return code

        except Exception as e:
            logger.error(f"技能 {skill_name} 渲染失败: {e}")
            return None

    async def _llm_select_skill_for_step(
        self,
        step_data: Dict[str, Any],
        problem_text: str,
        step_number: int
    ) -> Optional[str]:
        """
        让LLM选择合适的技能

        Args:
            step_data: 步骤数据
            problem_text: 题目文本
            step_number: 步骤编号

        Returns:
            渲染后的代码，失败返回None
        """
        # 创建技能选择prompt
        prompt = skill_loader.create_skill_selection_prompt(problem_text, step_data)

        try:
            # 调用LLM
            response = await self.arun(prompt)
            logger.info(f"LLM响应: {response[:100]}...")

            # 解析响应
            selection = self._parse_skill_selection(response)

            if not selection:
                logger.warning("LLM未能选择技能")
                return None

            skill_name = selection.get("skill")
            parameters = selection.get("parameters", {})
            reason = selection.get("reason", "")

            logger.info(f"LLM选择技能: {skill_name}, 原因: {reason}")

            # 使用选择的技能
            skill = skill_loader.get_skill(skill_name)
            if not skill:
                logger.warning(f"LLM选择的技能不存在: {skill_name}")
                return None

            # 渲染技能
            rendered_code = skill.render(**parameters)

            # 添加缩进和注释
            lines = rendered_code.split('\n')
            indented_lines = ['        ' + line if line.strip() else '' for line in lines]

            code = '\n'.join([
                f"\n        # ===== 步骤 {step_number}: {step_data.get('步骤说明', '')} =====",
                f"        # LLM选择技能: {skill_name} - {reason}",
                *indented_lines,
                "        self.wait(1)\n"
            ])

            logger.info(f"✓ LLM选择的技能 {skill_name} 渲染成功")
            return code

        except Exception as e:
            logger.error(f"LLM选择技能失败: {e}")
            return None

    async def _extract_parameters_from_step(
        self,
        step_data: Dict[str, Any],
        required_params: Dict[str, str],
        problem_text: str = ""
    ) -> Optional[Dict[str, Any]]:
        """
        从步骤数据中提取参数 (Regex + LLM Fallback)
        """
        import re
        import json
        
        # 1. 尝试 Regex 提取 (Fast path)
        text = str(step_data.get("具体操作", "")) + " " + str(step_data.get("结果", ""))
        numbers = re.findall(r'\d+', text)
        params = {}

        # 根据需要的参数类型提取
        if "num1" in required_params and "num2" in required_params:
            # 加法：需要两个数
            if len(numbers) >= 2:
                params["num1"] = int(numbers[0])
                params["num2"] = int(numbers[1])
                if len(numbers) >= 3:
                    params["result"] = int(numbers[2])
                else:
                    params["result"] = params["num1"] + params["num2"]

        elif "minuend" in required_params and "subtrahend" in required_params:
            # 减法：被减数和减数
            if len(numbers) >= 2:
                params["minuend"] = int(numbers[0])
                params["subtrahend"] = int(numbers[1])
                if len(numbers) >= 3:
                    params["result"] = int(numbers[2])
                else:
                    params["result"] = params["minuend"] - params["subtrahend"]

        elif "multiplier" in required_params and "multiplicand" in required_params:
            # 乘法：乘数和被乘数
            if len(numbers) >= 2:
                params["multiplier"] = int(numbers[0])
                params["multiplicand"] = int(numbers[1])
                if len(numbers) >= 3:
                    params["result"] = int(numbers[2])
                else:
                    params["result"] = params["multiplier"] * params["multiplicand"]

        # 检查是否提取到所有必需参数
        if all(param in params for param in required_params.keys()):
            logger.info(f"Regex成功提取参数: {params}")
            return params
            
        # 2. LLM 提取 (Robust path)
        logger.info(f"Regex提取失败，尝试LLM提取参数: {list(required_params.keys())}")
        
        prompt = f"""
请从以下解题步骤中提取可视化参数。

## 题目
{problem_text}

## 步骤信息
- 说明: {step_data.get('步骤说明', '')}
- 详情: {step_data.get('具体操作', '')}
- 结果: {step_data.get('结果', '')}

## 目标参数
请提取以下参数 (JSON格式):
{json.dumps(required_params, ensure_ascii=False, indent=2)}

## 要求
1. 只返回JSON对象，不要Markdown格式。
2. 必须包含所有目标参数。
3. 如果无法找到对应数值，请根据题目逻辑推断。

## 示例返回
{{
  "num1": 10,
  "num2": 5,
  "name1": "小明",
  "name2": "小红",
  "result": 15
}}
"""
        try:
            response = await self.arun(prompt)
            data = self._parse_skill_selection(response) # 复用解析JSON的方法
            if data and all(k in data for k in required_params.keys()):
                logger.info(f"LLM成功提取参数: {data}")
                return data
        except Exception as e:
            logger.error(f"LLM参数提取失败: {e}")
            
        return None

    def _parse_skill_selection(self, response: str) -> Optional[Dict[str, Any]]:
        """
        解析LLM的技能选择响应

        Args:
            response: LLM响应

        Returns:
            解析结果，失败返回None
        """
        try:
            # 提取JSON
            if "```json" in response:
                json_start = response.find("```json") + 7
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            elif "```" in response:
                json_start = response.find("```") + 3
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            else:
                json_str = response.strip()

            data = json.loads(json_str)
            return data

        except Exception as e:
            logger.error(f"解析技能选择失败: {e}")
            return None

    def _generate_problem_display(self, problem_text: str) -> str:
        """生成题目显示代码 - 支持长文本换行和淡出"""
        # 处理长文本：每20个字符换行
        safe_text = problem_text.replace('"', '\\"').replace('\n', '\\n')
        max_chars_per_line = 25
        lines = []
        for i in range(0, len(safe_text), max_chars_per_line):
            lines.append(safe_text[i:i+max_chars_per_line])
        wrapped_text = '\\n'.join(lines[:4])  # 最多4行
        
        return f'''
        # 显示题目 (自动换行，显示后淡出)
        problem = Text("{wrapped_text}", font="Microsoft YaHei", font_size=28, line_spacing=0.8)
        problem.to_edge(UP, buff=0.5)
        problem.scale_to_fit_width(config.frame_width - 1.5)  # 确保不超出边界
        
        self.play(Write(problem), run_time=2)
        self.wait(2)
        
        # 淡出题目，为后续步骤腾出空间
        self.play(FadeOut(problem), run_time=0.5)
        self.wait(0.3)

'''

    def _generate_answer_display(self, answer: str) -> str:
        """生成答案显示代码"""
        safe_answer = str(answer).replace('"', '\\"')
        return f'''
        # 显示最终答案
        answer_title = Text("答案", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
        answer_title.to_edge(UP, buff=1.0)
        final_answer = Text("{safe_answer}", font="Noto Sans CJK SC", font_size=48, color=GREEN)
        final_answer.move_to(ORIGIN)

        self.play(Write(answer_title))
        self.play(Write(final_answer))
        self.wait(3)

        # 结束
        end_text = Text("谢谢观看", font="Noto Sans CJK SC", font_size=40)
        self.play(FadeOut(answer_title), FadeOut(final_answer), FadeOut(problem))
        self.wait(0.5)
        self.play(Write(end_text))
        self.wait(2)
'''

    async def _generate_generic_step(self, step_data: Dict[str, Any], step_number: int, problem_text: str = "") -> str:
        """
        生成通用步骤可视化代码 - 使用LLM生成图形化代码
        """
        desc = step_data.get("步骤说明", f"步骤{step_number}")
        detail = step_data.get("具体操作", "")
        result = str(step_data.get("结果", ""))
        
        prompt = f"""请为这个解题步骤生成Manim可视化代码。

## 题目
{problem_text}

## 当前步骤
- 说明: {desc}
- 详情: {detail}
- 结果: {result}

## 核心要求 (Must Follow)
1. **彻底拒绝纯文字**: 严禁只显示Text! 必须把数字/概念转化为图形。
2. **单位 visualization**:
   - 如果数字代表数量，使用 **小矩形(Unit Bar)** 代表"1份"或"1个单位"。
   - 例如: "A是B的3倍" -> 画1个蓝色矩形代表B，3个绿色矩形排成一行代表A。
   - 不要画几百个圆点，使用长条(Rectangle)代表大数值。
3. **布局规范**:
   - 所有的图形元素必须放入 `VGroup`，并使用 `.arrange(RIGHT, buff=0.1)` 等方法自动排列。
   - 必须使用 `.next_to()` 进行相对定位，禁止硬编码坐标。
   - 标题放顶部 (`.to_edge(UP)`), 结果放底部 (`.to_edge(DOWN)`), 图形居中。
4. **动态演示**:
   - 使用 `ReplacementTransform` 展示变化 (例如: 短线段 -> 长线段)。
   - 涉及比较时，使用 `Brace` (大括号) 标注数值。

### 🛡️ 严格代码规范 (Critical)
1. **字体强制**: 所有Text/Tex必须指定 `font="Microsoft YaHei"` (Windows环境)。
   - ❌ `Text("你好")` -> 乱码
   - ✅ `Text("你好", font="Microsoft YaHei")`
2. **布局强制**: 
   - 严禁使用 absolute coordinates (如 `[3, 2, 0]`)。
   - 必须使用 `VGroup` + `.arrange()`。
3. **防Hallucination**: 
   - 严禁使用 `brace.get_text()` (内部调用TeX不支持中文)。
   - 严禁使用 `ORANGE_E` 等非标准颜色。

## 代码模板
```python
# 示例: 3倍关系
unit = Square(side_length=1).set_fill(BLUE, opacity=0.5)
group_b = VGroup(unit.copy()).arrange(RIGHT) # B (1份)
group_a = VGroup(*[unit.copy().set_fill(GREEN, 0.5) for _ in range(3)]).arrange(RIGHT) # A (3份)

group_all = VGroup(group_b, group_a).arrange(DOWN, buff=1, aligned_edge=LEFT)
self.play(Create(group_all))
```

只输出代码片段，假设已在construct中，不要包含类定义。
"""
        try:
            # 尝试调用LLM生成
            response = await self.arun(prompt)
            code = self._extract_code(response)
            if code:
                return '\n' + code + '\n'
        except Exception as e:
            logger.error(f"通用步骤LLM生成失败: {e}")
            
        # 最后的保底（文字版）
        return f'''
        # 步骤 {step_number} (保底)
        step_label = Text("{desc[:20]}", font="Noto Sans CJK SC", font_size=28)
        step_label.to_edge(UP, buff=1.0)
        self.play(Write(step_label))
        
        detail_text = Text("{detail[:30]}", font="Noto Sans CJK SC", font_size=24, color=BLUE)
        detail_text.next_to(step_label, DOWN, buff=0.5)
        self.play(FadeIn(detail_text))
        self.wait(2)

        self.play(FadeOut(step_label), FadeOut(detail_text))
'''

    async def _match_and_use_skill(
        self,
        problem_text: str,
        step_data: Dict[str, Any],
        step_number: int,
        priority_skills: List[str]
    ) -> Optional[str]:
        """
        根据优先技能列表匹配并使用技能
        
        Args:
            problem_text: 题目文本
            step_data: 步骤数据
            step_number: 步骤编号
            priority_skills: 优先使用的技能列表
            
        Returns:
            渲染后的代码，失败返回None
        """
        # 首先尝试优先技能
        for skill_name in priority_skills:
            skill = skill_loader.get_skill(skill_name)
            if skill and skill_name not in ['reasoning', 'quality_validator']:
                # 尝试提取参数
                params = await self._extract_parameters_from_step(step_data, skill.parameters, problem_text=problem_text)
                if params:
                    try:
                        rendered_code = skill.render(**params)
                        lines = rendered_code.split('\n')
                        indented_lines = ['        ' + line if line.strip() else '' for line in lines]
                        
                        code = '\n'.join([
                            f"\n        # ===== 步骤 {step_number}: {step_data.get('步骤说明', '')} =====",
                            f"        # 使用技能: {skill_name}",
                            *indented_lines,
                            "        self.wait(1)\n"
                        ])
                        
                        logger.info(f"✓ 优先技能 {skill_name} 渲染成功")
                        return code
                    except Exception as e:
                        logger.warning(f"优先技能 {skill_name} 渲染失败: {e}")
        
        # 然后尝试标准匹配
        best_match = skill_loader.find_best_skill(problem_text, step_data, threshold=0.3)
        if best_match:
            skill_name, score = best_match
            return await self._use_skill_for_step(skill_name, step_data, problem_text, step_number)
        
        return None

    async def _generate_continuous_operation(
        self,
        problem_text: str,
        steps: List[Dict[str, Any]],
        solution_result: Dict[str, Any]
    ) -> Optional[str]:
        """
        生成连续运算的可视化代码
        
        使用continuous_operation技能的核心原则:
        - 创建的VGroup贯穿始终
        - 使用Transform而非重建
        - 保持元素可见性连贯
        """
        # 提取数字信息
        numbers = re.findall(r'\d+', problem_text)
        
        if len(numbers) < 2:
            logger.warning("连续运算提取数字失败")
            return None
        
        initial = int(numbers[0])
        
        # 分析操作序列
        operations = []
        for i, step in enumerate(steps):
            step_text = step.get('步骤说明', '') + step.get('具体操作', '')
            step_numbers = re.findall(r'\d+', step_text)
            
            if '减' in step_text or '-' in step_text or '拿走' in step_text or '给' in step_text:
                if step_numbers:
                    operations.append(('subtract', int(step_numbers[0]), step.get('步骤说明', '')))
            elif '加' in step_text or '+' in step_text or '买' in step_text or '又' in step_text:
                if step_numbers:
                    operations.append(('add', int(step_numbers[0]), step.get('步骤说明', '')))
        
        # 获取最终结果
        result = solution_result.get('最终答案', '')
        result_numbers = re.findall(r'\d+', str(result))
        final_result = int(result_numbers[0]) if result_numbers else initial
        
        # 生成代码
        code = f'''
        # ===== 连续运算可视化 =====
        # 核心原则：在同一VGroup上连续操作
        
        # 创建初始元素组（这个VGroup将贯穿整个动画！）
        items = VGroup(*[Circle(radius=0.12, color=BLUE, fill_opacity=0.8) for _ in range({initial})])
        items.arrange_in_grid(rows=4, buff=0.1)
        items.scale(0.65).move_to(ORIGIN)
        
        # 初始标签
        step_label = Text("一共有{initial}个", font="Noto Sans CJK SC", font_size=26)
        step_label.to_edge(UP, buff=0.8)
        
        self.play(Write(step_label))
        self.play(LaggedStart(*[FadeIn(item) for item in items], lag_ratio=0.03))
        self.wait(2)
        
        current_count = {initial}
        current_items = items
'''
        
        # 为每个操作生成代码
        for i, (op_type, amount, desc) in enumerate(operations, 1):
            safe_desc = desc.replace('"', '\\"')[:30]
            
            if op_type == 'subtract':
                code += f'''
        # 操作{i}: 减少{amount}个
        step_label_{i} = Text("{safe_desc}", font="Noto Sans CJK SC", font_size=26, color=YELLOW)
        step_label_{i}.to_edge(UP, buff=0.8)
        self.play(Transform(step_label, step_label_{i}))
        self.wait(0.5)
        
        # 高亮要移除的元素
        if current_count >= {amount}:
            remove_items = current_items[:{amount}]
            self.play(remove_items.animate.set_color(RED))
            self.wait(0.5)
            self.play(remove_items.animate.shift(RIGHT * 4))
            self.wait(0.3)
            self.play(FadeOut(remove_items))
            current_count -= {amount}
            current_items = current_items[{amount}:]
            if len(current_items) > 0:
                self.play(current_items.animate.arrange_in_grid(rows=3, buff=0.1).move_to(ORIGIN))
        self.wait(1)
'''
            elif op_type == 'add':
                code += f'''
        # 操作{i}: 增加{amount}个
        step_label_{i} = Text("{safe_desc}", font="Noto Sans CJK SC", font_size=26, color=GREEN)
        step_label_{i}.to_edge(UP, buff=0.8)
        self.play(Transform(step_label, step_label_{i}))
        self.wait(0.5)
        
        # 新增元素从左侧进入
        new_items = VGroup(*[Circle(radius=0.12, color=GREEN, fill_opacity=0.8) for _ in range({amount})])
        new_items.arrange(RIGHT, buff=0.1)
        new_items.move_to(LEFT * 5)
        self.play(FadeIn(new_items))
        self.wait(0.3)
        self.play(new_items.animate.next_to(current_items, DOWN, buff=0.3))
        
        # 合并并统一颜色
        all_items = VGroup(current_items, new_items)
        self.play(
            all_items.animate.arrange_in_grid(rows=4, buff=0.1).move_to(ORIGIN),
            current_items.animate.set_color(BLUE),
            new_items.animate.set_color(BLUE)
        )
        current_count += {amount}
        current_items = all_items
        self.wait(1)
'''
        
        # 结束部分
        code += f'''
        # 显示最终结果
        final_label = Text("现在一共有{final_result}个", font="Noto Sans CJK SC", font_size=26, color=GREEN)
        final_label.to_edge(UP, buff=0.8)
        self.play(Transform(step_label, final_label))
        self.play(current_items.animate.set_color(GREEN))
        self.wait(2)
'''
        
        return code

    async def _generate_geometry_visualization(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any]
    ) -> Optional[str]:
        """
        生成几何题可视化代码
        """
        # 提取几何参数
        numbers = re.findall(r'(\d+)\s*厘米', problem_text)
        
        is_perimeter = '周长' in problem_text
        is_area = '面积' in problem_text
        
        # 确定图形类型
        if '长方形' in problem_text or '矩形' in problem_text:
            shape_type = 'rectangle'
        elif '正方形' in problem_text:
            shape_type = 'square'
        elif '三角形' in problem_text:
            shape_type = 'triangle'
        elif '圆' in problem_text:
            shape_type = 'circle'
        else:
            shape_type = 'rectangle'  # 默认
        
        # 获取答案
        answer = solution_result.get('最终答案', '')
        
        if shape_type == 'rectangle' and len(numbers) >= 2:
            length = int(numbers[0])
            width = int(numbers[1])
            
            code = f'''
        # ===== 几何可视化: 长方形 =====
        
        # 创建长方形
        rect = Rectangle(width={length} * 0.3, height={width} * 0.3, color=BLUE, fill_opacity=0.3)
        rect.scale(0.7).move_to(ORIGIN)
        
        # 标题
        title = Text("长方形的{'周长' if is_perimeter else '面积'}", font="Noto Sans CJK SC", font_size=32)
        title.to_edge(UP, buff=0.8)
        
        self.play(Write(title))
        self.play(Create(rect))
        self.wait(1)
        
        # 标注边长
        length_label = Text("{length}厘米", font="Noto Sans CJK SC", font_size=20)
        length_label.next_to(rect, DOWN, buff=0.2)
        
        width_label = Text("{width}厘米", font="Noto Sans CJK SC", font_size=20)
        width_label.next_to(rect, RIGHT, buff=0.2)
        
        self.play(Write(length_label), Write(width_label))
        self.wait(2)
        
        # 显示计算
        result = Text("{answer}", font="Noto Sans CJK SC", font_size=36, color=GREEN)
        result.to_edge(DOWN, buff=1.0)
        self.play(Write(result))
        self.wait(3)
'''
            return code
        
        # 其他图形类型的默认处理
        return None

    async def _generate_word_problem_visualization(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any]
    ) -> Optional[str]:
        """
        生成复杂应用题可视化代码 - 使用LLM生成真正的图形化代码
        """
        steps = solution_result.get('详细步骤', [])
        answer = solution_result.get('最终答案', '未知')
        
        # 构建提示让LLM生成图形化代码
        prompt = f"""请为这道数学题生成Manim代码的核心部分。

## 题目
{problem_text}

## 解题步骤
{json.dumps(steps[:3], ensure_ascii=False, indent=2)}

## 答案
{answer}

## 必须遵守的规则

### 1. 使用图形而非文字
- 用Line/Rectangle表示数量的线段图
- 用Circle/Dot表示具体物品
- 禁止只用Text显示解题过程

### 2. 线段图示例（倍数关系）
```python
# 乙校人数（基准）
line_b = Line(LEFT * 2, ORIGIN, color=BLUE, stroke_width=10)
label_b = Text("乙校", font="Noto Sans CJK SC", font_size=20)

# 甲校人数（3倍）
line_a = Line(LEFT * 2, RIGHT * 4, color=GREEN, stroke_width=10)
label_a = Text("甲校(3倍)", font="Noto Sans CJK SC", font_size=20)
```

### 3. 展示变化过程
用animate展示"减少100人"的变化

### 4. 布局（避免遮挡）
- **核心原则**：使用自动布局，少用绝对坐标
- 所有组合图形必须使用 `VGroup` 组织
- 使用 `.arrange(RIGHT, buff=0.5)` 自动排列
- 使用 `.next_to(target, DOWN, buff=0.5)` 相对定位
- 避免重叠：所有主视觉元素 `.scale(0.6)` 并放于中心

### 5. 动画（流畅切换）
- 优先使用 `ReplacementTransform` 进行场景变换
- 使用 `SurroundingRectangle` 进行高亮引导
- 使用 `LaggedStart` 错开展示多个元素
"""
        
        try:
            response = await self.arun(prompt)
            
            # 提取代码
            code = response
            if "```python" in code:
                code = code.split("```python")[1].split("```")[0]
            elif "```" in code:
                code = code.split("```")[1].split("```")[0]
            
            # 添加缩进
            lines = code.strip().split('\n')
            indented = '\n'.join('        ' + line if line.strip() else '' for line in lines)
            
            logger.info("[LLM模式] 生成图形化代码成功")
            return '\n' + indented + '\n'
            
        except Exception as e:
            logger.error(f"LLM生成失败: {e}")
            return self._fallback_text_visualization(steps, answer)
    
    def _extract_code(self, response: str) -> Optional[str]:
        """从LLM响应中提取Python代码"""
        if "```python" in response:
            return response.split("```python")[1].split("```")[0].strip()
        elif "```" in response:
            return response.split("```")[1].split("```")[0].strip()
        
        # 如果没有markdown标记但看起来像代码
        if "from manim import" in response or "self.play" in response:
            return response.strip()
            
        return None

    def _fallback_text_visualization(self, steps: list, answer: str) -> str:
        """文字降级版本"""
        code = ""
        for i, step in enumerate(steps[:3], 1):
            desc = step.get('步骤说明', f'步骤{i}')[:30].replace('"', '\\"')
            code += f'''
        step_{i} = Text("第{i}步: {desc}", font="Noto Sans CJK SC", font_size=24)
        step_{i}.to_edge(UP, buff=1.0)
        self.play(Write(step_{i}))
        self.wait(1.5)
        self.play(FadeOut(step_{i}))
'''
        return code

    def _create_simple_visualization(
        self,
        problem_text: str,
        solution_result: Dict[str, Any]
    ) -> str:
        """创建简单的降级可视化"""
        answer = solution_result.get("最终答案", "未知")

        return f"""from manim import *

class MathVisualization(Scene):
    def construct(self):
{self._generate_problem_display(problem_text)}
{self._generate_answer_display(answer)}
"""
