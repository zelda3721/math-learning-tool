"""
Manim Executor - Executes Manim code and generates videos

Refactored from core/manim_executor.py with Clean Architecture principles.
Implements IVideoGenerator interface.
"""

import hashlib
import json
import logging
import re
import subprocess
import sys
import tempfile
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
        quality: Literal["low", "medium", "high"] = "medium",
        render_timeout_s: float = 300.0,
    ):
        settings = get_settings()
        self.output_dir = Path(output_dir or settings.manim_output_dir)
        self.quality = quality
        self.render_timeout_s = max(30.0, render_timeout_s)

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
        temp_dir = Path(tempfile.gettempdir())
        script_path: Path | None = None

        try:
            # Sanitize code
            code = self._sanitize_code(code)
            cache_key = hashlib.sha256(f"{self.quality}\n{code}".encode("utf-8")).hexdigest()[:24]
            cached_video = self._lookup_cached_video(cache_key)
            if cached_video is not None:
                logger.info("Manim render cache hit: %s", cache_key)
                return VideoResult(
                    success=True,
                    video_path=str(cached_video),
                    beat_manifest=self._load_cached_manifest(cache_key),
                )
            # A content-stable filename lets Manim reuse its own partial movie
            # cache when identical code is retried.
            script_path = temp_dir / f"manim_script_{cache_key}.py"

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

            # Execute construct() once with animations skipped and low quality
            # before committing to the full render. Runtime/API mistakes then
            # fail in seconds instead of consuming the entire render timeout.
            preflight_ok, preflight_error = self._run_preflight(script_path, scene_name)
            if not preflight_ok:
                return VideoResult(
                    success=False,
                    error_message=f"Preflight error: {preflight_error}",
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
                timeout=self.render_timeout_s,
            )

            if process.returncode == 0:
                # Try to parse path from stdout/stderr first
                output_log = process.stdout + "\n" + process.stderr
                video_path = self._parse_video_path_from_log(output_log)
                beat_manifest = self._parse_beat_manifest(output_log)

                if not video_path:
                    logger.warning("Could not parse video path from logs, falling back to search")
                    video_path = self._find_video_file(scene_name, script_stem=script_path.stem)

                if video_path:
                    logger.info(f"Video generated: {video_path}")
                    self._remember_cached_video(cache_key, video_path)
                    if beat_manifest is not None:
                        self._remember_cached_manifest(cache_key, beat_manifest)
                    return VideoResult(
                        success=True,
                        video_path=str(video_path),
                        beat_manifest=beat_manifest,
                    )

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

        except subprocess.TimeoutExpired:
            logger.error("Manim render timed out after %.1fs", self.render_timeout_s)
            return VideoResult(
                success=False,
                error_message=f"Rendering timed out after {self.render_timeout_s:.0f}s",
            )
        except Exception as e:
            logger.exception(f"Error executing Manim code: {e}")
            return VideoResult(success=False, error_message=str(e))

        finally:
            # Cleanup temp file
            if script_path is not None and script_path.exists():
                try:
                    script_path.unlink()
                except Exception:
                    pass

    def _cache_marker(self, cache_key: str) -> Path:
        return self.output_dir / ".render_cache" / f"{cache_key}.path"

    def _lookup_cached_video(self, cache_key: str) -> Path | None:
        marker = self._cache_marker(cache_key)
        if not marker.exists():
            return None
        try:
            candidate = Path(marker.read_text(encoding="utf-8").strip())
            if candidate.exists() and candidate.is_file():
                return candidate
        except OSError:
            pass
        return None

    def _remember_cached_video(self, cache_key: str, video_path: Path) -> None:
        marker = self._cache_marker(cache_key)
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(str(video_path.resolve()), encoding="utf-8")
        except OSError:
            logger.warning("Could not persist render cache marker %s", marker)

    @staticmethod
    def _parse_beat_manifest(output_log: str) -> dict | None:
        """Parse the instrumented scene's render-time beat manifest."""
        for line in reversed(output_log.splitlines()):
            stripped = line.strip()
            marker = "BEAT_MANIFEST_JSON:"
            position = stripped.find(marker)
            if position < 0:
                continue
            try:
                payload = json.loads(stripped[position + len(marker):])
            except (ValueError, TypeError):
                return None
            return payload if isinstance(payload, dict) else None
        return None

    def _manifest_marker(self, cache_key: str) -> Path:
        return self.output_dir / ".render_cache" / f"{cache_key}.manifest.json"

    def _remember_cached_manifest(self, cache_key: str, manifest: dict) -> None:
        marker = self._manifest_marker(cache_key)
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        except OSError:
            logger.warning("Could not persist beat manifest %s", marker)

    def _load_cached_manifest(self, cache_key: str) -> dict | None:
        marker = self._manifest_marker(cache_key)
        if not marker.exists():
            return None
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else None
        except (OSError, ValueError):
            return None

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
        # get_axis_labels() silently constructs MathTex labels. Replace its
        # default with Pango Text so a no-LaTeX deployment can render axes.
        code = re.sub(
            r"(?m)^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\s*=\s*"
            r"(?P<axes>[A-Za-z_]\w*)\.get_axis_labels\(\s*\)\s*$",
            lambda match: (
                f"{match.group('indent')}{match.group('var')} = VGroup("
                f"Text('x', font_size=24).next_to("
                f"{match.group('axes')}.x_axis.get_end(), RIGHT), "
                f"Text('y', font_size=24).next_to("
                f"{match.group('axes')}.y_axis.get_end(), UP))"
            ),
            code,
        )
        code = re.sub(
            r"(?P<prefix>\b(?:x_axis_config|y_axis_config|axis_config)\s*=\s*\{)"
            r"(?P<body>[^{}\n]*(?:[\"']?include_numbers[\"']?\s*:\s*True|"
            r"[\"']?numbers_to_include[\"']?\s*:)[^{}\n]*)\}",
            lambda match: (
                match.group(0)
                if "label_constructor" in match.group("body")
                else f"{match.group('prefix')}{match.group('body').rstrip()}, "
                "\"label_constructor\": Text}"
            ),
            code,
        )
        code = re.sub(
            r"(?m)^(?P<indent>[ \t]*)(?P<var>label\w*|[A-Za-z_]\w*label\w*)"
            r"\.next_to\((?P<args>[^\n]+)\)\s*$"
            r"(?!\n(?P=indent)(?P=var)\.shift_onto_screen)",
            lambda match: (
                f"{match.group(0)}\n{match.group('indent')}"
                f"{match.group('var')}.shift_onto_screen(buff=0.3)"
            ),
            code,
        )
        # Remove invalid rate_func parameters
        code = re.sub(
            r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)",
            "",
            code,
        )

        # Replace invalid color names with valid ones
        invalid_colors = [
            "ORANGE_E",
            "BLUE_D",
            "BLUE_E",
            "RED_A",
            "GREEN_E",
            "GREEN_D",
            "YELLOW_E",
        ]
        for color in invalid_colors:
            code = re.sub(rf"\b{color}\b", "BLUE", code)

        # Preserve semantics while migrating common ManimCE/model slips.
        code = re.sub(r"\bShowCreation\b", "Create", code)
        code = re.sub(r"\b([A-Za-z_]\w*)\.get_graph\(", r"\1.plot(", code)
        graph_axes = {
            graph: axes
            for graph, axes in re.findall(
                r"(?m)^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.plot\(", code
            )
        }
        for graph, axes in graph_axes.items():
            code = re.sub(
                rf"\b{re.escape(graph)}\.get_point_at_x\(([^()\n]+)\)",
                rf"{axes}.i2gp(\1, {graph})",
                code,
            )
        code = re.sub(r"\bstroke_color\s*=\s*NONE\b", "stroke_opacity=0", code)
        code = re.sub(
            r"(?P<prefix>[,(]\s*)stroke_dashes\s*=\s*[^,)]+\s*,?\s*",
            r"\g<prefix>",
            code,
        )
        code = re.sub(
            r"(?P<prefix>[,(]\s*)stroke_dashed\s*=\s*[^,)]+\s*,?\s*",
            r"\g<prefix>",
            code,
        )
        code = re.sub(r"(?m)(\.animate\.[^,\n]*?)\.animate\.", r"\1.", code)
        code = re.sub(
            r"\.move_to\(\[\s*([A-Za-z_]\w*)\s*,\s*ORIGIN\s*,\s*0\s*\]\)",
            r".move_to(\1)",
            code,
        )
        code = re.sub(
            r"(?m)^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\.become\(VGroup\("
            r"(?P=var),\s*(?P<rest>[^\n]+)$",
            lambda match: (
                f"{match.group('indent')}{match.group('var')} = VGroup("
                f"{match.group('var')}, {match.group('rest')[:-1]}"
            ),
            code,
        )
        code = re.sub(
            r"NumberLine\((?P<body>[^)]*include_numbers\s*=\s*True)(?P<tail>[^)]*)\)",
            lambda match: (
                match.group(0)
                if "label_constructor" in match.group(0)
                else "NumberLine("
                + match.group("body")
                + ", label_constructor=Text"
                + match.group("tail")
                + ")"
            ),
            code,
        )
        code = re.sub(
            r"Star\(\s*scale_factor\s*=\s*([^,)]+)\s*,\s*([^)]*)\)",
            r"Star(\2).scale(\1)",
            code,
        )
        code = re.sub(
            r"Star\(\s*scale_factor\s*=\s*([^,)]+)\s*\)",
            r"Star().scale(\1)",
            code,
        )
        if "TEACHING_LINES" in code:
            code = re.sub(
                r"Text\(\s*(['\"])Loading(?:\.\.\.)?\1\s*,",
                r"Text(TEACHING_LINES[0],",
                code,
                flags=re.IGNORECASE,
            )
        guarded_lines: list[str] = []
        scale_line = re.compile(r"^([ \t]*)([A-Za-z_]\w*)\.scale_to_fit_width\(([^)\n]+)\)[ \t]*$")
        for line in code.splitlines():
            match = scale_line.match(line)
            previous = next((item.strip() for item in reversed(guarded_lines) if item.strip()), "")
            if match and previous != (f"if {match.group(2)}.width > {match.group(3)}:"):
                indent, variable, width = match.groups()
                guarded_lines.extend(
                    [
                        f"{indent}if {variable}.width > {width}:",
                        f"{indent}    {variable}.scale_to_fit_width({width})",
                    ]
                )
            else:
                guarded_lines.append(line)
        code = "\n".join(guarded_lines)
        code = re.sub(
            r"\b([A-Za-z_]\w*bar\w*)\.set_height\(",
            r"\1.stretch_to_fit_height(",
            code,
            flags=re.IGNORECASE,
        )
        code = re.sub(
            r"\b([A-Za-z_]\w*bar\w*\.copy\(\))\.set_height\(",
            r"\1.stretch_to_fit_height(",
            code,
            flags=re.IGNORECASE,
        )
        nested_helpers = set(re.findall(r"(?m)^(?: {8}|\t{2})def\s+([A-Za-z_]\w*)\s*\(", code))
        for helper in nested_helpers:
            code = re.sub(rf"\bself\.{re.escape(helper)}\s*\(", f"{helper}(", code)

        # Add default scene if none found
        if "class" not in code or "Scene" not in code:
            code += """

# Default Scene
class DefaultMathVisualization(Scene):
    def construct(self):
        title = Text("数学可视化")
        self.play(Write(title))
        self.wait(2)
        self.play(FadeOut(title))
"""

        return code

    def _run_preflight(self, script_path: Path, scene_name: str) -> tuple[bool, str]:
        # Runtime/API faults normally surface in the first few seconds. If a
        # valid complex scene needs longer, timeout is inconclusive and the
        # bounded full render proceeds, so keep this latency tax small.
        timeout_s = min(20.0, max(8.0, self.render_timeout_s / 10.0))
        try:
            with tempfile.TemporaryDirectory(prefix="manim_preflight_") as tmp:
                cmd = [
                    sys.executable,
                    "-m",
                    "manim",
                    "-ql",
                    "-s",
                    f"--media_dir={tmp}",
                    str(script_path),
                    scene_name,
                ]
                process = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                )
        except subprocess.TimeoutExpired:
            # A timeout is inconclusive: complex but valid construct() methods
            # can spend longer building the final frame even with animations
            # skipped. Continue to the bounded full render; only a concrete
            # non-zero runtime exception is a preflight failure.
            logger.warning(
                "Manim preflight exceeded %.0fs; continuing to full render",
                timeout_s,
            )
            return True, ""
        if process.returncode == 0:
            return True, ""
        detail = (process.stderr or process.stdout or "unknown failure").strip()
        # Bound state/error prompts even when Manim emits a very long traceback.
        return False, detail[-5000:]

    def _extract_scene_name(self, code: str) -> str | None:
        """Extract Scene class name from code"""
        pattern = (
            r"class\s+(\w+)\s*\(\s*"
            r"(?:Scene|MovingCameraScene|ThreeDScene)\s*\)"
        )
        match = re.search(pattern, code)
        return match.group(1) if match else None

    def _find_video_file(self, scene_name: str, *, script_stem: str | None = None) -> Path | None:
        """Find the generated video file"""
        video_dir = self.output_dir / "videos"
        if not video_dir.exists():
            video_dir = self.output_dir

        latest_video = None
        latest_time = 0.0

        for file_path in video_dir.rglob("*"):
            if scene_name in file_path.name and file_path.suffix in (".mp4", ".mov"):
                if script_stem and script_stem not in file_path.as_posix():
                    continue
                mtime = file_path.stat().st_mtime
                if mtime > latest_time:
                    latest_time = mtime
                    latest_video = file_path

        return latest_video

    def _parse_video_path_from_log(self, log: str) -> Path | None:
        """Parse video file path from Manim execution log"""
        # Manim pattern: "File ready at:  /path/to/video.mp4"
        match = re.search(r"File ready at:\s+['\"]?([^'\"]+\.mp4)['\"]?", log)
        if match:
            path_str = match.group(1).strip()
            path = Path(path_str)
            if path.exists():
                return path
        return None
