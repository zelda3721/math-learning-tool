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

**请求体一律当不可信输入**（对抗审查 D-01 / D-07）：
- text 不进 argv：写进临时文件用 `say -f` 读。macOS `say` 的手册没写支持 `--`
  结束选项，靠它不稳；text 以 "-" 开头时（"-f /etc/hosts"、"-o 任意路径"）
  会被当成选项读任意文件、覆盖任意路径。文件路径由我们生成，text 永远只是内容。
- voice 只认 `[A-Za-z ()-]{1,40}` 且必须是本机 `say -v ?` 列出的语音，否则回退默认；
- ASR 的 model 只认白名单，否则 faster-whisper 会按名字去下载任意模型；
- 子进程/模型都放到线程池里跑并带超时：async 路由里同步阻塞会卡住整个事件循环，
  一句卡死的 say 就能让所有请求一起挂住；超时如实回 504。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
import re
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

# 子进程超时：网关侧整个 TTS 调用只等 30 秒，这里再长也没人收结果
SAY_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 30
# 整个 ASR（转码 + 模型推理）的上限。线程里的推理停不下来，但请求不该陪着挂
ASR_TIMEOUT_S = float(os.getenv("ASR_TIMEOUT_S", "60"))
# TTS 整体上限：say + ffmpeg 各 30 秒，外加一点余量
TTS_TIMEOUT_S = SAY_TIMEOUT_S + FFMPEG_TIMEOUT_S + 5

# voice 名字的形状：本机英文语音名只有字母、空格、括号和连字符（如 "Eddy (English (US))"）
_VOICE_SHAPE = re.compile(r"^[A-Za-z ()\-]{1,40}$")
# `say -v ?` 每行形如 "Samantha            en_US    # Hello! ..."
_VOICE_LINE = re.compile(r"^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#")

# ASR 模型白名单：英语口语练习只用得到这几档；运维要别的模型就显式写进环境变量
_DEFAULT_ASR_MODELS = ("tiny.en", "base.en", "small.en")


class SpeechTimeout(RuntimeError):
    """子进程或模型超时——路由据此回 504，而不是混进"念不出来/没听清"。"""


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


def _run(argv: list[str], timeout: float, what: str) -> subprocess.CompletedProcess[bytes]:
    """跑子进程，超时统一翻译成 SpeechTimeout（subprocess 会在超时时杀掉子进程）。"""
    try:
        return subprocess.run(argv, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as err:
        raise SpeechTimeout(f"{what} 超过 {timeout:g} 秒没完成") from err


def allowed_asr_models() -> frozenset[str]:
    """默认三档 + 当前配置的 ASR_MODEL + ASR_ALLOWED_MODELS（逗号分隔）里显式放行的。"""
    extra = [m.strip() for m in os.getenv("ASR_ALLOWED_MODELS", "").split(",") if m.strip()]
    return frozenset((*_DEFAULT_ASR_MODELS, ASR_MODEL, *extra))


_VOICES_CACHE: frozenset[str] | None = None


def _installed_voices() -> frozenset[str]:
    """本机 `say` 认得的语音名。列成功一次就缓存住：语音不会在进程活着时变。

    列失败（超时 / 报错）不缓存：不然第一次碰巧超时，整个进程之后都只能用默认语音。
    中文系统上 `say -v ?` 列的是本地化名字（"Samantha (英语（美国）)"），
    `say -v Samantha` 照样认，所以括号前的基本名也收进来。
    """
    global _VOICES_CACHE
    if _VOICES_CACHE is not None:
        return _VOICES_CACHE
    if shutil.which("say") is None:
        return frozenset()
    try:
        proc = subprocess.run(["say", "-v", "?"], capture_output=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return frozenset()
    if proc.returncode != 0:
        return frozenset()
    names = set()
    for line in proc.stdout.decode("utf-8", "ignore").splitlines():
        match = _VOICE_LINE.match(line)
        if match:
            full = match.group(1).strip()
            names.add(full)
            names.add(full.split(" (", 1)[0].strip())
    _VOICES_CACHE = frozenset(names)
    return _VOICES_CACHE


def resolve_voice(voice: str | None) -> str:
    """请求里的 voice 只有形状合法且本机真有这个语音才用，否则回退默认语音。

    回退而不是报错：念出来用了默认声音，比孩子这边整句没声音好。
    """
    if voice is None:
        return TTS_VOICE
    candidate = voice.strip()
    if _VOICE_SHAPE.match(candidate) and candidate in _installed_voices():
        return candidate
    logger.warning("TTS voice %r 不在本机语音列表或形状不合法，回退 %s", voice[:60], TTS_VOICE)
    return TTS_VOICE


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
        proc = _run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
            FFMPEG_TIMEOUT_S,
            "ffmpeg 转码",
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
            src = Path(tmp) / "tts.txt"
            aiff = Path(tmp) / "tts.aiff"
            wav = Path(tmp) / "tts.wav"
            # text 只作为文件内容交给 say，永远不进 argv：以 "-" 开头的文本不会被解析成选项
            src.write_text(text, encoding="utf-8")
            proc = _run(
                ["say", "-v", resolve_voice(voice), "-r", rate, "-o", str(aiff), "-f", str(src)],
                SAY_TIMEOUT_S,
                "say 合成",
            )
            if proc.returncode != 0 or not aiff.exists():
                raise RuntimeError(f"say 合成失败：{proc.stderr.decode('utf-8', 'ignore')[:200]}")
            conv = _run(
                [_ffmpeg() or "ffmpeg", "-y", "-loglevel", "error",
                 "-i", str(aiff), "-ar", "22050", "-ac", "1", str(wav)],
                FFMPEG_TIMEOUT_S,
                "ffmpeg 转码",
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

    # 明确要 wav：OpenAI 兼容接口默认回 mp3，网关那头只认 RIFF/WAVE，mp3 会被当成"没合成出来"
    body = json.dumps(
        {"model": TTS_API_MODEL, "input": text, "voice": voice, "speed": speed, "response_format": "wav"}
    ).encode()
    req = urllib.request.Request(
        TTS_API_BASE.rstrip("/") + "/audio/speech",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 —— 地址来自本机配置
        data = resp.read()
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return data
    # 不认 response_format 的服务照样回 mp3：有 ffmpeg 就转一下，没有就如实失败
    return _to_wav(data)


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
    if req.model is not None and req.model not in allowed_asr_models():
        # 拒绝而不是回退：调用方显式点名了一个模型，静默换成别的会让结果对不上号
        return JSONResponse(
            {"error": "不支持的 ASR 模型", "code": "bad-model", "allowed": sorted(allowed_asr_models())},
            status_code=400,
        )
    try:
        # 转码 + 推理都是阻塞的，放线程池跑，事件循环继续服务别的请求
        result = await asyncio.wait_for(
            asyncio.to_thread(transcribe_audio, raw, language=req.language or "en", model_name=req.model),
            timeout=ASR_TIMEOUT_S,
        )
    except (SpeechTimeout, asyncio.TimeoutError) as err:
        logger.warning("ASR timed out: %s", err)
        return JSONResponse({"error": "识别超时，请再说一次", "code": "asr-timeout"}, status_code=504)
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
        audio = await asyncio.wait_for(
            asyncio.to_thread(synthesize_speech, text, voice=req.voice, speed=req.speed),
            timeout=TTS_TIMEOUT_S,
        )
    except (SpeechTimeout, asyncio.TimeoutError, TimeoutError) as err:
        logger.warning("TTS timed out: %s", err)
        return JSONResponse({"error": "合成超时", "code": "tts-timeout"}, status_code=504)
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
