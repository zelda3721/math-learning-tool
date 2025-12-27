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
from ..infrastructure.agents.langgraph_engine import LangGraphEngine


_skill_repo_instance: ISkillRepository | None = None


def get_skill_repository() -> ISkillRepository:
    """Get cached skill repository instance"""
    global _skill_repo_instance
    if _skill_repo_instance is None:
        skills_dir = Path(__file__).parent.parent / "infrastructure" / "skills" / "definitions"
        _skill_repo_instance = FileSkillRepository(skills_dir)
    return _skill_repo_instance


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
    """Get LLM service instance (legacy)"""
    return LangChainService(skill_repository=skill_repository)


# Note: We don't cache LangGraphEngine here because it depends on skill_repository which is a Depends dependency.
# If we want caching, we should cache the internal build_workflow result or use a singleton pattern.
# For now, instantiating per request is safe as compiled graph is lightweight or we can optimize later.
def get_langgraph_engine(
    skill_repository: ISkillRepository = Depends(get_skill_repository),
) -> LangGraphEngine:
    """Get LangGraph workflow engine"""
    return LangGraphEngine(skill_repo=skill_repository)

