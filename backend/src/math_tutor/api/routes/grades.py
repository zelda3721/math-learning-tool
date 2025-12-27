"""
Grades API endpoints
"""
from fastapi import APIRouter

from ...domain.value_objects import EducationLevel, GRADE_PROFILES

router = APIRouter()


@router.get("")
async def list_grades() -> list[dict]:
    """List all available education levels"""
    return [
        {
            "level": grade.value,
            "display_name": grade.display_name,
            "thinking_style": profile.thinking_style,
            "visualization_style": profile.visualization_style,
        }
        for grade, profile in GRADE_PROFILES.items()
    ]


@router.get("/{level}")
async def get_grade(level: EducationLevel) -> dict:
    """Get details for a specific education level"""
    profile = GRADE_PROFILES.get(level)
    if not profile:
        return {"error": "Grade not found"}
    
    return {
        "level": level.value,
        "display_name": level.display_name,
        "thinking_style": profile.thinking_style,
        "visualization_style": profile.visualization_style,
        "available_skills": profile.available_skills,
        "colors": profile.colors,
        "animation_speed": profile.animation_speed,
    }
