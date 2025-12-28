"""
Video Generator Interface - Port for video generation
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal


@dataclass
class VideoResult:
    """Result of video generation"""
    success: bool
    video_path: str = ""
    error_message: str = ""


class IVideoGenerator(ABC):
    """
    Video generator interface.
    
    This is a Port in the Ports & Adapters pattern.
    The Manim executor is an implementation (Adapter) in infrastructure.
    """
    
    @abstractmethod
    def execute_code(self, code: str) -> VideoResult:
        """
        Execute Manim code and generate video.
        
        Args:
            code: Manim Python code
            
        Returns:
            VideoResult with success status and path
        """
        ...
    
    @abstractmethod
    def set_quality(self, quality: Literal["low", "medium", "high"]) -> None:
        """
        Set the video rendering quality.
        
        Args:
            quality: Quality level
        """
        ...
