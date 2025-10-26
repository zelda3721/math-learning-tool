"""
Manim代码构建器 - 基于工具调用的结构化代码生成

这个模块提供了一组高层API，让LLM通过结构化的操作来构建Manim场景，
而不是直接生成整段代码。这确保了代码质量和布局规范的一致性。
"""
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import logging

from core.scene_state_manager import SceneStateManager, Zone, ElementType

logger = logging.getLogger(__name__)


class AnimationType(Enum):
    """动画类型"""
    WRITE = "Write"
    CREATE = "Create"
    FADE_IN = "FadeIn"
    FADE_OUT = "FadeOut"
    TRANSFORM = "Transform"
    TRANSFORM_FROM_COPY = "TransformFromCopy"
    INDICATE = "Indicate"
    LAGGED_START = "LaggedStart"
    ANIMATE = "animate"  # .animate语法


@dataclass
class ManimOperation:
    """Manim操作"""
    operation_type: str  # "create_element", "animate", "wait", etc.
    code: str  # 生成的代码
    affects_elements: List[str]  # 影响的元素列表
    metadata: Dict[str, Any] = None


class ManimCodeBuilder:
    """Manim代码构建器"""

    def __init__(self):
        """初始化构建器"""
        self.state_manager = SceneStateManager()
        self.operations: List[ManimOperation] = []
        self.imports = set(["from manim import *"])
        logger.info("Manim代码构建器初始化完成")

    def start_step(self, step_number: int, step_description: str) -> str:
        """
        开始新的步骤

        Args:
            step_number: 步骤编号
            step_description: 步骤描述

        Returns:
            生成的代码注释
        """
        self.state_manager.next_step()
        code = f"\n        # ========== 步骤 {step_number}: {step_description} ==========\n"
        self.operations.append(ManimOperation(
            operation_type="step_marker",
            code=code,
            affects_elements=[],
            metadata={"step": step_number, "description": step_description}
        ))
        return code

    def create_text(
        self,
        name: str,
        content: str,
        zone: Zone,
        font_size: int = 36,
        color: str = "WHITE",
        persistent: bool = False
    ) -> Tuple[bool, str]:
        """
        创建文本元素

        Args:
            name: 变量名
            content: 文本内容
            zone: 所在分区
            font_size: 字号
            color: 颜色
            persistent: 是否持久化

        Returns:
            (成功标志, 代码)
        """
        # 估计文本尺寸（粗略估计）
        char_count = len(content)
        estimated_width = min(char_count * font_size / 72, 10)
        estimated_height = font_size / 36

        # 添加到状态管理器
        success, positioning_code, bbox = self.state_manager.add_element(
            name=name,
            element_type=ElementType.TEXT,
            zone=zone,
            estimated_width=estimated_width,
            estimated_height=estimated_height,
            persistent=persistent,
            content=content,
            font_size=font_size
        )

        if not success:
            return False, positioning_code  # 返回错误信息

        # 生成代码
        code = f'{name} = Text("{content}", font="Noto Sans CJK SC", font_size={font_size}, color={color})\n'
        code += f"        {positioning_code}\n"

        self.operations.append(ManimOperation(
            operation_type="create_text",
            code=code,
            affects_elements=[name],
            metadata={"zone": zone.value}
        ))

        return True, code

    def create_math(
        self,
        name: str,
        latex: str,
        zone: Zone,
        font_size: int = 40,
        persistent: bool = False
    ) -> Tuple[bool, str]:
        """
        创建数学公式元素

        Args:
            name: 变量名
            latex: LaTeX公式
            zone: 所在分区
            font_size: 字号
            persistent: 是否持久化

        Returns:
            (成功标志, 代码)
        """
        # 估计公式尺寸
        estimated_width = min(len(latex) * font_size / 80, 8)
        estimated_height = font_size / 36

        success, positioning_code, bbox = self.state_manager.add_element(
            name=name,
            element_type=ElementType.MATH,
            zone=zone,
            estimated_width=estimated_width,
            estimated_height=estimated_height,
            persistent=persistent,
            latex=latex
        )

        if not success:
            return False, positioning_code

        code = f'{name} = MathTex(r"{latex}", font_size={font_size})\n'
        code += f"        {positioning_code}\n"

        self.operations.append(ManimOperation(
            operation_type="create_math",
            code=code,
            affects_elements=[name]
        ))

        return True, code

    def create_shape_group(
        self,
        name: str,
        shape_type: str,  # "Circle", "Rectangle", "Square"
        count: int,
        zone: Zone,
        arrangement: str = "grid",  # "grid", "row", "column"
        color: str = "BLUE",
        persistent: bool = False,
        **shape_params
    ) -> Tuple[bool, str]:
        """
        创建形状组（用于可视化数量）

        Args:
            name: 变量名
            shape_type: 形状类型
            count: 数量
            zone: 所在分区
            arrangement: 排列方式
            color: 颜色
            persistent: 是否持久化
            **shape_params: 形状参数（如radius, width, height等）

        Returns:
            (成功标志, 代码)
        """
        # 估计组的尺寸
        if arrangement == "grid":
            cols = min(count, 5)
            rows = (count + cols - 1) // cols
            estimated_width = cols * 0.5
            estimated_height = rows * 0.5
        elif arrangement == "row":
            estimated_width = count * 0.4
            estimated_height = 0.4
        else:  # column
            estimated_width = 0.4
            estimated_height = count * 0.4

        success, positioning_code, bbox = self.state_manager.add_element(
            name=name,
            element_type=ElementType.GROUP,
            zone=zone,
            estimated_width=estimated_width,
            estimated_height=estimated_height,
            persistent=persistent,
            shape_type=shape_type,
            count=count
        )

        if not success:
            return False, positioning_code

        # 构建形状参数
        params_str = ", ".join(f"{k}={v}" for k, v in shape_params.items())
        if params_str:
            params_str = ", " + params_str

        # 生成代码
        code = f'{name} = VGroup(*[{shape_type}(color={color}, fill_opacity=0.7{params_str}) for _ in range({count})])\n'

        # 添加排列方式
        if arrangement == "grid":
            cols = min(count, 5)
            code += f"        {name}.arrange_in_grid(rows={(count + cols - 1) // cols}, cols={cols}, buff=0.15)\n"
        elif arrangement == "row":
            code += f"        {name}.arrange(RIGHT, buff=0.15)\n"
        else:  # column
            code += f"        {name}.arrange(DOWN, buff=0.15)\n"

        # 缩放和定位
        code += f"        {name}.scale(0.7)\n"
        code += f"        {positioning_code}\n"

        self.operations.append(ManimOperation(
            operation_type="create_group",
            code=code,
            affects_elements=[name]
        ))

        return True, code

    def play_animation(
        self,
        animation_type: AnimationType,
        targets: List[str],
        **anim_params
    ) -> str:
        """
        播放动画

        Args:
            animation_type: 动画类型
            targets: 目标元素列表
            **anim_params: 动画参数

        Returns:
            生成的代码
        """
        # 检查目标元素是否存在
        for target in targets:
            if not self.state_manager.get_element(target):
                logger.warning(f"元素 {target} 不存在，动画可能失败")

        # 构建动画参数
        params_str = ", ".join(f"{k}={v}" for k, v in anim_params.items())

        # 生成代码
        if animation_type == AnimationType.WRITE:
            anims = [f"Write({t})" for t in targets]
        elif animation_type == AnimationType.CREATE:
            anims = [f"Create({t})" for t in targets]
        elif animation_type == AnimationType.FADE_IN:
            anims = [f"FadeIn({t})" for t in targets]
        elif animation_type == AnimationType.FADE_OUT:
            anims = [f"FadeOut({t})" for t in targets]
            # 从状态管理器中移除
            for target in targets:
                self.state_manager.remove_element(target)
        elif animation_type == AnimationType.TRANSFORM:
            if len(targets) != 2:
                return "# 错误：Transform需要2个目标（源和目标）\n"
            # 检查Transform是否安全
            source, target = targets
            can_transform, msg = self.state_manager.suggest_transform_target(
                source,
                self.state_manager.get_element(target).bbox.width if self.state_manager.get_element(target) else 1.0,
                self.state_manager.get_element(target).bbox.height if self.state_manager.get_element(target) else 1.0
            )
            if not can_transform:
                logger.warning(msg)
            anims = [f"Transform({targets[0]}, {targets[1]})"]
        else:
            anims = [f"{animation_type.value}({t})" for t in targets]

        if len(anims) == 1:
            code = f"self.play({anims[0]}"
        else:
            code = f"self.play({', '.join(anims)}"

        if params_str:
            code += f", {params_str}"
        code += ")\n"

        self.operations.append(ManimOperation(
            operation_type="animation",
            code=code,
            affects_elements=targets
        ))

        return code

    def animate_property(
        self,
        target: str,
        property_name: str,
        value: Any,
        **anim_params
    ) -> str:
        """
        使用.animate语法改变属性

        Args:
            target: 目标元素
            property_name: 属性名（如set_color, shift, scale等）
            value: 属性值
            **anim_params: 动画参数（如run_time等）

        Returns:
            生成的代码
        """
        # 检查元素是否存在
        if not self.state_manager.get_element(target):
            return f"# 错误：元素 {target} 不存在\n"

        # 构建参数
        params_str = ", ".join(f"{k}={v}" for k, v in anim_params.items())

        # 生成代码
        if isinstance(value, str):
            code = f"self.play({target}.animate.{property_name}({value})"
        else:
            code = f"self.play({target}.animate.{property_name}({value})"

        if params_str:
            code += f", {params_str}"
        code += ")\n"

        self.operations.append(ManimOperation(
            operation_type="animate_property",
            code=code,
            affects_elements=[target]
        ))

        return code

    def wait(self, duration: float = 1.0) -> str:
        """
        等待

        Args:
            duration: 等待时长（秒）

        Returns:
            生成的代码
        """
        code = f"self.wait({duration})\n"
        self.operations.append(ManimOperation(
            operation_type="wait",
            code=code,
            affects_elements=[]
        ))
        return code

    def add_comment(self, comment: str) -> str:
        """添加注释"""
        code = f"# {comment}\n"
        self.operations.append(ManimOperation(
            operation_type="comment",
            code=code,
            affects_elements=[]
        ))
        return code

    def build(self, class_name: str = "MathVisualization") -> str:
        """
        构建完整的Manim代码

        Args:
            class_name: 场景类名

        Returns:
            完整的Python代码
        """
        # 生成导入语句
        imports = "\n".join(sorted(self.imports))

        # 生成类定义
        code_parts = [
            imports,
            "",
            f"class {class_name}(Scene):",
            "    def construct(self):",
        ]

        # 添加所有操作的代码
        for op in self.operations:
            # 缩进处理
            lines = op.code.split('\n')
            indented_lines = ["        " + line if line and not line.startswith("        ") else line for line in lines]
            code_parts.append("".join(indented_lines))

        # 生成布局报告作为注释（可选，用于调试）
        report = self.state_manager.generate_layout_report()
        code_parts.append("\n# " + "\n# ".join(report.split('\n')))

        return "\n".join(code_parts)

    def get_state(self) -> Dict[str, Any]:
        """获取当前状态（用于Agent间传递）"""
        return self.state_manager.export_state()


class ManimOperationPlanner:
    """
    Manim操作规划器 - 将解题步骤转换为Manim操作序列

    这个类负责智能地将数学解题步骤转换为具体的Manim操作，
    包括选择合适的可视化方式、布局等。
    """

    def __init__(self, builder: ManimCodeBuilder):
        """
        初始化规划器

        Args:
            builder: Manim代码构建器
        """
        self.builder = builder

    def plan_problem_display(
        self,
        problem_text: str
    ) -> List[str]:
        """
        规划题目展示

        Args:
            problem_text: 题目文本

        Returns:
            代码行列表
        """
        codes = []

        # 创建题目文本
        success, code = self.builder.create_text(
            name="problem_text",
            content=problem_text[:60] + "..." if len(problem_text) > 60 else problem_text,
            zone=Zone.CENTER,
            font_size=32,
            persistent=True  # 题目保持显示
        )
        codes.append(code)

        # 显示动画
        codes.append(self.builder.play_animation(AnimationType.WRITE, ["problem_text"]))
        codes.append(self.builder.wait(2))

        # 将题目移到顶部缩小
        codes.append(self.builder.animate_property("problem_text", "scale", 0.6))
        codes.append(self.builder.animate_property("problem_text", "to_edge", "UP"))
        codes.append(self.builder.wait(0.5))

        return codes

    def plan_step_visualization(
        self,
        step_number: int,
        step_data: Dict[str, Any],
        problem_type: str
    ) -> List[str]:
        """
        规划单个步骤的可视化

        Args:
            step_number: 步骤编号
            step_data: 步骤数据（包含步骤说明、计算等）
            problem_type: 问题类型（用于选择可视化方式）

        Returns:
            代码行列表
        """
        codes = []

        # 开始步骤
        codes.append(self.builder.start_step(
            step_number,
            step_data.get("步骤说明", f"步骤{step_number}")
        ))

        # 根据问题类型选择可视化策略
        if "加法" in problem_type or "求和" in step_data.get("步骤说明", ""):
            codes.extend(self._visualize_addition(step_data))
        elif "减法" in problem_type or "相减" in step_data.get("步骤说明", ""):
            codes.extend(self._visualize_subtraction(step_data))
        elif "乘法" in problem_type or "倍" in step_data.get("步骤说明", ""):
            codes.extend(self._visualize_multiplication(step_data))
        else:
            # 默认可视化：显示步骤说明和结果
            codes.extend(self._visualize_generic_step(step_data))

        return codes

    def _visualize_addition(self, step_data: Dict[str, Any]) -> List[str]:
        """可视化加法操作"""
        # TODO: 实现具体的加法可视化逻辑
        return self._visualize_generic_step(step_data)

    def _visualize_subtraction(self, step_data: Dict[str, Any]) -> List[str]:
        """可视化减法操作"""
        # TODO: 实现具体的减法可视化逻辑
        return self._visualize_generic_step(step_data)

    def _visualize_multiplication(self, step_data: Dict[str, Any]) -> List[str]:
        """可视化乘法操作"""
        # TODO: 实现具体的乘法可视化逻辑
        return self._visualize_generic_step(step_data)

    def _visualize_generic_step(self, step_data: Dict[str, Any]) -> List[str]:
        """通用步骤可视化"""
        codes = []

        # 显示步骤说明
        step_desc = step_data.get("步骤说明", "")
        if step_desc:
            success, code = self.builder.create_text(
                name=f"step_label_{self.builder.state_manager.current_step}",
                content=step_desc,
                zone=Zone.TOP,
                font_size=28
            )
            codes.append(code)
            codes.append(self.builder.play_animation(
                AnimationType.WRITE,
                [f"step_label_{self.builder.state_manager.current_step}"]
            ))

        # 显示计算结果
        result = step_data.get("结果", "")
        if result:
            success, code = self.builder.create_text(
                name=f"result_{self.builder.state_manager.current_step}",
                content=str(result),
                zone=Zone.BOTTOM,
                font_size=40,
                color="GREEN"
            )
            codes.append(code)
            codes.append(self.builder.play_animation(
                AnimationType.WRITE,
                [f"result_{self.builder.state_manager.current_step}"]
            ))

        codes.append(self.builder.wait(2))

        return codes
