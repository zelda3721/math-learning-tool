"""
Application settings using Pydantic
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application configuration"""
    
    # API Settings
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_debug: bool = False
    
    # LLM Settings
    llm_api_base: str = "https://api.deepseek.com"
    llm_api_key: str = ""
    llm_model: str = "deepseek-chat"
    llm_temperature: float = 0.6
    llm_max_tokens: int = 8192
    
    # Manim Settings
    manim_quality: Literal["low", "medium", "high"] = "low"
    manim_output_dir: str = "./media"
    manim_use_latex: bool = False
    
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
    
    model_config = {
        "env_file": "../.env",  # .env is in project root, one level up from backend/
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()
