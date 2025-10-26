"""
场景状态管理器 - 解决元素重叠和场景切换问题的核心模块

这个模块追踪Manim场景中所有元素的状态、位置和生命周期，
自动计算布局以避免重叠，并提供API给agents使用。
"""
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field
from enum import Enum
import logging

logger = logging.getLogger(__name__)


class Zone(Enum):
    """屏幕分区枚举"""
    TOP = "top"  # 标题区
    CENTER = "center"  # 主体区
    BOTTOM = "bottom"  # 结果区
    LEFT = "left"
    RIGHT = "right"


class ElementType(Enum):
    """元素类型枚举"""
    TEXT = "text"
    MATH = "math"
    SHAPE = "shape"
    GROUP = "group"
    ANIMATED = "animated"


@dataclass
class BoundingBox:
    """边界框"""
    x_min: float
    y_min: float
    x_max: float
    y_max: float

    @property
    def width(self) -> float:
        return self.x_max - self.x_min

    @property
    def height(self) -> float:
        return self.y_max - self.y_min

    @property
    def center(self) -> Tuple[float, float]:
        return ((self.x_min + self.x_max) / 2, (self.y_min + self.y_max) / 2)

    def overlaps(self, other: 'BoundingBox', margin: float = 0.3) -> bool:
        """检查是否与另一个边界框重叠（带安全边距）"""
        return not (
            self.x_max + margin < other.x_min or
            self.x_min - margin > other.x_max or
            self.y_max + margin < other.y_min or
            self.y_min - margin > other.y_max
        )


@dataclass
class SceneElement:
    """场景元素"""
    name: str  # 元素名称（变量名）
    element_type: ElementType  # 元素类型
    zone: Zone  # 所在分区
    bbox: BoundingBox  # 边界框
    layer: int = 0  # 图层（用于z-index）
    persistent: bool = False  # 是否持久化（跨场景保留）
    parent: Optional[str] = None  # 父元素（用于VGroup）
    created_at_step: int = 0  # 创建于哪个步骤
    metadata: Dict[str, Any] = field(default_factory=dict)  # 额外元数据


class SceneStateManager:
    """场景状态管理器"""

    # 屏幕安全区域定义（Manim坐标系）
    SCREEN_WIDTH = 14.0  # Manim默认屏幕宽度
    SCREEN_HEIGHT = 8.0  # Manim默认屏幕高度

    ZONE_BOUNDS = {
        Zone.TOP: BoundingBox(-6.0, 2.5, 6.0, 4.0),  # 标题区
        Zone.CENTER: BoundingBox(-6.0, -2.0, 6.0, 2.0),  # 主体区
        Zone.BOTTOM: BoundingBox(-6.0, -4.0, 6.0, -2.5),  # 结果区
    }

    def __init__(self):
        """初始化场景状态管理器"""
        self.elements: Dict[str, SceneElement] = {}  # 当前场景中的所有元素
        self.current_step: int = 0  # 当前步骤编号
        self.history: List[Dict[str, SceneElement]] = []  # 历史状态
        logger.info("场景状态管理器初始化完成")

    def next_step(self):
        """进入下一个步骤"""
        # 保存当前状态到历史
        self.history.append(self.elements.copy())
        self.current_step += 1
        logger.info(f"进入步骤 {self.current_step}")

    def add_element(
        self,
        name: str,
        element_type: ElementType,
        zone: Zone,
        estimated_width: float = 1.0,
        estimated_height: float = 1.0,
        persistent: bool = False,
        parent: Optional[str] = None,
        **metadata
    ) -> Tuple[bool, str, BoundingBox]:
        """
        添加元素到场景

        Args:
            name: 元素名称
            element_type: 元素类型
            zone: 目标分区
            estimated_width: 估计宽度
            estimated_height: 估计高度
            persistent: 是否持久化
            parent: 父元素名
            **metadata: 额外元数据

        Returns:
            (成功标志, 建议代码, 边界框)
        """
        # 计算建议位置（避免重叠）
        suggested_bbox = self._calculate_safe_position(
            zone, estimated_width, estimated_height
        )

        if suggested_bbox is None:
            return False, f"# 错误：{zone.value}区域已满，无法添加元素 {name}", None

        # 创建元素
        element = SceneElement(
            name=name,
            element_type=element_type,
            zone=zone,
            bbox=suggested_bbox,
            persistent=persistent,
            parent=parent,
            created_at_step=self.current_step,
            metadata=metadata
        )

        self.elements[name] = element

        # 生成建议的Manim代码
        code = self._generate_positioning_code(name, element, suggested_bbox)

        logger.info(f"添加元素 {name} 到 {zone.value} 区域")
        return True, code, suggested_bbox

    def _calculate_safe_position(
        self,
        zone: Zone,
        width: float,
        height: float
    ) -> Optional[BoundingBox]:
        """
        计算安全位置（避免与现有元素重叠）

        Args:
            zone: 目标分区
            width: 元素宽度
            height: 元素高度

        Returns:
            建议的边界框，如果无法放置则返回None
        """
        zone_bbox = self.ZONE_BOUNDS.get(zone)
        if not zone_bbox:
            return None

        # 获取该分区内的所有现有元素
        existing_elements = [
            elem for elem in self.elements.values()
            if elem.zone == zone
        ]

        # 尝试在分区内找到不重叠的位置
        # 策略：从中心向外尝试
        center_x, center_y = zone_bbox.center

        # 如果是第一个元素，直接放在中心
        if not existing_elements:
            return BoundingBox(
                center_x - width / 2,
                center_y - height / 2,
                center_x + width / 2,
                center_y + height / 2
            )

        # 尝试多个候选位置
        candidates = [
            (center_x, center_y),  # 中心
            (zone_bbox.x_min + width / 2 + 0.5, center_y),  # 左侧
            (zone_bbox.x_max - width / 2 - 0.5, center_y),  # 右侧
            (center_x, zone_bbox.y_max - height / 2 - 0.3),  # 顶部
            (center_x, zone_bbox.y_min + height / 2 + 0.3),  # 底部
        ]

        for x, y in candidates:
            candidate_bbox = BoundingBox(
                x - width / 2,
                y - height / 2,
                x + width / 2,
                y + height / 2
            )

            # 检查是否在分区范围内
            if not self._bbox_in_zone(candidate_bbox, zone_bbox):
                continue

            # 检查是否与现有元素重叠
            has_overlap = any(
                candidate_bbox.overlaps(elem.bbox)
                for elem in existing_elements
            )

            if not has_overlap:
                return candidate_bbox

        # 如果所有位置都重叠，返回None
        logger.warning(f"{zone.value}区域空间不足")
        return None

    def _bbox_in_zone(self, bbox: BoundingBox, zone_bbox: BoundingBox) -> bool:
        """检查边界框是否完全在分区内"""
        return (
            bbox.x_min >= zone_bbox.x_min and
            bbox.x_max <= zone_bbox.x_max and
            bbox.y_min >= zone_bbox.y_min and
            bbox.y_max <= zone_bbox.y_max
        )

    def _generate_positioning_code(
        self,
        name: str,
        element: SceneElement,
        bbox: BoundingBox
    ) -> str:
        """生成定位代码"""
        center_x, center_y = bbox.center

        # 根据分区使用不同的定位方法
        if element.zone == Zone.TOP:
            return f"{name}.move_to([{center_x:.2f}, {center_y:.2f}, 0])"
        elif element.zone == Zone.BOTTOM:
            return f"{name}.move_to([{center_x:.2f}, {center_y:.2f}, 0])"
        else:  # CENTER
            return f"{name}.move_to([{center_x:.2f}, {center_y:.2f}, 0])"

    def remove_element(self, name: str) -> bool:
        """
        从场景中移除元素

        Args:
            name: 元素名称

        Returns:
            是否成功移除
        """
        if name in self.elements:
            del self.elements[name]
            logger.info(f"移除元素 {name}")
            return True
        return False

    def clear_non_persistent(self):
        """清除所有非持久化元素（场景切换时使用）"""
        to_remove = [
            name for name, elem in self.elements.items()
            if not elem.persistent
        ]
        for name in to_remove:
            self.remove_element(name)
        logger.info(f"清除 {len(to_remove)} 个非持久化元素")

    def get_element(self, name: str) -> Optional[SceneElement]:
        """获取元素"""
        return self.elements.get(name)

    def list_elements(self, zone: Optional[Zone] = None) -> List[SceneElement]:
        """
        列出元素

        Args:
            zone: 如果指定，只返回该分区的元素

        Returns:
            元素列表
        """
        if zone:
            return [elem for elem in self.elements.values() if elem.zone == zone]
        return list(self.elements.values())

    def check_overlap(self, name1: str, name2: str) -> bool:
        """检查两个元素是否重叠"""
        elem1 = self.get_element(name1)
        elem2 = self.get_element(name2)

        if not elem1 or not elem2:
            return False

        return elem1.bbox.overlaps(elem2.bbox)

    def suggest_transform_target(
        self,
        source_name: str,
        new_content_width: float,
        new_content_height: float
    ) -> Tuple[bool, str]:
        """
        为Transform操作建议目标位置

        Args:
            source_name: 源元素名称
            new_content_width: 新内容宽度
            new_content_height: 新内容高度

        Returns:
            (是否可以Transform, 建议代码)
        """
        source = self.get_element(source_name)
        if not source:
            return False, f"# 错误：元素 {source_name} 不存在"

        # Transform应该保持在原位置，只更新内容
        # 但需要检查新内容是否会导致重叠
        new_bbox = BoundingBox(
            source.bbox.center[0] - new_content_width / 2,
            source.bbox.center[1] - new_content_height / 2,
            source.bbox.center[0] + new_content_width / 2,
            source.bbox.center[1] + new_content_height / 2
        )

        # 检查是否与其他元素重叠
        for name, elem in self.elements.items():
            if name == source_name:
                continue
            if new_bbox.overlaps(elem.bbox):
                return False, f"# 警告：Transform后可能与 {name} 重叠，建议使用FadeOut+FadeIn"

        # 更新元素边界框
        source.bbox = new_bbox

        return True, f"# Transform {source_name} 安全"

    def generate_layout_report(self) -> str:
        """生成布局报告（用于调试）"""
        report = [f"=== 场景布局报告 (步骤 {self.current_step}) ==="]

        for zone in Zone:
            if zone in self.ZONE_BOUNDS:
                elements = self.list_elements(zone)
                report.append(f"\n{zone.value.upper()} 区域 ({len(elements)} 个元素):")
                for elem in elements:
                    report.append(
                        f"  - {elem.name}: {elem.element_type.value}, "
                        f"位置 ({elem.bbox.center[0]:.1f}, {elem.bbox.center[1]:.1f}), "
                        f"大小 {elem.bbox.width:.1f}x{elem.bbox.height:.1f}"
                    )

        return "\n".join(report)

    def export_state(self) -> Dict[str, Any]:
        """导出当前状态（用于Agent之间传递）"""
        return {
            "current_step": self.current_step,
            "elements": {
                name: {
                    "type": elem.element_type.value,
                    "zone": elem.zone.value,
                    "position": elem.bbox.center,
                    "size": (elem.bbox.width, elem.bbox.height),
                    "persistent": elem.persistent
                }
                for name, elem in self.elements.items()
            },
            "zone_utilization": {
                zone.value: len(self.list_elements(zone))
                for zone in Zone if zone in self.ZONE_BOUNDS
            }
        }
