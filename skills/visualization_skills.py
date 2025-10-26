"""
可复用的视觉化技能模块 - 类似Claude Skills的方法

这个模块提供了一组预定义的、经过验证的可视化模式，
可以直接应用于常见的数学问题类型，无需LLM生成。
"""
from typing import Dict, Any, List
from core.manim_builder import ManimCodeBuilder, AnimationType
from core.scene_state_manager import Zone
import logging

logger = logging.getLogger(__name__)


class VisualizationSkill:
    """基础可视化技能类"""

    def __init__(self, builder: ManimCodeBuilder):
        """
        初始化技能

        Args:
            builder: Manim代码构建器
        """
        self.builder = builder

    def apply(self, **params) -> bool:
        """
        应用技能

        Args:
            **params: 技能参数

        Returns:
            是否成功应用
        """
        raise NotImplementedError


class AdditionSkill(VisualizationSkill):
    """加法可视化技能"""

    def apply(
        self,
        num1: int,
        num2: int,
        step_number: int = 1,
        description: str = "加法运算"
    ) -> bool:
        """
        可视化加法运算

        Args:
            num1: 第一个加数
            num2: 第二个加数
            step_number: 步骤编号
            description: 描述

        Returns:
            是否成功
        """
        try:
            self.builder.start_step(step_number, f"{description}: {num1} + {num2}")

            # 创建第一组元素
            self.builder.create_shape_group(
                name=f"group1_step{step_number}",
                shape_type="Circle",
                count=num1,
                zone=Zone.CENTER,
                arrangement="row" if num1 <= 10 else "grid",
                color="BLUE",
                radius=0.15
            )
            self.builder.play_animation(AnimationType.FADE_IN, [f"group1_step{step_number}"])
            self.builder.wait(1)

            # 创建第二组元素
            self.builder.create_shape_group(
                name=f"group2_step{step_number}",
                shape_type="Circle",
                count=num2,
                zone=Zone.CENTER,
                arrangement="row" if num2 <= 10 else "grid",
                color="RED",
                radius=0.15
            )
            self.builder.play_animation(AnimationType.FADE_IN, [f"group2_step{step_number}"])
            self.builder.wait(1)

            # 合并（通过动画移动到一起）
            # 注意：这里简化处理，实际可以添加更复杂的合并动画
            self.builder.wait(1)

            # 显示结果
            result = num1 + num2
            self.builder.create_text(
                name=f"result_step{step_number}",
                content=f"{num1} + {num2} = {result}",
                zone=Zone.BOTTOM,
                font_size=40,
                color="GREEN"
            )
            self.builder.play_animation(AnimationType.WRITE, [f"result_step{step_number}"])
            self.builder.wait(2)

            logger.info(f"加法技能应用成功: {num1} + {num2}")
            return True

        except Exception as e:
            logger.error(f"加法技能应用失败: {e}")
            return False


class SubtractionSkill(VisualizationSkill):
    """减法可视化技能（重叠表达法）"""

    def apply(
        self,
        minuend: int,
        subtrahend: int,
        step_number: int = 1,
        description: str = "减法运算"
    ) -> bool:
        """
        可视化减法运算

        Args:
            minuend: 被减数
            subtrahend: 减数
            step_number: 步骤编号
            description: 描述

        Returns:
            是否成功
        """
        try:
            self.builder.start_step(step_number, f"{description}: {minuend} - {subtrahend}")

            # 创建总数
            self.builder.create_shape_group(
                name=f"total_step{step_number}",
                shape_type="Square",
                count=minuend,
                zone=Zone.CENTER,
                arrangement="grid",
                color="BLUE",
                side_length=0.3
            )
            self.builder.play_animation(AnimationType.FADE_IN, [f"total_step{step_number}"])
            self.builder.wait(1)

            # 标记要减去的部分（改变颜色）
            for i in range(subtrahend):
                self.builder.animate_property(
                    f"total_step{step_number}[{i}]",
                    "set_color",
                    "RED"
                )

            self.builder.wait(1)

            # 移除标记的部分
            targets_to_remove = [f"total_step{step_number}[{i}]" for i in range(subtrahend)]
            self.builder.play_animation(AnimationType.FADE_OUT, targets_to_remove)
            self.builder.wait(1)

            # 显示结果
            result = minuend - subtrahend
            self.builder.create_text(
                name=f"result_step{step_number}",
                content=f"{minuend} - {subtrahend} = {result}",
                zone=Zone.BOTTOM,
                font_size=40,
                color="GREEN"
            )
            self.builder.play_animation(AnimationType.WRITE, [f"result_step{step_number}"])
            self.builder.wait(2)

            logger.info(f"减法技能应用成功: {minuend} - {subtrahend}")
            return True

        except Exception as e:
            logger.error(f"减法技能应用失败: {e}")
            return False


class MultiplicationSkill(VisualizationSkill):
    """乘法可视化技能（倍数关系）"""

    def apply(
        self,
        multiplier: int,
        multiplicand: int,
        step_number: int = 1,
        description: str = "乘法运算"
    ) -> bool:
        """
        可视化乘法运算

        Args:
            multiplier: 乘数
            multiplicand: 被乘数
            step_number: 步骤编号
            description: 描述

        Returns:
            是否成功
        """
        try:
            self.builder.start_step(
                step_number,
                f"{description}: {multiplier} × {multiplicand} = {multiplier}个{multiplicand}"
            )

            # 创建多组，每组有multiplicand个元素
            for i in range(multiplier):
                self.builder.create_shape_group(
                    name=f"group{i}_step{step_number}",
                    shape_type="Circle",
                    count=multiplicand,
                    zone=Zone.CENTER,
                    arrangement="row",
                    color="BLUE",
                    radius=0.12
                )
                self.builder.play_animation(AnimationType.FADE_IN, [f"group{i}_step{step_number}"])
                self.builder.wait(0.5)

            self.builder.wait(1)

            # 显示结果
            result = multiplier * multiplicand
            self.builder.create_text(
                name=f"result_step{step_number}",
                content=f"{multiplier} × {multiplicand} = {result}",
                zone=Zone.BOTTOM,
                font_size=40,
                color="GREEN"
            )
            self.builder.play_animation(AnimationType.WRITE, [f"result_step{step_number}"])
            self.builder.wait(2)

            logger.info(f"乘法技能应用成功: {multiplier} × {multiplicand}")
            return True

        except Exception as e:
            logger.error(f"乘法技能应用失败: {e}")
            return False


class ComparisonSkill(VisualizationSkill):
    """比较大小可视化技能"""

    def apply(
        self,
        num1: int,
        num2: int,
        step_number: int = 1,
        description: str = "比较大小"
    ) -> bool:
        """
        可视化比较大小

        Args:
            num1: 第一个数
            num2: 第二个数
            step_number: 步骤编号
            description: 描述

        Returns:
            是否成功
        """
        try:
            self.builder.start_step(step_number, f"{description}: {num1} 和 {num2}")

            # 创建两组元素，左右对比
            self.builder.create_shape_group(
                name=f"group1_step{step_number}",
                shape_type="Rectangle",
                count=num1,
                zone=Zone.CENTER,
                arrangement="column",
                color="BLUE",
                width=0.4,
                height=0.4
            )

            self.builder.create_shape_group(
                name=f"group2_step{step_number}",
                shape_type="Rectangle",
                count=num2,
                zone=Zone.CENTER,
                arrangement="column",
                color="RED",
                width=0.4,
                height=0.4
            )

            self.builder.play_animation(
                AnimationType.FADE_IN,
                [f"group1_step{step_number}", f"group2_step{step_number}"]
            )
            self.builder.wait(2)

            # 显示比较结果
            if num1 > num2:
                result_text = f"{num1} > {num2}"
                color = "BLUE"
            elif num1 < num2:
                result_text = f"{num1} < {num2}"
                color = "RED"
            else:
                result_text = f"{num1} = {num2}"
                color = "GREEN"

            self.builder.create_text(
                name=f"result_step{step_number}",
                content=result_text,
                zone=Zone.BOTTOM,
                font_size=40,
                color=color
            )
            self.builder.play_animation(AnimationType.WRITE, [f"result_step{step_number}"])
            self.builder.wait(2)

            logger.info(f"比较技能应用成功: {num1} vs {num2}")
            return True

        except Exception as e:
            logger.error(f"比较技能应用失败: {e}")
            return False


class SkillRegistry:
    """技能注册表"""

    def __init__(self):
        """初始化注册表"""
        self.skills: Dict[str, type] = {
            "addition": AdditionSkill,
            "subtraction": SubtractionSkill,
            "multiplication": MultiplicationSkill,
            "comparison": ComparisonSkill,
        }
        logger.info(f"技能注册表初始化完成，已注册 {len(self.skills)} 个技能")

    def get_skill(self, skill_name: str, builder: ManimCodeBuilder) -> VisualizationSkill:
        """
        获取技能实例

        Args:
            skill_name: 技能名称
            builder: 代码构建器

        Returns:
            技能实例

        Raises:
            KeyError: 如果技能不存在
        """
        skill_class = self.skills.get(skill_name)
        if not skill_class:
            raise KeyError(f"技能 {skill_name} 不存在")

        return skill_class(builder)

    def register_skill(self, skill_name: str, skill_class: type):
        """
        注册新技能

        Args:
            skill_name: 技能名称
            skill_class: 技能类
        """
        self.skills[skill_name] = skill_class
        logger.info(f"注册新技能: {skill_name}")

    def list_skills(self) -> List[str]:
        """列出所有可用技能"""
        return list(self.skills.keys())


# 全局技能注册表实例
skill_registry = SkillRegistry()


def detect_operation_type(step_data: Dict[str, Any]) -> str:
    """
    检测操作类型

    Args:
        step_data: 步骤数据

    Returns:
        操作类型（用于匹配技能）
    """
    description = step_data.get("步骤说明", "") + step_data.get("具体操作", "")

    if "加" in description or "+" in description or "求和" in description:
        return "addition"
    elif "减" in description or "-" in description or "相减" in description:
        return "subtraction"
    elif "乘" in description or "×" in description or "倍" in description:
        return "multiplication"
    elif "除" in description or "÷" in description:
        return "division"
    elif "比较" in description or "大小" in description or ">" in description or "<" in description:
        return "comparison"
    else:
        return "generic"


def extract_numbers(step_data: Dict[str, Any]) -> List[int]:
    """
    从步骤数据中提取数字

    Args:
        step_data: 步骤数据

    Returns:
        数字列表
    """
    import re

    text = str(step_data.get("具体操作", "")) + str(step_data.get("结果", ""))
    numbers = re.findall(r'\d+', text)

    return [int(n) for n in numbers if n.isdigit()]
