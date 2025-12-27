"""
Grade value object - represents education levels and their configurations
"""
from dataclasses import dataclass, field
from enum import Enum


class EducationLevel(str, Enum):
    """Education levels supported by the system"""
    
    ELEMENTARY_LOWER = "elementary_lower"  # 小学低年级 1-3
    ELEMENTARY_UPPER = "elementary_upper"  # 小学高年级 4-6
    MIDDLE_SCHOOL = "middle"               # 初中 7-9
    HIGH_SCHOOL = "high"                   # 高中 10-12
    ADVANCED = "advanced"                  # 高等数学
    
    @property
    def display_name(self) -> str:
        names = {
            "elementary_lower": "小学低年级",
            "elementary_upper": "小学高年级",
            "middle": "初中",
            "high": "高中",
            "advanced": "高等数学",
        }
        return names.get(self.value, self.value)


@dataclass
class GradeProfile:
    """Configuration profile for a grade level"""
    
    level: EducationLevel
    thinking_style: str
    visualization_style: str
    example_problem: str  # Example problem for this grade
    available_skills: list[str] = field(default_factory=list)
    
    # Visual style configuration
    colors: list[str] = field(default_factory=list)
    animation_speed: float = 1.0
    use_icons: bool = False
    use_3d: bool = False


# Pre-defined grade profiles with example problems
GRADE_PROFILES: dict[EducationLevel, GradeProfile] = {
    EducationLevel.ELEMENTARY_LOWER: GradeProfile(
        level=EducationLevel.ELEMENTARY_LOWER,
        thinking_style="具象思维：画图法、实物演示",
        visualization_style="卡通图标、实物动画、色彩鲜明",
        example_problem="小明有5个苹果，吃了2个，还剩几个？",
        available_skills=["counting", "addition", "subtraction"],
        colors=["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"],
        animation_speed=0.8,
        use_icons=True,
    ),
    EducationLevel.ELEMENTARY_UPPER: GradeProfile(
        level=EducationLevel.ELEMENTARY_UPPER,
        thinking_style="数学思维：假设法、逆推法、列表法",
        visualization_style="图形动画、表格对比、分步图解",
        example_problem="鸡兔同笼，头35，脚94，各多少？",
        available_skills=[
            "counting", "addition", "subtraction", "multiplication", 
            "division", "fraction", "geometry"
        ],
        colors=["#667eea", "#764ba2", "#f093fb", "#f5576c"],
        animation_speed=1.0,
    ),
    EducationLevel.MIDDLE_SCHOOL: GradeProfile(
        level=EducationLevel.MIDDLE_SCHOOL,
        thinking_style="代数思维：方程与函数",
        visualization_style="几何图形、方程变换、坐标系",
        example_problem="解方程：2x + 5 = 13",
        available_skills=[
            "equation_balance", "coordinate_plane", "linear_graph",
            "triangle_proof", "geometry"
        ],
        colors=["#00c6ff", "#0072ff", "#7c3aed", "#2dd4bf"],
        animation_speed=1.2,
    ),
    EducationLevel.HIGH_SCHOOL: GradeProfile(
        level=EducationLevel.HIGH_SCHOOL,
        thinking_style="初等数学深化：数形结合、分类讨论",
        visualization_style="函数图像、向量动画、3D视图",
        example_problem="求函数 f(x) = x² - 4x + 3 的最小值",
        available_skills=[
            "quadratic_parabola", "trigonometry_circle", 
            "vector_arrow", "sequence_series"
        ],
        colors=["#1e3a8a", "#3730a3", "#4f46e5", "#6366f1"],
        animation_speed=1.5,
    ),
    EducationLevel.ADVANCED: GradeProfile(
        level=EducationLevel.ADVANCED,
        thinking_style="高等数学：极限、微积分、线性代数",
        visualization_style="极限动画、积分面积、3D曲面",
        example_problem="求极限：lim(x→0) sin(x)/x",
        available_skills=[
            "limit_epsilon_delta", "derivative_tangent",
            "integral_area", "taylor_series", "multivariable_3d"
        ],
        colors=["#1e293b", "#334155", "#3b82f6", "#22d3ee"],
        animation_speed=1.5,
        use_3d=True,
    ),
}
