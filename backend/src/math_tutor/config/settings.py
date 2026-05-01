"""
Application settings using Pydantic
"""
import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Application configuration"""

    # API Settings
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_debug: bool = False

    # LLM Settings (defaults target LMStudio + Qwen3)
    llm_api_base: str = "http://localhost:1234/v1"
    llm_api_key: str = "lm-studio"
    llm_model: str = "qwen3.6-35b-a3b"
    llm_temperature: float = 0.6
    llm_max_tokens: int = 8192
    # Cap for the AgentLoop's main streaming calls (between-tools reasoning).
    # Tools have their own much larger budgets; this only limits how long the
    # agent rambles between tool calls. 1500-3000 is typical.
    llm_agent_loop_max_tokens: int = 2048
    llm_request_timeout: float = 180.0
    # JSON string. Forwarded as `extra_body` to the OpenAI client. Useful for
    # provider-specific knobs like {"chat_template_kwargs": {"enable_thinking": true}}.
    llm_extra_body: str = ""
    # When tools are present, force `enable_thinking=False` in chat_template_kwargs.
    # Qwen3-style models otherwise spend many tokens thinking before emitting
    # tool_calls (or hang the LMStudio template renderer entirely). Set to
    # False if you actually want thinking + tools and your provider handles it.
    llm_disable_thinking_with_tools: bool = True

    # Fast LLM endpoint — routes light-duty calls (analyze_problem,
    # solve_problem, match_skill LLM-fallback) to a smaller / faster model
    # (e.g. Qwen3-4B) while keeping the main 35B+ model for generate_manim_code
    # where code quality matters. Empty model = use main LLM (no routing).
    llm_fast_api_base: str = ""
    llm_fast_api_key: str = ""
    llm_fast_model: str = ""

    # Vision (multimodal) endpoint — used by inspect_video. If left empty,
    # falls back to the main LLM endpoint above (set them all the same when
    # your model supports both text and vision, e.g. Qwen-VL).
    llm_vision_api_base: str = ""
    llm_vision_api_key: str = ""
    llm_vision_model: str = ""

    # Embedding endpoint — used by semantic skill matching and example
    # retrieval. Leave llm_embedding_model empty to disable semantic search
    # (system falls back to substring/keyword scoring).
    llm_embedding_api_base: str = ""
    llm_embedding_api_key: str = ""
    llm_embedding_model: str = ""
    llm_embedding_dimension: int = 0  # 0 = auto / let the model decide

    # Reranker endpoint — refines embedding top-N into a more accurate top-K.
    # Used by example retrieval (and optionally skill match) as a second
    # stage after embedding shortlist. Two API shapes supported:
    #   - "cohere" (default): POST /rerank with {model, query, documents}
    #     → {results: [{index, relevance_score}]}  — used by Cohere, Jina,
    #     Infinity, voyage AI
    #   - "tei": POST /rerank with {query, texts}
    #     → [{index, score}]  — used by HuggingFace TEI
    # Toggle with llm_rerank_enabled; setting it false keeps config but
    # disables the rerank stage at runtime.
    llm_rerank_api_base: str = ""
    llm_rerank_api_key: str = ""
    llm_rerank_model: str = ""
    llm_rerank_api_type: Literal["cohere", "tei"] = "cohere"
    llm_rerank_enabled: bool = True
    llm_rerank_pool_size: int = 10  # rerank this many embedding-shortlisted candidates

    # Manim Settings
    manim_quality: Literal["low", "medium", "high"] = "low"
    manim_output_dir: str = "./media"
    manim_use_latex: bool = False

    # Storage (sessions / artifacts / examples)
    data_dir: str = "./data"
    db_path: str = ""  # if empty, derived as {data_dir}/math_tutor.sqlite

    # Performance Settings
    enable_understanding: bool = True
    enable_review: bool = False
    max_debug_attempts: int = 2

    # CORS Settings - comma-separated string parsed by validator
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        """Parse comma-separated CORS origins into a list"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def llm_extra_body_dict(self) -> dict[str, Any]:
        """Parse llm_extra_body JSON string into a dict (empty on parse failure)."""
        if not self.llm_extra_body.strip():
            return {}
        try:
            value = json.loads(self.llm_extra_body)
            if isinstance(value, dict):
                return value
            logger.warning("LLM_EXTRA_BODY must be a JSON object, got %s", type(value).__name__)
        except json.JSONDecodeError as exc:
            logger.warning("LLM_EXTRA_BODY is not valid JSON: %s", exc)
        return {}

    @property
    def resolved_fast_api_base(self) -> str:
        return self.llm_fast_api_base.strip() or self.llm_api_base

    @property
    def resolved_fast_api_key(self) -> str:
        return self.llm_fast_api_key.strip() or self.llm_api_key

    @property
    def resolved_fast_model(self) -> str:
        return self.llm_fast_model.strip() or self.llm_model

    @property
    def fast_llm_enabled(self) -> bool:
        return bool(self.llm_fast_model.strip())

    @property
    def resolved_vision_api_base(self) -> str:
        return self.llm_vision_api_base.strip() or self.llm_api_base

    @property
    def resolved_vision_api_key(self) -> str:
        return self.llm_vision_api_key.strip() or self.llm_api_key

    @property
    def resolved_vision_model(self) -> str:
        return self.llm_vision_model.strip() or self.llm_model

    @property
    def resolved_embedding_api_base(self) -> str:
        return self.llm_embedding_api_base.strip() or self.llm_api_base

    @property
    def resolved_embedding_api_key(self) -> str:
        return self.llm_embedding_api_key.strip() or self.llm_api_key

    @property
    def resolved_embedding_model(self) -> str:
        return self.llm_embedding_model.strip()  # empty == disabled

    @property
    def embedding_enabled(self) -> bool:
        return bool(self.resolved_embedding_model)

    @property
    def resolved_rerank_api_base(self) -> str:
        return self.llm_rerank_api_base.strip() or self.llm_api_base

    @property
    def resolved_rerank_api_key(self) -> str:
        return self.llm_rerank_api_key.strip() or self.llm_api_key

    @property
    def resolved_rerank_model(self) -> str:
        return self.llm_rerank_model.strip()

    @property
    def rerank_enabled(self) -> bool:
        # Need both: explicit toggle on AND a model name configured
        return bool(self.llm_rerank_enabled and self.resolved_rerank_model)

    @property
    def resolved_db_path(self) -> Path:
        """Absolute path to the SQLite database file."""
        if self.db_path:
            return Path(self.db_path).expanduser().resolve()
        return (Path(self.data_dir).expanduser() / "math_tutor.sqlite").resolve()

    @property
    def resolved_data_dir(self) -> Path:
        """Absolute path to the data directory."""
        return Path(self.data_dir).expanduser().resolve()

    model_config = {
        "env_file": "../.env",  # .env is in project root, one level up from backend/
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()
