"""Builtin tools and a factory that wires them with their dependencies."""
from __future__ import annotations

from ....application.interfaces import (
    ILLMProvider,
    IRerankProvider,
    ISkillRepository,
    IVideoGenerator,
)
from ...storage import ExamplesStore, SemanticIndex
from ..learned_memory import LearnedMemory
from ..prompt_library import PromptLibrary
from ..tool_registry import ToolRegistry
from .analyze_problem import AnalyzeProblemTool
from .generate_manim_code import GenerateManimCodeTool
from .inspect_video import InspectVideoTool
from .match_skill import MatchSkillTool
from .run_manim import RunManimTool
from .search_examples import SearchExamplesTool
from .solve_problem import SolveProblemTool
from .validate_manim_code import ValidateManimCodeTool

__all__ = [
    "AnalyzeProblemTool",
    "SolveProblemTool",
    "MatchSkillTool",
    "SearchExamplesTool",
    "GenerateManimCodeTool",
    "ValidateManimCodeTool",
    "RunManimTool",
    "InspectVideoTool",
    "build_default_registry",
]


def build_default_registry(
    *,
    llm: ILLMProvider,
    skill_repo: ISkillRepository,
    examples_store: ExamplesStore,
    video_generator: IVideoGenerator,
    use_latex: bool,
    prompts: PromptLibrary,
    fast_llm: ILLMProvider | None = None,
    learned_memory: LearnedMemory | None = None,
    vision_llm: ILLMProvider | None = None,
    vision_model: str | None = None,
    semantic_index: SemanticIndex | None = None,
    rerank_provider: IRerankProvider | None = None,
    rerank_pool_size: int = 10,
) -> ToolRegistry:
    # `fast_llm` (Qwen3-4B / similar small model) handles light-duty calls;
    # the main `llm` (35B+) is reserved for code generation where quality
    # matters. Falls back to `llm` if no fast model is configured.
    light_llm = fast_llm or llm
    registry = ToolRegistry()
    registry.register(AnalyzeProblemTool(light_llm, prompts))
    registry.register(SolveProblemTool(light_llm, prompts))
    registry.register(
        MatchSkillTool(
            skill_repo,
            llm=light_llm,
            prompts=prompts,
            semantic_index=semantic_index,
        )
    )
    registry.register(
        SearchExamplesTool(
            examples_store,
            semantic_index=semantic_index,
            rerank_provider=rerank_provider,
            rerank_pool_size=rerank_pool_size,
        )
    )
    registry.register(
        GenerateManimCodeTool(
            llm=llm,
            skill_repo=skill_repo,
            prompts=prompts,
            use_latex=use_latex,
            examples_store=examples_store,
            learned_memory=learned_memory,
        )
    )
    registry.register(ValidateManimCodeTool())
    registry.register(RunManimTool(video_generator))
    if vision_llm is not None:
        registry.register(
            InspectVideoTool(vision_llm, prompts, vision_model=vision_model)
        )
    return registry
