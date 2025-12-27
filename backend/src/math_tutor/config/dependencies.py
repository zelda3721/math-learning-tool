"""
Dependency Injection Configuration

Uses FastAPI's Depends for dependency injection,
following Clean Architecture's Dependency Inversion Principle.
"""
from functools import lru_cache
from pathlib import Path

from fastapi import Depends

from .settings import Settings, get_settings
from ..application.interfaces import ISkillRepository, ILLMService, IVideoGenerator
from ..infrastructure.skills import FileSkillRepository
from ..infrastructure.manim import ManimExecutor
from ..infrastructure.llm import LangChainService


@lru_cache
def get_skill_repository(
    settings: Settings = Depends(get_settings),
) -> ISkillRepository:
    """Get cached skill repository instance"""
    skills_dir = Path(__file__).parent.parent / "infrastructure" / "skills" / "definitions"
    return FileSkillRepository(skills_dir)


def get_video_generator(
    settings: Settings = Depends(get_settings),
) -> IVideoGenerator:
    """Get video generator (Manim executor)"""
    return ManimExecutor(
        output_dir=settings.manim_output_dir,
        quality=settings.manim_quality,
    )


def get_llm_service(
    settings: Settings = Depends(get_settings),
    skill_repository: ISkillRepository = Depends(get_skill_repository),
) -> ILLMService:
    """Get LLM service instance"""
    return LangChainService(skill_repository=skill_repository)
