"""Value objects"""
from .grade import EducationLevel, GradeProfile, GRADE_PROFILES
from .visual_styles import VisualStyle, VISUAL_STYLES, get_style_for_grade

__all__ = [
    "EducationLevel",
    "GradeProfile",
    "GRADE_PROFILES",
    "VisualStyle",
    "VISUAL_STYLES",
    "get_style_for_grade",
]
