"""
FastAPI Application Entry Point
"""
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ..config import get_settings, setup_logging
from .routes import problems, grades, skills, health

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler"""
    settings = get_settings()
    setup_logging(level="DEBUG" if settings.api_debug else "INFO")
    logger.info("Math Tutor API starting up...")
    logger.info(f"LLM Model: {settings.llm_model}")
    logger.info(f"Manim Quality: {settings.manim_quality}")
    yield
    logger.info("Math Tutor API shutting down...")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application"""
    settings = get_settings()
    
    app = FastAPI(
        title="Math Tutor API",
        description="AI-powered math tutoring tool with multi-grade support",
        version="2.0.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    
    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Mount static files for videos
    # app.mount("/videos", StaticFiles(directory=settings.manim_output_dir), name="videos")
    
    # Register routes
    app.include_router(health.router, prefix="/api", tags=["Health"])
    app.include_router(grades.router, prefix="/api/v1/grades", tags=["Grades"])
    app.include_router(skills.router, prefix="/api/v1/skills", tags=["Skills"])
    app.include_router(problems.router, prefix="/api/v1/problems", tags=["Problems"])
    
    return app


# Create the app instance
app = create_app()


if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(
        "math_tutor.api.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.api_debug,
    )
