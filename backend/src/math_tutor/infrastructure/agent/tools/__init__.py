"""Builtin tools and a factory that wires them with their dependencies."""

from __future__ import annotations

from ....application.interfaces import (
    ILLMProvider,
    IVideoGenerator,
)
from ...media import NarrationPostProcessor
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
from .verify_solution import VerifySolutionTool
from .visual_plan import VisualPlanTool

__all__ = [
    "AnalyzeProblemTool",
    "SolveProblemTool",
    "VerifySolutionTool",
    "VisualPlanTool",
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
    video_generator: IVideoGenerator,
    use_latex: bool,
    prompts: PromptLibrary,
    fast_llm: ILLMProvider | None = None,
    vision_llm: ILLMProvider | None = None,
    vision_model: str | None = None,
    narration: NarrationPostProcessor | None = None,
    subtitles_enabled: bool = True,
) -> ToolRegistry:
    # `fast_llm` (Qwen3-4B / similar small model) handles light-duty calls;
    # the main `llm` (35B+) is reserved for code generation where quality
    # matters. Falls back to `llm` if no fast model is configured.
    light_llm = fast_llm or llm
    registry = ToolRegistry()
    registry.register(AnalyzeProblemTool(light_llm, prompts))
    registry.register(SolveProblemTool(light_llm, prompts))
    registry.register(VerifySolutionTool(light_llm, prompts))
    registry.register(VisualPlanTool(light_llm, prompts))
    # The legacy match/search tools remain importable for offline analysis,
    # but are deliberately absent from the production registry.  Exposing
    # them to the controller encouraged type routing and injected single-task
    # examples into unseen problems.
    registry.register(
        GenerateManimCodeTool(
            llm=llm,
            prompts=prompts,
            use_latex=use_latex,
        )
    )
    registry.register(ValidateManimCodeTool(light_llm, prompts))
    registry.register(
        RunManimTool(
            video_generator,
            narration=narration,
            subtitles_enabled=subtitles_enabled,
        )
    )
    if vision_llm is not None:
        registry.register(InspectVideoTool(vision_llm, prompts, vision_model=vision_model))
    return registry
