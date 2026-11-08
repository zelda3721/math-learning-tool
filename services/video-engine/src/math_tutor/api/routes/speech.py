"""
Speech endpoints — 本地语音的进出两个方向。

POST /api/v1/asr   { audio_base64, language? }        → { text, language, latency_ms }
POST /api/v1/tts   { text, voice?, speed? }           → audio/wav
GET  /api/v1/speech/status                            → 两个后端各自可不可用、用什么

为什么放在 compute-worker 而不是网关里：按 PLAN D2，Python 只做纯计算——
不做编排、不调 LLM、不存数据。语音识别与合成正是这个形状：
进来一段音频，出去一段文字；进来一句话，出去一段音频。

**全部本地**：
- ASR 用 faster-whisper（模型缓存在进程内，首次用到时加载）
- TTS 用 macOS 的 `say`（现代 macOS 的语音就是本机神经语音），
  没有 `say` 的机器可以配 TTS_API_BASE 走 OpenAI 兼容端点，两样都没有就诚实 501
- 中间格式统一用 ffmpeg 转 16k 单声道 wav：浏览器录音是 webm/opus，模型只吃 wav

延迟要记下来：PLAN 阶段 5 的 DoD 是单轮 ≤ 3 秒并记录 P50 / P90，
所以每次响应都带 latency_ms，由网关侧汇总。
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import shutil
import subprocess
import tempfile
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()

ASR_MODEL = os.getenv("ASR_MODEL", "tiny.en")
ASR_DEVICE = os.getenv("ASR_DEVICE", "cpu")
ASR_COMPUTE = os.getenv("ASR_COMPUTE_TYPE", "int8")
TTS_BACKEND = os.getenv("TTS_BACKEND", "auto")  # auto | say | api | off
TTS_VOICE = os.getenv("TTS_VOICE", "Samantha")
TTS_RATE = int(os.getenv("TTS_RATE_WPM", "165"))
TTS_API_BASE = os.getenv("TTS_API_BASE", "").strip()
TTS_API_MODEL = os.getenv("TTS_API_MODEL", "tts-1")
TTS_API_VOICE = os.getenv("TTS_API_VOICE", "alloy")

MAX_TEXT = 500
MAX_AUDIO_BYTES = 12 * 1024 * 1024


class AsrRequest(BaseModel):
    audio_base64: str = Field(..., description="录音（wav/m4a/webm/ogg 都行，内部用 ffmpeg 转码）")
    language: str | None = Field(None, description="语言代码；缺省 en")
    model: str | None = Field(None, description="覆盖默认 ASR 模型（多半不用传）")


class TtsRequest(BaseModel):
    text: str = Field(..., description="要念的话，最多 500 字")
    voice: str | None = None
    speed: float = Field(1.0, ge=0.5, le=1.5)


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


@lru_cache(maxsize=2)
def _load_model(name: str) -> Any:
    """模型只加载一次：每次请求都从磁盘拉一遍，第一句话就要等十几秒。"""
    from faster_whisper import WhisperModel  # 延迟导入：没装也能起服务

    started = time.time()
    model = WhisperModel(name, device=ASR_DEVICE, compute_type=ASR_COMPUTE)
    logger.info("ASR model %s loaded in %.1fs", name, time.time() - started)
    return model


def asr_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        return False
    return _ffmpeg() is not None


def tts_backend() -> str | None:
    if TTS_BACKEND == "off":
        return None
    if TTS_BACKEND == "say":
        return "say" if shutil.which("say") and _ffmpeg() else None
    if TTS_BACKEND == "api":
        return "api" if TTS_API_BASE else None
    if shutil.which("say") and _ffmpeg():
        return "say"
    return "api" if TTS_API_BASE else None


def _to_wav(raw: bytes) -> bytes:
    """任意格式 → 16kHz 单声道 wav（模型只吃这个形状）。"""
    ffmpeg = _ffmpeg()
    if ffmpeg is None:
        raise RuntimeError("这台机器上没有 ffmpeg，语音转码做不了")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.bin"
        dst = Path(tmp) / "out.wav"
        src.write_bytes(raw)
        proc = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
            capture_output=True,
        )
        if proc.returncode != 0 or not dst.exists():
            raise RuntimeError(f"音频转码失败：{proc.stderr.decode('utf-8', 'ignore')[:200]}")
        return dst.read_bytes()


def transcribe_audio(raw: bytes, language: str = "en", model_name: str | None = None) -> dict[str, Any]:
    wav = _to_wav(raw)
    model = _load_model(model_name or ASR_MODEL)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "speech.wav"
        path.write_bytes(wav)
        segments, info = model.transcribe(str(path), language=language, beam_size=1, vad_filter=True)
        text = " ".join(seg.text.strip() for seg in segments).strip()
    return {"text": text, "language": getattr(info, "language", language) or language}


def synthesize_speech(text: str, voice: str | None = None, speed: float = 1.0) -> bytes:
    """本地神经 TTS：macOS `say` 合成 AIFF，再用 ffmpeg 转 wav。"""
    backend = tts_backend()
    if backend == "say":
        rate = str(max(90, int(TTS_RATE * speed)))
        with tempfile.TemporaryDirectory() as tmp:
            aiff = Path(tmp) / "tts.aiff"
            wav = Path(tmp) / "tts.wav"
            proc = subprocess.run(
                ["say", "-v", voice or TTS_VOICE, "-r", rate, "-o", str(aiff), text],
                capture_output=True,
            )
            if proc.returncode != 0 or not aiff.exists():
                raise RuntimeError(f"say 合成失败：{proc.stderr.decode('utf-8', 'ignore')[:200]}")
            conv = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), "-ar", "22050", "-ac", "1", str(wav)],
                capture_output=True,
            )
            if conv.returncode != 0 or not wav.exists():
                raise RuntimeError("TTS 转码失败")
            return wav.read_bytes()
    if backend == "api" and TTS_API_BASE:
        return _synthesize_via_api(text, voice or TTS_API_VOICE, speed)
    raise RuntimeError("这台机器上没有可用的本地 TTS（say 或 TTS_API_BASE）")


def _synthesize_via_api(text: str, voice: str, speed: float) -> bytes:
    import json
    import urllib.request

    body = json.dumps({"model": TTS_API_MODEL, "input": text, "voice": voice, "speed": speed}).encode()
    req = urllib.request.Request(
        TTS_API_BASE.rstrip("/") + "/audio/speech",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 —— 地址来自本机配置
        return resp.read()


@router.get("/speech/status")
async def speech_status() -> dict[str, Any]:
    """两个方向各自能不能用——界面据此决定"能不能开口说"，而不是让用户撞 501。"""
    return {
        "asr": {"available": asr_available(), "model": ASR_MODEL, "device": ASR_DEVICE},
        "tts": {"available": tts_backend() is not None, "backend": tts_backend(), "voice": TTS_VOICE},
        "limits": {"maxText": MAX_TEXT, "maxAudioBytes": MAX_AUDIO_BYTES},
    }


@router.post("/asr")
async def asr(req: AsrRequest) -> Any:
    started = time.time()
    if not asr_available():
        return JSONResponse(
            {"error": "这台机器上没装本地语音识别（faster-whisper 或 ffmpeg 缺失）", "code": "asr-unavailable"},
            status_code=501,
        )
    try:
        raw = base64.b64decode(req.audio_base64, validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse({"error": "audio_base64 不是合法的 base64", "code": "bad-audio"}, status_code=400)
    if len(raw) > MAX_AUDIO_BYTES:
        return JSONResponse({"error": "录音太长，一次最多 12MB", "code": "audio-too-long"}, status_code=413)
    try:
        result = transcribe_audio(raw, language=req.language or "en", model_name=req.model)
    except Exception as err:  # 转码/模型失败都是"这次没听清"，不是服务器错误
        logger.warning("ASR failed: %s", err)
        return JSONResponse({"error": f"没听清：{err}", "code": "asr-failed"}, status_code=502)
    return {**result, "latency_ms": round((time.time() - started) * 1000)}


@router.post("/tts")
async def tts(req: TtsRequest) -> Any:
    started = time.time()
    text = req.text.strip()
    if not text:
        return JSONResponse({"error": "text 不能为空", "code": "empty-text"}, status_code=400)
    if len(text) > MAX_TEXT:
        return JSONResponse({"error": f"一次最多念 {MAX_TEXT} 个字", "code": "text-too-long"}, status_code=413)
    try:
        audio = synthesize_speech(text, voice=req.voice, speed=req.speed)
    except Exception as err:
        logger.warning("TTS failed: %s", err)
        return JSONResponse({"error": f"念不出来：{err}", "code": "tts-failed"}, status_code=501)
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "x-latency-ms": str(round((time.time() - started) * 1000)),
            "cache-control": "no-store",
        },
    )
