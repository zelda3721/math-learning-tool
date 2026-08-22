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
from .compile_video import CompileVideoTool
from .direct_video import DirectVideoTool
from .generate_manim_code import GenerateManimCodeTool
from .generate_web_explanation import GenerateWebExplanationTool
from .inspect_video import InspectVideoTool
from .match_skill import MatchSkillTool
from .run_manim import RunManimTool
from .search_examples import SearchExamplesTool
from .solve_problem import SolveProblemTool
from .validate_manim_code import ValidateManimCodeTool
from .verify_solution import VerifySolutionTool
from .visual_plan import VisualPlanTool
from .watch_video import WatchVideoTool

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
    "DirectVideoTool",
    "CompileVideoTool",
    "WatchVideoTool",
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
    reasoner_llm: ILLMProvider | None = None,
    escalation_llm: ILLMProvider | None = None,
    vision_model: str | None = None,
    narration: NarrationPostProcessor | None = None,
    subtitles_enabled: bool = True,
) -> ToolRegistry:
    # `fast_llm` (Qwen3-4B / similar small model) handles light-duty calls;
    # the main `llm` (35B+) is reserved for code generation where quality
    # matters. Falls back to `llm` if no fast model is configured.
    light_llm = fast_llm or llm
    # 对错攸关的两步（solve/verify）走重推理端点；其余走轻端点——重复性基准（2026-08-22）：
    # qwen3.8 答案 3/4 对且从不出错、qwen3.6 只有 1/4——"对"必须交给对得起它的模型
    heavy_llm = reasoner_llm or light_llm
    registry = ToolRegistry()
    # solve/verify 带图时走各自的 vision_llm——重推理端点若配置了（要求多模态），
    # 图也必须给它看，否则带图题（最需要它的场景）会绕回轻模型
    heavy_vision = reasoner_llm or vision_llm or llm
    # 原图转写走视觉端点（没配就退回主模型）；解题/导演各自在需要时触发一次
    registry.register(
        SolveProblemTool(heavy_llm, prompts, vision_llm=heavy_vision, escalation_llm=escalation_llm)
    )
    registry.register(VerifySolutionTool(heavy_llm, prompts, vision_llm=heavy_vision))
    director = DirectVideoTool(VisualPlanTool(light_llm, prompts, vision_llm=vision_llm or llm))
    registry.register(director)
    # The legacy match/search tools remain importable for offline analysis,
    # but are deliberately absent from the production registry.  Exposing
    # them to the controller encouraged type routing and injected single-task
    # examples into unseen problems.
    # 模型直写 Web 讲解：与 Manim 通道的 model_codegen 同构，但门禁更严
    # （生成物是标记语言，可以直接数元素，不必在 JPEG 上做连通域计数）。
    # 内部注册——由 /api/v1/plan?route=html 直接调用；控制器看到的仍是五个阶段，
    # 否则它可能在出视频的中途拐去写网页。
    registry.register_internal(GenerateWebExplanationTool(llm=llm, prompts=prompts))
    writer = GenerateManimCodeTool(
        llm=llm,
        prompts=prompts,
        use_latex=use_latex,
    )
    validator = ValidateManimCodeTool(light_llm, prompts)
    renderer = RunManimTool(
        video_generator,
        narration=narration,
        subtitles_enabled=subtitles_enabled,
    )
    compiler = CompileVideoTool(writer, validator, renderer)
    registry.register(compiler)
    if vision_llm is not None:
        registry.register(
            WatchVideoTool(
                InspectVideoTool(vision_llm, prompts, vision_model=vision_model),
                compiler,
                director,
            )
        )
    return registry
