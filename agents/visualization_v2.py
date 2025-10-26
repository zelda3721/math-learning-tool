"""
可视化Agent V2 - 基于工具调用的结构化代码生成

这是新一代可视化Agent，使用结构化的工具调用而非自由文本生成，
确保代码质量、布局规范的一致性，并大幅减少tokens消耗。
"""
import json
import logging
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from utils.prompts_optimized import VISUALIZATION_AGENT_V2_PROMPT, get_example_for_operation
from core.manim_builder import ManimCodeBuilder, AnimationType
from core.scene_state_manager import Zone

logger = logging.getLogger(__name__)


class VisualizationAgentV2(BaseAgent):
    """可视化Agent V2 - 基于工具调用"""

    def __init__(self, model: ChatOpenAI):
        """
        初始化可视化Agent V2

        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="可视化Agent V2",
            description="基于工具调用生成Manim代码",
            system_prompt=VISUALIZATION_AGENT_V2_PROMPT,
            model=model
        )
        self.builder = ManimCodeBuilder()
        logger.info("可视化Agent V2初始化完成")

    async def generate_visualization_code(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any],
        is_retry: bool = False,
        error_message: str = ""
    ) -> str:
        """
        生成Manim可视化代码（使用工具调用方式）

        Args:
            problem_text: 题目文本
            analysis_result: 理解Agent的分析结果
            solution_result: 解题Agent的解题结果
            is_retry: 是否是重试
            error_message: 错误信息

        Returns:
            Manim可视化代码
        """
        # 重置构建器
        self.builder = ManimCodeBuilder()

        # 构建提示词
        analysis_json = json.dumps(analysis_result, ensure_ascii=False, indent=2)
        solution_json = json.dumps(solution_result, ensure_ascii=False, indent=2)

        if is_retry:
            prompt = f"""⚠️ 之前的代码失败，请重新规划。

**错误**: {error_message}

**题目**: {problem_text}
**分析**: {analysis_json}
**解题**: {solution_json}

请输出工具调用序列的JSON。"""
        else:
            prompt = f"""请为以下题目规划可视化操作序列。

**题目**: {problem_text}
**分析**: {analysis_json}
**解题**: {solution_json}

请输出工具调用序列的JSON。"""

        try:
            # 调用LLM获取操作序列
            response = await self.arun(prompt)
            logger.info(f"LLM响应: {response[:200]}...")

            # 解析操作序列
            operations = self._parse_operations(response)

            if not operations:
                logger.warning("未能解析操作序列，使用智能生成器")
                return self._intelligent_generate(problem_text, analysis_result, solution_result)

            # 执行操作序列构建代码
            code = self._execute_operations(operations)

            if not code or "class" not in code:
                logger.warning("操作序列执行失败，使用智能生成器")
                return self._intelligent_generate(problem_text, analysis_result, solution_result)

            logger.info("代码生成成功")
            return code

        except Exception as e:
            logger.error(f"生成代码时出错: {e}")
            # 降级：使用智能生成器
            return self._intelligent_generate(problem_text, analysis_result, solution_result)

    def _parse_operations(self, response: str) -> List[Dict[str, Any]]:
        """
        解析LLM响应中的操作序列

        Args:
            response: LLM响应

        Returns:
            操作列表
        """
        try:
            # 尝试提取JSON
            if "```json" in response:
                json_start = response.find("```json") + 7
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            elif "```" in response:
                json_start = response.find("```") + 3
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            else:
                # 尝试直接解析整个响应
                json_str = response.strip()

            data = json.loads(json_str)
            operations = data.get("operations", [])

            logger.info(f"解析到 {len(operations)} 个操作")
            return operations

        except Exception as e:
            logger.error(f"解析操作序列失败: {e}")
            return []

    def _execute_operations(self, operations: List[Dict[str, Any]]) -> str:
        """
        执行操作序列，构建Manim代码

        Args:
            operations: 操作列表

        Returns:
            完整的Manim代码
        """
        try:
            for op in operations:
                tool = op.get("tool")
                params = op.get("params", {})

                if tool == "create_text":
                    self._execute_create_text(params)
                elif tool == "create_shape_group":
                    self._execute_create_shape_group(params)
                elif tool == "create_math":
                    self._execute_create_math(params)
                elif tool == "play_animation":
                    self._execute_play_animation(params)
                elif tool == "animate_property":
                    self._execute_animate_property(params)
                elif tool == "wait":
                    self._execute_wait(params)
                else:
                    logger.warning(f"未知工具: {tool}")

            # 构建完整代码
            code = self.builder.build()
            return code

        except Exception as e:
            logger.error(f"执行操作序列失败: {e}")
            return ""

    def _execute_create_text(self, params: Dict[str, Any]):
        """执行create_text操作"""
        name = params.get("name", "text")
        content = params.get("content", "")
        zone_str = params.get("zone", "center")
        font_size = params.get("font_size", 36)
        persistent = params.get("persistent", False)
        color = params.get("color", "WHITE")

        # 转换zone字符串为Zone枚举
        zone = Zone.TOP if zone_str == "top" else Zone.BOTTOM if zone_str == "bottom" else Zone.CENTER

        success, code = self.builder.create_text(
            name=name,
            content=content,
            zone=zone,
            font_size=font_size,
            color=color,
            persistent=persistent
        )

        if not success:
            logger.warning(f"创建文本失败: {code}")

    def _execute_create_shape_group(self, params: Dict[str, Any]):
        """执行create_shape_group操作"""
        name = params.get("name", "shapes")
        shape_type = params.get("shape_type", "Circle")
        count = params.get("count", 5)
        zone_str = params.get("zone", "center")
        arrangement = params.get("arrangement", "grid")
        color = params.get("color", "BLUE")
        persistent = params.get("persistent", False)

        zone = Zone.TOP if zone_str == "top" else Zone.BOTTOM if zone_str == "bottom" else Zone.CENTER

        # 提取形状参数
        shape_params = {}
        if "radius" in params:
            shape_params["radius"] = params["radius"]
        if "width" in params:
            shape_params["width"] = params["width"]
        if "height" in params:
            shape_params["height"] = params["height"]

        success, code = self.builder.create_shape_group(
            name=name,
            shape_type=shape_type,
            count=count,
            zone=zone,
            arrangement=arrangement,
            color=color,
            persistent=persistent,
            **shape_params
        )

        if not success:
            logger.warning(f"创建形状组失败: {code}")

    def _execute_create_math(self, params: Dict[str, Any]):
        """执行create_math操作"""
        name = params.get("name", "formula")
        latex = params.get("latex", "")
        zone_str = params.get("zone", "center")
        font_size = params.get("font_size", 40)
        persistent = params.get("persistent", False)

        zone = Zone.TOP if zone_str == "top" else Zone.BOTTOM if zone_str == "bottom" else Zone.CENTER

        success, code = self.builder.create_math(
            name=name,
            latex=latex,
            zone=zone,
            font_size=font_size,
            persistent=persistent
        )

        if not success:
            logger.warning(f"创建数学公式失败: {code}")

    def _execute_play_animation(self, params: Dict[str, Any]):
        """执行play_animation操作"""
        anim_type_str = params.get("type", "Write")
        targets = params.get("targets", [])

        # 转换动画类型
        anim_type_map = {
            "Write": AnimationType.WRITE,
            "Create": AnimationType.CREATE,
            "FadeIn": AnimationType.FADE_IN,
            "FadeOut": AnimationType.FADE_OUT,
            "Transform": AnimationType.TRANSFORM,
            "Indicate": AnimationType.INDICATE,
        }

        anim_type = anim_type_map.get(anim_type_str, AnimationType.WRITE)

        # 提取动画参数
        anim_params = {}
        if "run_time" in params:
            anim_params["run_time"] = params["run_time"]
        if "lag_ratio" in params:
            anim_params["lag_ratio"] = params["lag_ratio"]

        code = self.builder.play_animation(anim_type, targets, **anim_params)

    def _execute_animate_property(self, params: Dict[str, Any]):
        """执行animate_property操作"""
        target = params.get("target", "")
        property_name = params.get("property", "set_color")
        value = params.get("value", "RED")

        # 提取动画参数
        anim_params = {}
        if "run_time" in params:
            anim_params["run_time"] = params["run_time"]

        code = self.builder.animate_property(target, property_name, value, **anim_params)

    def _execute_wait(self, params: Dict[str, Any]):
        """执行wait操作"""
        duration = params.get("duration", 1.0)
        code = self.builder.wait(duration)

    def _intelligent_generate(
        self,
        problem_text: str,
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any]
    ) -> str:
        """
        智能生成器 - 当LLM无法正确使用工具时的降级方案

        这个方法分析题目类型，自动选择合适的可视化策略并生成代码。

        Args:
            problem_text: 题目文本
            analysis_result: 分析结果
            solution_result: 解题结果

        Returns:
            Manim代码
        """
        logger.info("使用智能生成器")

        # 重置构建器
        self.builder = ManimCodeBuilder()

        # 识别题目类型
        problem_type = analysis_result.get("题目类型", "")
        steps = solution_result.get("详细步骤", [])
        final_answer = solution_result.get("最终答案", "未知")

        # 1. 显示题目
        self.builder.create_text(
            name="problem_title",
            content="题目",
            zone=Zone.TOP,
            font_size=28,
            persistent=False
        )
        self.builder.play_animation(AnimationType.WRITE, ["problem_title"])
        self.builder.wait(0.5)

        problem_content = problem_text[:50] + "..." if len(problem_text) > 50 else problem_text
        self.builder.create_text(
            name="problem_text",
            content=problem_content,
            zone=Zone.CENTER,
            font_size=32,
            persistent=True
        )
        self.builder.play_animation(AnimationType.WRITE, ["problem_text"])
        self.builder.wait(1.5)

        # 题目移到顶部
        self.builder.play_animation(AnimationType.FADE_OUT, ["problem_title"])
        self.builder.animate_property("problem_text", "scale", 0.6)
        self.builder.animate_property("problem_text", "to_edge", "UP")
        self.builder.wait(0.5)

        # 2. 逐步展示解题过程
        for i, step in enumerate(steps[:5], 1):  # 最多5步
            self.builder.start_step(i, step.get("步骤说明", f"步骤{i}"))

            # 显示步骤标题
            step_desc = step.get("步骤说明", "")[:40]
            self.builder.create_text(
                name=f"step_{i}_label",
                content=f"第{i}步: {step_desc}",
                zone=Zone.TOP,
                font_size=28,
                persistent=False
            )
            self.builder.play_animation(AnimationType.WRITE, [f"step_{i}_label"])
            self.builder.wait(1)

            # 显示结果（如果有）
            result = step.get("结果", "")
            if result:
                self.builder.create_text(
                    name=f"step_{i}_result",
                    content=str(result),
                    zone=Zone.BOTTOM,
                    font_size=36,
                    color="GREEN",
                    persistent=False
                )
                self.builder.play_animation(AnimationType.WRITE, [f"step_{i}_result"])
                self.builder.wait(2)

            # 清除当前步骤
            self.builder.play_animation(AnimationType.FADE_OUT, [f"step_{i}_label"])
            if result:
                self.builder.play_animation(AnimationType.FADE_OUT, [f"step_{i}_result"])
            self.builder.wait(0.5)

        # 3. 显示最终答案
        self.builder.create_text(
            name="answer_title",
            content="答案",
            zone=Zone.TOP,
            font_size=36,
            color="YELLOW",
            persistent=False
        )
        self.builder.play_animation(AnimationType.WRITE, ["answer_title"])

        self.builder.create_text(
            name="final_answer",
            content=str(final_answer),
            zone=Zone.CENTER,
            font_size=48,
            color="GREEN",
            persistent=False
        )
        self.builder.play_animation(AnimationType.WRITE, ["final_answer"])
        self.builder.wait(3)

        # 4. 结束
        self.builder.create_text(
            name="end_text",
            content="谢谢观看",
            zone=Zone.CENTER,
            font_size=40,
            persistent=False
        )
        self.builder.play_animation(AnimationType.FADE_OUT, ["answer_title", "final_answer", "problem_text"])
        self.builder.wait(0.5)
        self.builder.play_animation(AnimationType.WRITE, ["end_text"])
        self.builder.wait(2)

        # 构建代码
        code = self.builder.build()
        logger.info("智能生成器完成代码生成")
        return code
