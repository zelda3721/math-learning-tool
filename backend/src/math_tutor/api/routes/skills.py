"""
Skills API endpoints
"""
from fastapi import APIRouter, Depends

from ...domain.value_objects import EducationLevel

router = APIRouter()


@router.get("")
async def list_skills(grade: EducationLevel | None = None) -> dict:
    """List available skills, optionally filtered by grade"""
    # TODO: Inject ISkillRepository via dependency
    return {
        "message": "Skills listing - to be implemented with skill repository",
        "filter_grade": grade.value if grade else None,
    }


@router.get("/{skill_name}")
async def get_skill(skill_name: str) -> dict:
    """Get details for a specific skill"""
    # TODO: Inject ISkillRepository via dependency
    return {
        "message": f"Skill details for '{skill_name}' - to be implemented",
    }
