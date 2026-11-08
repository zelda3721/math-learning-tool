"""语音接口加固（对抗审查 D-01 / D-07）：请求体是不可信输入，阻塞调用要有超时。

D-01：/api/v1/tts 曾把 text、voice 直接拼进 `say` 的 argv，text="-f /etc/hosts"
就能让 say 读任意文件、"-o 路径" 能覆盖任意文件；ASR 的 model 能触发任意模型下载；
worker 默认绑 0.0.0.0 且无鉴权。
D-07：async 路由里同步跑 subprocess / whisper，阻塞事件循环且没有超时。

这里不跑真 say / ffmpeg：monkeypatch 掉 subprocess.run，断言 argv 的形状。
"""
from __future__ import annotations

import base64
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from math_tutor.api.routes import speech
from math_tutor.config.settings import Settings


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(speech.router, prefix="/api/v1")
    return TestClient(app)


class FakeSay:
    """记录每次 subprocess.run 的 argv；say/ffmpeg 都"成功"并写出输出文件。"""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.say_text: str | None = None

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(list(argv))
        assert "timeout" in kwargs and kwargs["timeout"] > 0, "子进程必须带超时"
        if argv[0] == "say":
            if "-f" in argv:
                self.say_text = Path(argv[argv.index("-f") + 1]).read_text(encoding="utf-8")
            Path(argv[argv.index("-o") + 1]).write_bytes(b"FORM")
        else:  # ffmpeg：最后一个参数是输出
            Path(argv[-1]).write_bytes(b"RIFFwav")
        return subprocess.CompletedProcess(argv, 0, b"", b"")


@pytest.fixture()
def fake_say(monkeypatch: pytest.MonkeyPatch) -> FakeSay:
    fake = FakeSay()
    monkeypatch.setattr(speech, "tts_backend", lambda: "say")
    monkeypatch.setattr(speech, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(speech, "_installed_voices", lambda: frozenset({"Samantha", "Daniel", "Eddy (English (US))"}))
    monkeypatch.setattr(speech.subprocess, "run", fake)
    return fake


def _say_argv(fake: FakeSay) -> list[str]:
    return next(c for c in fake.calls if c[0] == "say")


def test_text_starting_with_dash_is_content_not_option(client: TestClient, fake_say: FakeSay) -> None:
    res = client.post("/api/v1/tts", json={"text": "-f /etc/hosts"})
    assert res.status_code == 200
    argv = _say_argv(fake_say)
    # text 不进 argv：argv 里唯一的 -f 指向我们自己生成的临时文件
    assert "-f /etc/hosts" not in argv
    assert "/etc/hosts" not in argv
    assert argv.count("-f") == 1
    assert Path(argv[argv.index("-f") + 1]).name == "tts.txt"
    assert fake_say.say_text == "-f /etc/hosts"
    # -o 只出现一次，且指向临时目录里的 aiff
    assert argv.count("-o") == 1
    assert argv[argv.index("-o") + 1].endswith("tts.aiff")


def test_text_with_output_option_cannot_redirect_write(client: TestClient, fake_say: FakeSay) -> None:
    res = client.post("/api/v1/tts", json={"text": "-o /tmp/pwned.aiff hello"})
    assert res.status_code == 200
    argv = _say_argv(fake_say)
    assert argv.count("-o") == 1
    assert "/tmp/pwned.aiff" not in " ".join(argv)


def test_injected_voice_falls_back_to_default(client: TestClient, fake_say: FakeSay) -> None:
    res = client.post("/api/v1/tts", json={"text": "hi", "voice": "-o /tmp/x"})
    assert res.status_code == 200
    argv = _say_argv(fake_say)
    assert argv[argv.index("-v") + 1] == speech.TTS_VOICE
    assert "/tmp/x" not in " ".join(argv)


def test_voice_must_be_installed_and_well_shaped(fake_say: FakeSay) -> None:
    assert speech.resolve_voice("Daniel") == "Daniel"
    assert speech.resolve_voice("Eddy (English (US))") == "Eddy (English (US))"
    # 形状合法但本机没有 → 回退
    assert speech.resolve_voice("Nobody") == speech.TTS_VOICE
    # 形状不合法（分隔符、过长）→ 回退
    assert speech.resolve_voice("Daniel;rm") == speech.TTS_VOICE
    assert speech.resolve_voice("A" * 41) == speech.TTS_VOICE
    assert speech.resolve_voice(None) == speech.TTS_VOICE


def test_installed_voices_parses_say_listing(monkeypatch: pytest.MonkeyPatch) -> None:
    listing = (
        "Samantha            en_US    # Hello! My name is Samantha.\n"
        "Eddy (English (US)) en_US    # Hello! My name is Eddy.\n"
        "garbage line\n"
    ).encode()
    monkeypatch.setattr(speech.shutil, "which", lambda name: "/usr/bin/say")
    monkeypatch.setattr(
        speech.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(argv, 0, listing, b"")
    )
    monkeypatch.setattr(speech, "_VOICES_CACHE", None)
    assert speech._installed_voices() == frozenset({"Samantha", "Eddy (English (US))", "Eddy"})


def test_installed_voices_localized_names_and_no_caching_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    """中文系统列的是本地化名字；基本名（Samantha）也得认。列失败不缓存。"""
    monkeypatch.setattr(speech.shutil, "which", lambda name: "/usr/bin/say")
    monkeypatch.setattr(speech, "_VOICES_CACHE", None)

    def boom(argv: list[str], **kw: Any) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(argv, 10)

    monkeypatch.setattr(speech.subprocess, "run", boom)
    assert speech._installed_voices() == frozenset()
    assert speech._VOICES_CACHE is None  # 失败没被缓存

    listing = "Samantha (英语（美国）)  en_US    # Hello! My name is Samantha.\n".encode()
    monkeypatch.setattr(
        speech.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(argv, 0, listing, b"")
    )
    assert "Samantha" in speech._installed_voices()
    assert speech.resolve_voice("Samantha") == "Samantha"


def test_asr_rejects_unlisted_model(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def fake_transcribe(raw: bytes, language: str = "en", model_name: str | None = None) -> dict:
        nonlocal called
        called = True
        return {"text": "x", "language": "en"}

    monkeypatch.setattr(speech, "asr_available", lambda: True)
    monkeypatch.setattr(speech, "transcribe_audio", fake_transcribe)
    audio = base64.b64encode(b"fake").decode()
    res = client.post("/api/v1/asr", json={"audio_base64": audio, "model": "attacker/huge-model"})
    assert res.status_code == 400
    assert res.json()["code"] == "bad-model"
    assert called is False  # 根本没走到加载模型

    ok = client.post("/api/v1/asr", json={"audio_base64": audio, "model": "base.en"})
    assert ok.status_code == 200


def test_asr_allowed_models_extendable_by_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASR_ALLOWED_MODELS", "medium.en, large-v3")
    allowed = speech.allowed_asr_models()
    assert {"tiny.en", "base.en", "small.en", speech.ASR_MODEL, "medium.en", "large-v3"} <= allowed


def test_say_timeout_returns_504(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def hang(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(argv, kwargs.get("timeout", 0))

    monkeypatch.setattr(speech, "tts_backend", lambda: "say")
    monkeypatch.setattr(speech, "_installed_voices", lambda: frozenset())
    monkeypatch.setattr(speech.subprocess, "run", hang)
    res = client.post("/api/v1/tts", json={"text": "hello"})
    assert res.status_code == 504
    assert res.json()["code"] == "tts-timeout"


def test_ffmpeg_timeout_in_asr_returns_504(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def hang(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        assert kwargs.get("timeout") == speech.FFMPEG_TIMEOUT_S
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(speech, "asr_available", lambda: True)
    monkeypatch.setattr(speech, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(speech.subprocess, "run", hang)
    res = client.post("/api/v1/asr", json={"audio_base64": base64.b64encode(b"x").decode()})
    assert res.status_code == 504
    assert res.json()["code"] == "asr-timeout"


def test_slow_asr_model_hits_overall_timeout(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """模型推理本身没有超时参数，靠路由层的整体上限兜住。"""

    def slow(raw: bytes, language: str = "en", model_name: str | None = None) -> dict:
        time.sleep(0.5)
        return {"text": "late", "language": "en"}

    monkeypatch.setattr(speech, "asr_available", lambda: True)
    monkeypatch.setattr(speech, "transcribe_audio", slow)
    monkeypatch.setattr(speech, "ASR_TIMEOUT_S", 0.05)
    res = client.post("/api/v1/asr", json={"audio_base64": base64.b64encode(b"x").decode()})
    assert res.status_code == 504


def test_blocking_work_runs_off_the_event_loop(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """合成在工作线程里跑，不在事件循环线程里。

    判据：合成函数执行时，当前线程上有没有正在跑的事件循环。
    （早先比较"探针请求的线程"和"合成线程"是否相同——TestClient 不进上下文时
    每个请求换一个循环线程，那个断言恒真，锁不住任何东西。）
    """
    import asyncio

    seen: dict[str, Any] = {}

    def record(text: str, voice: str | None = None, speed: float = 1.0) -> bytes:
        try:
            asyncio.get_running_loop()
            seen["on_loop"] = True
        except RuntimeError:
            seen["on_loop"] = False
        return b"RIFF\x00\x00\x00\x00WAVEfake"

    monkeypatch.setattr(speech, "synthesize_speech", record)
    assert client.post("/api/v1/tts", json={"text": "hi"}).status_code == 200
    assert seen["on_loop"] is False


def test_api_host_defaults_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("API_HOST", raising=False)
    # 不读 .env：只看代码里的默认值
    assert Settings.model_fields["api_host"].default == "127.0.0.1"
