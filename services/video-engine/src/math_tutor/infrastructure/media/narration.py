"""Content-agnostic narration timeline and optional TTS audio muxing."""
from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NarrationCue:
    start_s: float
    end_s: float
    text: str


@dataclass(frozen=True)
class NarrationAudioResult:
    video_path: Path
    audio_attached: bool
    warning: str | None = None


def _clean_line(value: Any) -> str:
    return " ".join(str(value or "").replace("-->", "→").split()).strip()


def build_narration_cues(
    visual_plan: dict[str, Any] | None,
    *,
    actual_duration_s: float | None = None,
) -> list[NarrationCue]:
    """Map open-world visual beats onto one deterministic narration timeline."""
    scenes = (visual_plan or {}).get("scenes") or []
    timed: list[tuple[float, str]] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        duration = min(20.0, max(2.0, float(scene.get("duration_s") or 4.0)))
        timed.append((duration, _clean_line(scene.get("teaching_line"))))
    planned_total = sum(duration for duration, _ in timed)
    if not timed or planned_total <= 0:
        return []

    actual = float(actual_duration_s or 0)
    scale = actual / planned_total if actual > 0 else 1.0
    cursor = 0.0
    cues: list[NarrationCue] = []
    for duration, line in timed:
        beat_start = cursor * scale
        beat_end = (cursor + duration) * scale
        cursor += duration
        if not line:
            continue
        padding = min(0.3, max(0.05, (beat_end - beat_start) * 0.08))
        start = beat_start + padding
        end = max(start + 0.8, beat_end - padding)
        if actual > 0:
            end = min(end, actual)
        if end > start:
            cues.append(
                NarrationCue(round(start, 3), round(end, 3), line[:180])
            )
    return cues


def _vtt_timestamp(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, ms = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def render_webvtt(cues: list[NarrationCue]) -> str:
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        lines.extend(
            [
                str(index),
                f"{_vtt_timestamp(cue.start_s)} --> {_vtt_timestamp(cue.end_s)}",
                cue.text,
                "",
            ]
        )
    return "\n".join(lines)


def probe_duration(video_path: Path) -> float | None:
    if shutil.which("ffprobe") is None:
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        value = float(result.stdout.strip())
        return value if value > 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _probe_has_audio(video_path: Path) -> bool:
    if shutil.which("ffprobe") is None:
        return False
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=index", "-of", "csv=p=0", str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        return False


class NarrationPostProcessor:
    """Optionally synthesize cue text and mux it onto the rendered video.

    The TTS endpoint is deliberately optional. Subtitle generation remains
    deterministic and available even when no speech service is configured.
    """

    def __init__(
        self,
        *,
        enabled: bool = False,
        api_base: str = "",
        api_key: str = "",
        model: str = "tts-1",
        voice: str = "alloy",
        speed: float = 1.05,
        timeout_s: float = 60.0,
    ) -> None:
        self.enabled = bool(enabled and api_base.strip() and model.strip())
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.voice = voice
        self.speed = min(2.0, max(0.5, speed))
        self.timeout_s = max(10.0, timeout_s)

    def attach_audio(
        self,
        video_path: Path,
        cues: list[NarrationCue],
        *,
        duration_s: float | None = None,
    ) -> NarrationAudioResult:
        if not self.enabled or not cues:
            return NarrationAudioResult(video_path=video_path, audio_attached=False)
        if shutil.which("ffmpeg") is None:
            return NarrationAudioResult(
                video_path=video_path,
                audio_attached=False,
                warning="ffmpeg 不可用，已保留字幕但未合成旁白",
            )
        duration = duration_s or probe_duration(video_path)
        if not duration:
            return NarrationAudioResult(
                video_path=video_path,
                audio_attached=False,
                warning="无法读取视频时长，已保留字幕但未合成旁白",
            )

        signature = hashlib.sha256(
            (self.model + self.voice + str(self.speed) + repr(cues)).encode("utf-8")
        ).hexdigest()[:16]
        output = video_path.with_name(f"{video_path.stem}-narrated-{signature}.mp4")
        if output.exists() and _probe_has_audio(output):
            return NarrationAudioResult(video_path=output, audio_attached=True)

        clip_dir = video_path.parent / ".narration" / signature
        clip_dir.mkdir(parents=True, exist_ok=True)
        clip_paths: list[Path] = []
        try:
            from openai import OpenAI

            client = OpenAI(
                base_url=self.api_base,
                api_key=self.api_key or "not-needed",
                timeout=self.timeout_s,
            )
            for index, cue in enumerate(cues):
                clip = clip_dir / f"cue-{index:03d}.mp3"
                if not clip.exists():
                    response = client.audio.speech.create(
                        model=self.model,
                        voice=self.voice,
                        input=cue.text,
                        speed=self.speed,
                        response_format="mp3",
                    )
                    response.write_to_file(clip)
                clip_paths.append(clip)
        except Exception as exc:  # noqa: BLE001
            logger.warning("TTS synthesis unavailable: %s", exc)
            return NarrationAudioResult(
                video_path=video_path,
                audio_attached=False,
                warning=f"TTS 合成失败，已保留字幕：{str(exc)[:160]}",
            )

        inputs = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path)]
        for clip in clip_paths:
            inputs.extend(["-i", str(clip)])
        filters: list[str] = []
        mix_labels: list[str] = []
        if _probe_has_audio(video_path):
            filters.append("[0:a]volume=0.18[base]")
            mix_labels.append("[base]")
        for index, cue in enumerate(cues, start=1):
            label = f"n{index}"
            cue_duration = max(0.2, cue.end_s - cue.start_s)
            delay_ms = max(0, round(cue.start_s * 1000))
            filters.append(
                f"[{index}:a]atrim=0:{cue_duration:.3f},asetpts=PTS-STARTPTS,"
                f"adelay={delay_ms}|{delay_ms}[{label}]"
            )
            mix_labels.append(f"[{label}]")
        filters.append(
            "".join(mix_labels)
            + f"amix=inputs={len(mix_labels)}:duration=longest:normalize=0,"
            f"alimiter=limit=0.95,atrim=0:{duration:.3f}[narration]"
        )
        cmd = inputs + [
            "-filter_complex", ";".join(filters),
            "-map", "0:v:0", "-map", "[narration]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", "-t", f"{duration:.3f}", str(output),
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=max(60.0, duration * 3)
            )
            if result.returncode == 0 and output.exists() and _probe_has_audio(output):
                return NarrationAudioResult(video_path=output, audio_attached=True)
            logger.warning("Narration mux failed: %s", result.stderr[-800:])
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("Narration mux failed: %s", exc)
        return NarrationAudioResult(
            video_path=video_path,
            audio_attached=False,
            warning="旁白混流失败，已保留字幕和原视频",
        )
