"""
Visualization Agent - Refactored into modular structure

Original: agents/visualization.py (1149 lines)
Refactored into:
- base.py: Core VisualizationAgent class
- problem_handlers.py: Problem type specific handlers
- code_generator.py: Manim code generation utilities
"""
from .base import VisualizationAgent
from .problem_handlers import (
    ContinuousOperationHandler,
    GeometryHandler,
    WordProblemHandler,
)
from .code_generator import ManimCodeGenerator

__all__ = [
    "VisualizationAgent",
    "ContinuousOperationHandler",
    "GeometryHandler",
    "WordProblemHandler",
    "ManimCodeGenerator",
]
