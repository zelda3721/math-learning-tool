"""
Dependency Injection Configuration

Uses FastAPI's Depends for dependency injection,
following Clean Architecture's Dependency Inversion Principle.
"""
from functools import lru_cache
from pathlib import Path

from fastapi import Depends

from .settings import Settings, get_settings
from ..application.interfaces import (
    IEmbeddingProvider,
    ILLMProvider,
    IRerankProvider,
    ISkillRepository,
    IVideoGenerator,
)
from ..infrastructure.skills import FileSkillRepository
from ..infrastructure.manim import ManimExecutor
from ..infrastructure.llm import (
    OpenAIEmbeddingProvider,
    OpenAILLMProvider,
    OpenAIRerankProvider,
)
from ..infrastructure.agent import (
    AgentLoop,
    LearnedMemory,
    PromptComposer,
    PromptLibrary,
    ToolRegistry,
)
from ..infrastructure.agent.learned_wiki import LearnedWiki
from ..infrastructure.agent.tools import build_default_registry
from ..infrastructure.agent.wiki_ingester import WikiIngester
from ..infrastructure.storage import (
    ConversationStore,
    Database,
    ExamplesStore,
    FileArchive,
    SemanticIndex,
)


_skill_repo_instance: ISkillRepository | None = None
_database_instance: Database | None = None
_file_archive_instance: FileArchive | None = None
_llm_provider_instance: ILLMProvider | None = None
_fast_llm_provider_instance: ILLMProvider | None = None
_vision_provider_instance: ILLMProvider | None = None
_embedding_provider_instance: IEmbeddingProvider | None = None
_semantic_index_instance: SemanticIndex | None = None
_rerank_provider_instance: IRerankProvider | None = None
_learned_memory_instance: LearnedMemory | None = None
_prompt_library_instance: PromptLibrary | None = None


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


# --- Storage and provider singletons ---------------------------------------


def _get_database(settings: Settings) -> Database:
    global _database_instance
    if _database_instance is None:
        _database_instance = Database(settings.resolved_db_path)
    return _database_instance


def _get_file_archive(settings: Settings) -> FileArchive:
    global _file_archive_instance
    if _file_archive_instance is None:
        _file_archive_instance = FileArchive(settings.resolved_data_dir)
    return _file_archive_instance


def get_database(
    settings: Settings = Depends(get_settings),
) -> Database:
    return _get_database(settings)


def get_file_archive(
    settings: Settings = Depends(get_settings),
) -> FileArchive:
    return _get_file_archive(settings)


def get_conversation_store(
    settings: Settings = Depends(get_settings),
) -> ConversationStore:
    return ConversationStore(_get_database(settings), _get_file_archive(settings))


def get_examples_store(
    settings: Settings = Depends(get_settings),
) -> ExamplesStore:
    return ExamplesStore(_get_database(settings))


def _get_llm_provider(settings: Settings) -> ILLMProvider:
    global _llm_provider_instance
    if _llm_provider_instance is None:
        _llm_provider_instance = OpenAILLMProvider(
            base_url=settings.llm_api_base,
            api_key=settings.llm_api_key,
            default_model=settings.llm_model,
            default_temperature=settings.llm_temperature,
            default_max_tokens=settings.llm_max_tokens,
            timeout=settings.llm_request_timeout,
            default_extra_body=settings.llm_extra_body_dict,
            disable_thinking_with_tools=settings.llm_disable_thinking_with_tools,
        )
    return _llm_provider_instance


def get_llm_provider(
    settings: Settings = Depends(get_settings),
) -> ILLMProvider:
    """OpenAI-compatible LLM provider used by the new agent loop."""
    return _get_llm_provider(settings)


def _get_fast_llm_provider(settings: Settings) -> ILLMProvider:
    """Light-duty LLM (analyze / solve / match_skill fallback). Falls back
    to the main provider when no fast model is configured."""
    if not settings.fast_llm_enabled:
        return _get_llm_provider(settings)
    global _fast_llm_provider_instance
    if _fast_llm_provider_instance is None:
        _fast_llm_provider_instance = OpenAILLMProvider(
            base_url=settings.resolved_fast_api_base,
            api_key=settings.resolved_fast_api_key,
            default_model=settings.resolved_fast_model,
            default_temperature=settings.llm_temperature,
            default_max_tokens=settings.llm_max_tokens,
            timeout=settings.llm_request_timeout,
            default_extra_body=settings.llm_extra_body_dict,
            disable_thinking_with_tools=settings.llm_disable_thinking_with_tools,
        )
    return _fast_llm_provider_instance


def get_fast_llm_provider(
    settings: Settings = Depends(get_settings),
) -> ILLMProvider:
    return _get_fast_llm_provider(settings)


def _get_vision_provider(settings: Settings) -> ILLMProvider:
    """Provider for multimodal calls (inspect_video). Falls back to the
    main LLM provider when vision-specific config is empty."""
    base = settings.resolved_vision_api_base
    model = settings.resolved_vision_model
    if base == settings.llm_api_base and model == settings.llm_model:
        # Identical to main → reuse the singleton
        return _get_llm_provider(settings)
    global _vision_provider_instance
    if _vision_provider_instance is None:
        _vision_provider_instance = OpenAILLMProvider(
            base_url=base,
            api_key=settings.resolved_vision_api_key,
            default_model=model,
            default_temperature=0.2,
            default_max_tokens=settings.llm_max_tokens,
            timeout=settings.llm_request_timeout,
            default_extra_body=settings.llm_extra_body_dict,
            disable_thinking_with_tools=settings.llm_disable_thinking_with_tools,
        )
    return _vision_provider_instance


def get_vision_provider(
    settings: Settings = Depends(get_settings),
) -> ILLMProvider:
    return _get_vision_provider(settings)


def _get_embedding_provider(settings: Settings) -> IEmbeddingProvider | None:
    """Returns None when no embedding model is configured."""
    if not settings.embedding_enabled:
        return None
    global _embedding_provider_instance
    if _embedding_provider_instance is None:
        _embedding_provider_instance = OpenAIEmbeddingProvider(
            base_url=settings.resolved_embedding_api_base,
            api_key=settings.resolved_embedding_api_key,
            model=settings.resolved_embedding_model,
            dimension=settings.llm_embedding_dimension,
            timeout=settings.llm_request_timeout,
        )
    return _embedding_provider_instance


def get_embedding_provider(
    settings: Settings = Depends(get_settings),
) -> IEmbeddingProvider | None:
    return _get_embedding_provider(settings)


def _get_semantic_index(settings: Settings) -> SemanticIndex | None:
    provider = _get_embedding_provider(settings)
    if provider is None:
        return None
    global _semantic_index_instance
    if _semantic_index_instance is None:
        _semantic_index_instance = SemanticIndex(provider)
    return _semantic_index_instance


def get_semantic_index(
    settings: Settings = Depends(get_settings),
) -> SemanticIndex | None:
    return _get_semantic_index(settings)


def _get_rerank_provider(settings: Settings) -> IRerankProvider | None:
    """Returns None when reranking is disabled."""
    if not settings.rerank_enabled:
        return None
    global _rerank_provider_instance
    if _rerank_provider_instance is None:
        _rerank_provider_instance = OpenAIRerankProvider(
            base_url=settings.resolved_rerank_api_base,
            api_key=settings.resolved_rerank_api_key,
            model=settings.resolved_rerank_model,
            api_type=settings.llm_rerank_api_type,
            timeout=settings.llm_request_timeout,
        )
    return _rerank_provider_instance


def get_rerank_provider(
    settings: Settings = Depends(get_settings),
) -> IRerankProvider | None:
    return _get_rerank_provider(settings)


_tool_registry_instance: ToolRegistry | None = None


def _get_learned_memory(settings: Settings) -> LearnedMemory:
    global _learned_memory_instance
    if _learned_memory_instance is None:
        _learned_memory_instance = LearnedMemory(settings.resolved_data_dir)
    return _learned_memory_instance


def get_learned_memory(
    settings: Settings = Depends(get_settings),
) -> LearnedMemory:
    return _get_learned_memory(settings)


def _get_prompt_library() -> PromptLibrary:
    global _prompt_library_instance
    if _prompt_library_instance is None:
        _prompt_library_instance = PromptLibrary()
    return _prompt_library_instance


def _get_tool_registry(settings: Settings) -> ToolRegistry:
    global _tool_registry_instance
    if _tool_registry_instance is None:
        _tool_registry_instance = build_default_registry(
            llm=_get_llm_provider(settings),
            fast_llm=_get_fast_llm_provider(settings),
            skill_repo=get_skill_repository(),
            examples_store=ExamplesStore(_get_database(settings)),
            video_generator=ManimExecutor(
                output_dir=settings.manim_output_dir,
                quality=settings.manim_quality,
            ),
            use_latex=settings.manim_use_latex,
            prompts=_get_prompt_library(),
            learned_memory=_get_learned_memory(settings),
            vision_llm=_get_vision_provider(settings),
            vision_model=settings.resolved_vision_model,
            semantic_index=_get_semantic_index(settings),
            rerank_provider=_get_rerank_provider(settings),
            rerank_pool_size=settings.llm_rerank_pool_size,
        )
    return _tool_registry_instance


def get_tool_registry(
    settings: Settings = Depends(get_settings),
) -> ToolRegistry:
    return _get_tool_registry(settings)


def get_agent_loop(
    settings: Settings = Depends(get_settings),
) -> AgentLoop:
    """Construct an AgentLoop bound to the singleton dependencies."""
    # Optional learned-wiki ingester (LEARNED_WIKI_ENABLED=true)
    wiki_ingester = None
    if settings.learned_wiki_enabled:
        wiki = LearnedWiki(settings.resolved_learned_wiki_dir)
        # Tell the RITL-DOC retriever to merge in learned lessons too
        from ..infrastructure.agent.manim_api_kb import get_kb as _get_manim_kb
        _get_manim_kb().set_learned_wiki_dir(settings.resolved_learned_wiki_dir)
        # _get_fast_llm_provider falls back to main LLM internally if no
        # FAST endpoint configured — always returns a valid provider.
        ingest_llm = _get_fast_llm_provider(settings)
        wiki_ingester = WikiIngester(
            wiki=wiki,
            llm=ingest_llm,
            prompts=_get_prompt_library(),
            store=ConversationStore(
                _get_database(settings), _get_file_archive(settings)
            ),
        )

    return AgentLoop(
        llm=_get_llm_provider(settings),
        registry=_get_tool_registry(settings),
        composer=PromptComposer(),
        store=ConversationStore(_get_database(settings), _get_file_archive(settings)),
        use_latex=settings.manim_use_latex,
        learned_memory=_get_learned_memory(settings),
        max_turns=settings.llm_agent_max_turns,
        per_turn_max_tokens=settings.llm_agent_loop_max_tokens,
        tool_timeout_s=settings.llm_tool_timeout_s,
        wiki_ingester=wiki_ingester,
    )
