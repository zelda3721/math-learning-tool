"""
Manim Executor - Executes Manim code and generates videos

Refactored from core/manim_executor.py with Clean Architecture principles.
Implements IVideoGenerator interface.
"""
import logging
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Literal

from ...application.interfaces.video_generator import IVideoGenerator, VideoResult
from ...config import get_settings

logger = logging.getLogger(__name__)


class ManimExecutor(IVideoGenerator):
    """
    Manim code executor that generates visualization videos.
    
    Implements the IVideoGenerator port from the application layer.
    """
    
    def __init__(
        self,
        output_dir: str | None = None,
        quality: Literal["low", "medium", "high"] = "low",
    ):
        settings = get_settings()
        self.output_dir = Path(output_dir or settings.manim_output_dir)
        self.quality = quality
        
        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"ManimExecutor initialized: output={self.output_dir}, quality={self.quality}")
    
    def set_quality(self, quality: Literal["low", "medium", "high"]) -> None:
        """Set video rendering quality"""
        self.quality = quality
    
    def execute_code(self, code: str) -> VideoResult:
        """
        Execute Manim code and generate video.
        
        Args:
            code: Manim Python code
            
        Returns:
            VideoResult with success status, path, and error if any
        """
        file_id = str(uuid.uuid4())
        temp_dir = Path(tempfile.gettempdir())
        script_path = temp_dir / f"manim_script_{file_id}.py"
        
        try:
            # Sanitize code
            code = self._sanitize_code(code)
            
            # Validate syntax
            try:
                compile(code, str(script_path), "exec")
            except SyntaxError as e:
                logger.error(f"Syntax error in code: {e}")
                return VideoResult(success=False, error_message=f"Syntax error: {e}")
            
            # Write code to temp file
            script_path.write_text(code, encoding="utf-8")
            logger.debug(f"Wrote Manim script to: {script_path}")
            
            # Extract scene name
            scene_name = self._extract_scene_name(code)
            if not scene_name:
                return VideoResult(
                    success=False,
                    error_message="Could not find Scene class in code",
                )
            
            # Build command
            quality_flag = self._get_quality_flag()
            cmd = [
                sys.executable,
                "-m",
                "manim",
                quality_flag,
                f"--media_dir={self.output_dir}",
                str(script_path),
                scene_name,
            ]
            
            logger.info(f"Executing: {' '.join(cmd)}")
            
            # Run manim
            process = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
            )
            
            if process.returncode == 0:
                video_path = self._find_video_file(scene_name)
                if video_path:
                    logger.info(f"Video generated: {video_path}")
                    return VideoResult(success=True, video_path=str(video_path))
                return VideoResult(
                    success=False,
                    error_message="Video file not found after execution",
                )
            else:
                logger.error(f"Manim execution failed: {process.stderr}")
                return VideoResult(
                    success=False,
                    error_message=f"Execution error: {process.stderr}",
                )
        
        except Exception as e:
            logger.exception(f"Error executing Manim code: {e}")
            return VideoResult(success=False, error_message=str(e))
        
        finally:
            # Cleanup temp file
            if script_path.exists():
                try:
                    script_path.unlink()
                except Exception:
                    pass
    
    def _get_quality_flag(self) -> str:
        """Get manim quality flag"""
        return {
            "low": "-ql",
            "medium": "-qm",
            "high": "-qh",
        }.get(self.quality, "-ql")
    
    def _sanitize_code(self, code: str) -> str:
        """
        Clean and fix common issues in generated code.
        
        Handles LLM hallucinations like invalid APIs, colors, etc.
        """
        # Remove invalid rate_func parameters
        code = re.sub(
            r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)",
            "",
            code,
        )
        
        # Replace invalid color names with valid ones
        invalid_colors = [
            "ORANGE_E", "BLUE_D", "BLUE_E", "RED_A", 
            "GREEN_E", "GREEN_D", "YELLOW_E",
        ]
        for color in invalid_colors:
            code = re.sub(rf"\b{color}\b", "BLUE", code)
        
        # Remove non-existent method calls
        code = re.sub(r"\.get_text\(\)", "", code)
        
        # Add default scene if none found
        if "class" not in code or "Scene" not in code:
            code += '''

# Default Scene
class DefaultMathVisualization(Scene):
    def construct(self):
        title = Text("数学可视化")
        self.play(Write(title))
        self.wait(2)
        self.play(FadeOut(title))
'''
        
        return code
    
    def _extract_scene_name(self, code: str) -> str | None:
        """Extract Scene class name from code"""
        pattern = r"class\s+(\w+)\s*\(\s*Scene\s*\)"
        match = re.search(pattern, code)
        return match.group(1) if match else None
    
    def _find_video_file(self, scene_name: str) -> Path | None:
        """Find the generated video file"""
        video_dir = self.output_dir / "videos"
        if not video_dir.exists():
            video_dir = self.output_dir
        
        latest_video = None
        latest_time = 0.0
        
        for file_path in video_dir.rglob("*"):
            if scene_name in file_path.name and file_path.suffix in (".mp4", ".mov"):
                mtime = file_path.stat().st_mtime
                if mtime > latest_time:
                    latest_time = mtime
                    latest_video = file_path
        
        return latest_video
