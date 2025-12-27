"""
Grade value object - represents education levels and their configurations
"""
from dataclasses import dataclass, field
from enum import Enum


class EducationLevel(str, Enum):
    """Education levels supported by the system"""
    
    ELEMENTARY_LOWER = "elementary_lower"  # 小学低年级 1-3
    ELEMENTARY_UPPER = "elementary_upper"  # 小学高年级 4-6
    MIDDLE_SCHOOL = "middle_school"        # 初中 7-9
    HIGH_SCHOOL = "high_school"            # 高中 10-12
    UNIVERSITY = "university"              # 大学微积分
    
    @property
    def display_name(self) -> str:
        names = {
            "elementary_lower": "小学低年级 (1-3年级)",
            "elementary_upper": "小学高年级 (4-6年级)",
            "middle_school": "初中",
            "high_school": "高中",
            "university": "大学微积分",
        }
        return names.get(self.value, self.value)


@dataclass
class GradeProfile:
    """Configuration profile for a grade level"""
    
    level: EducationLevel
    thinking_style: str
    visualization_style: str
    available_skills: list[str] = field(default_factory=list)
    
    # Visual style configuration
    colors: list[str] = field(default_factory=list)
    animation_speed: float = 1.0
    use_icons: bool = False
    use_3d: bool = False


# Pre-defined grade profiles
GRADE_PROFILES: dict[EducationLevel, GradeProfile] = {
    EducationLevel.ELEMENTARY_LOWER: GradeProfile(
        level=EducationLevel.ELEMENTARY_LOWER,
        thinking_style="具象思维：实物演示、数形结合",
        visualization_style="卡通图标、实物动画、色彩鲜明",
        available_skills=["counting", "addition", "subtraction"],
        colors=["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"],
        animation_speed=0.8,
        use_icons=True,
    ),
    EducationLevel.ELEMENTARY_UPPER: GradeProfile(
        level=EducationLevel.ELEMENTARY_UPPER,
        thinking_style="具象到抽象过渡：数形结合、简单推理",
        visualization_style="图形动画、数字变换",
        available_skills=[
            "counting", "addition", "subtraction", "multiplication", 
            "division", "fraction", "geometry"
        ],
        colors=["#667eea", "#764ba2", "#f093fb", "#f5576c"],
        animation_speed=1.0,
    ),
    EducationLevel.MIDDLE_SCHOOL: GradeProfile(
        level=EducationLevel.MIDDLE_SCHOOL,
        thinking_style="抽象思维：符号运算、几何推理",
        visualization_style="几何图形、方程变换、坐标系",
        available_skills=[
            "equation_balance", "coordinate_plane", "linear_graph",
            "triangle_proof", "geometry"
        ],
        colors=["#00c6ff", "#0072ff", "#7c3aed", "#2dd4bf"],
        animation_speed=1.2,
    ),
    EducationLevel.HIGH_SCHOOL: GradeProfile(
        level=EducationLevel.HIGH_SCHOOL,
        thinking_style="形式推理：函数思想、逻辑证明",
        visualization_style="函数图像、向量动画、3D视图",
        available_skills=[
            "quadratic_parabola", "trigonometry_circle", 
            "vector_arrow", "sequence_series"
        ],
        colors=["#1e3a8a", "#3730a3", "#4f46e5", "#6366f1"],
        animation_speed=1.5,
    ),
    EducationLevel.UNIVERSITY: GradeProfile(
        level=EducationLevel.UNIVERSITY,
        thinking_style="极限思想：无穷小、连续变化、严格证明",
        visualization_style="极限动画、积分面积、3D曲面",
        available_skills=[
            "limit_epsilon_delta", "derivative_tangent",
            "integral_area", "taylor_series", "multivariable_3d"
        ],
        colors=["#1e293b", "#334155", "#3b82f6", "#22d3ee"],
        animation_speed=1.5,
        use_3d=True,
    ),
}
