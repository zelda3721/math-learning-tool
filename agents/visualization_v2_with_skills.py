"""
可视化Agent V2 - 真正集成 Anthropic Skills 风格的技能系统

这个版本真正采用了 Anthropic Skills 的思想：
1. 技能定义在 Markdown 文件中（声明式）
2. LLM 通过 prompt 选择合适的技能
3. 技能通过参数化模板工作
4. 可以组合和链接技能
"""
import json
import logging
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from utils.prompts_optimized import VISUALIZATION_AGENT_V2_PROMPT
from skills.skill_loader import skill_loader

logger = logging.getLogger(__name__)


class VisualizationAgentV2WithSkills(BaseAgent):
    """可视化Agent V2 - 集成 Anthropic Skills"""

    def __init__(self, model: ChatOpenAI):
        """
        初始化可视化Agent V2

        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="可视化Agent V2 (Skills)",
            description="基于 Anthropic Skills 风格的可视化Agent",
            system_prompt=VISUALIZATION_AGENT_V2_PROMPT,
            model=model
        )
        logger.info(f"可视化Agent V2 (Skills) 初始化完成，加载了 {len(skill_loader.list_skills())} 个技能")

    async def generate_visualization_code(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any],
        is_retry: bool = False,
        error_message: str = ""
    ) -> str:
        """
        生成Manim可视化代码（使用 Anthropic Skills 方式）

        流程：
        1. 分析每个解题步骤
        2. 让LLM选择合适的技能
        3. 提取参数
        4. 渲染技能模板
        5. 组装成完整代码

        Args:
            problem_text: 题目文本
            analysis_result: 理解Agent的分析结果
            solution_result: 解题Agent的解题结果
            is_retry: 是否是重试
            error_message: 错误信息

        Returns:
            Manim可视化代码
        """
        logger.info("[Skills模式] 开始生成可视化代码")

        try:
            steps = solution_result.get("详细步骤", [])

            # 如果没有步骤，使用降级方案
            if not steps:
                logger.warning("没有解题步骤，使用简单可视化")
                return self._create_simple_visualization(problem_text, solution_result)

            # 为每个步骤选择技能
            code_parts = [
                "from manim import *\n\n",
                "class MathVisualization(Scene):\n",
                "    def construct(self):\n"
            ]

            # 显示题目
            code_parts.append(self._generate_problem_display(problem_text))

            # 处理每个步骤
            for i, step in enumerate(steps[:5], 1):  # 最多处理5个步骤
                logger.info(f"处理步骤 {i}: {step.get('步骤说明', '')[:30]}...")

                # 尝试自动匹配技能
                best_match = skill_loader.find_best_skill(problem_text, step, threshold=0.3)

                if best_match:
                    skill_name, score = best_match
                    logger.info(f"自动匹配技能: {skill_name} (分数: {score:.2f})")

                    # 使用匹配的技能
                    step_code = await self._use_skill_for_step(
                        skill_name, step, problem_text, i
                    )
                    if step_code:
                        code_parts.append(step_code)
                        continue

                # 如果自动匹配失败，让LLM选择
                logger.info("自动匹配失败，让LLM选择技能")
                step_code = await self._llm_select_skill_for_step(
                    step, problem_text, i
                )
                if step_code:
                    code_parts.append(step_code)
                else:
                    # 使用通用可视化
                    code_parts.append(self._generate_generic_step(step, i))

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
        params = self._extract_parameters_from_step(step_data, skill.parameters)

        if not params:
            logger.warning(f"无法从步骤中提取参数")
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

    def _extract_parameters_from_step(
        self,
        step_data: Dict[str, Any],
        required_params: Dict[str, str]
    ) -> Optional[Dict[str, Any]]:
        """
        从步骤数据中提取参数

        Args:
            step_data: 步骤数据
            required_params: 需要的参数及其描述

        Returns:
            参数字典，失败返回None
        """
        import re

        # 从步骤的具体操作和结果中提取数字
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
            logger.info(f"成功提取参数: {params}")
            return params
        else:
            logger.warning(f"参数提取不完整: 需要 {list(required_params.keys())}, 得到 {list(params.keys())}")
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
        """生成题目显示代码"""
        safe_text = problem_text.replace('"', '\\"')[:60]
        return f'''
        # 显示题目
        problem = Text("{safe_text}", font="Noto Sans CJK SC", font_size=32)
        problem.to_edge(UP, buff=1.0)
        self.play(Write(problem))
        self.wait(2)
        self.play(problem.animate.scale(0.6))
        self.wait(0.5)

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

    def _generate_generic_step(self, step_data: Dict[str, Any], step_number: int) -> str:
        """生成通用步骤可视化代码"""
        desc = step_data.get("步骤说明", f"步骤{step_number}")[:40]
        result = str(step_data.get("结果", ""))[:40]

        return f'''
        # 步骤 {step_number}: {desc}
        step_label = Text("{desc}", font="Noto Sans CJK SC", font_size=28)
        step_label.to_edge(UP, buff=2.0)
        self.play(Write(step_label))
        self.wait(1)

        result_text = Text("{result}", font="Noto Sans CJK SC", font_size=36, color=GREEN)
        result_text.move_to(ORIGIN)
        self.play(Write(result_text))
        self.wait(2)

        self.play(FadeOut(step_label), FadeOut(result_text))
        self.wait(0.5)

'''

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
