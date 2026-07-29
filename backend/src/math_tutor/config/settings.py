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

# Resolve the .env path absolutely (anchored to this file), so the loader
# works regardless of which directory the process was started from.
# settings.py → config/ → math_tutor/ → src/ → backend/ → <project_root>
_PROJECT_ROOT = Path(__file__).resolve().parents[4]
_ENV_FILE = _PROJECT_ROOT / ".env"


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
    # Deterministic bounded orchestration skips the extra controller-model
    # call between tools. Disable only for experiments with a free-form agent.
    agent_deterministic_workflow: bool = True
    # Cap for legacy free-form AgentLoop streaming calls.
    # Tools have their own much larger budgets; this only limits how long the
    # agent rambles between tool calls.
    # 4096 is the safe default for thinking-on backends: Gemma 4 / Qwen3.5+
    # routinely consume 2000-3500 reasoning tokens before emitting tool_calls;
    # at 2048 they often hit `finish_reason='length'` BEFORE outputting any
    # tool_call, manifesting as "only thinking, no progress" (see
    # lmstudio-bug-tracker#1559 / llama.cpp#21338). Bump higher (6144-8192)
    # if you see frequent only_thinking_no_tool_calls errors.
    llm_agent_loop_max_tokens: int = 4096
    llm_request_timeout: float = 180.0
    # Per-tool execution wall-clock cap. Generate_manim_code on a quantized
    # 35B model can legitimately take 2-3 min; bump above llm_request_timeout
    # if you switch to a slower model.
    llm_tool_timeout_s: float = 300.0
    # Typical happy path needs exactly 8 transitions. A complete visual
    # fallback (replan → regenerate → validate → render → inspect)
    # needs 13 total. Per-stage limits in AgentLoop allow only one fallback;
    # this global ceiling is a final circuit breaker, not a retry strategy.
    llm_agent_max_turns: int = 14
    # JSON string. Forwarded as `extra_body` to the OpenAI client. Useful for
    # provider-specific knobs like {"chat_template_kwargs": {"enable_thinking": true}}.
    llm_extra_body: str = ""
    # When tools are present, force `enable_thinking=False` in chat_template_kwargs.
    # Qwen3-style models otherwise spend many tokens thinking before emitting
    # tool_calls (or hang the LMStudio template renderer entirely). Set to
    # False if you actually want thinking + tools and your provider handles it.
    llm_disable_thinking_with_tools: bool = True

    # Fast LLM endpoint — routes analyze/solve/verify/visual-plan calls to a
    # smaller / faster model
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

    # Embedding endpoint retained for offline skill/example exploration. It
    # is not part of the production video workflow.
    llm_embedding_api_base: str = ""
    llm_embedding_api_key: str = ""
    llm_embedding_model: str = ""
    llm_embedding_dimension: int = 0  # 0 = auto / let the model decide

    # Reranker endpoint retained for offline retrieval experiments. Two API
    # shapes are supported:
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
    # Medium is Manim's 720p/30fps profile: suitable for first-view student
    # videos. Low remains available explicitly for draft/debug rendering.
    manim_quality: Literal["low", "medium", "high"] = "medium"
    manim_output_dir: str = "./media"
    manim_use_latex: bool = False
    # Medium-quality educational scenes should normally finish well below
    # this; a longer zero-progress render is usually a broken updater/loop.
    manim_render_timeout_s: float = 180.0

    # Every visual beat is exported as a WebVTT caption track. Optional TTS
    # uses an OpenAI-compatible /audio/speech endpoint and gracefully falls
    # back to captions when the endpoint is unavailable.
    narration_subtitles_enabled: bool = True
    narration_tts_enabled: bool = False
    narration_tts_api_base: str = ""
    narration_tts_api_key: str = ""
    narration_tts_model: str = "tts-1"
    narration_tts_voice: str = "alloy"
    narration_tts_speed: float = 1.05
    narration_tts_timeout_s: float = 60.0

    # Storage (sessions / artifacts / examples)
    data_dir: str = "./data"
    db_path: str = ""  # if empty, derived as {data_dir}/math_tutor.sqlite

    # Learned Wiki (Karpathy-style auto-evolving KB).
    # When enabled, each completed session triggers a background "ingester"
    # that asks the fast LLM whether anything non-trivial was learned and,
    # if so, writes a quarantined candidate; only repeated cross-session
    # evidence is promoted under {data_dir}/learned_wiki/lessons/.
    # Future RITL-DOC retrievals merge static manim_api_kb.md + learned wiki.
    # Disabled by default — opt-in for safety (LLM-written lessons can be
    # noisy until you've watched a few rounds).
    learned_wiki_enabled: bool = False
    learned_wiki_dir: str = ""  # if empty, derived as {data_dir}/learned_wiki

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

    @property
    def resolved_learned_wiki_dir(self) -> Path:
        """Absolute path to the learned wiki directory."""
        if self.learned_wiki_dir:
            return Path(self.learned_wiki_dir).expanduser().resolve()
        return self.resolved_data_dir / "learned_wiki"

    model_config = {
        "env_file": str(_ENV_FILE),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    if not _ENV_FILE.exists():
        logger.warning(
            ".env file not found at %s — falling back to defaults / process env. "
            "Model name and endpoints will be the in-code defaults.",
            _ENV_FILE,
        )
    return Settings()
