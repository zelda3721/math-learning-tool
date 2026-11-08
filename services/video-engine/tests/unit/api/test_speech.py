"""本地语音接口：中文文档里说的三件事，这里逐条锁住。

① 没有后端时**诚实 501**，不是 500，也不是假装成功；
② 有后端时进出都对（识别出的文字、合成出的 wav）；
③ 音频/文本的上限在接口层就挡住——录音 12MB、一次最多念 500 字。

真模型不进单测（CI 上没有模型文件，加载一次十几秒），所以用 monkeypatch 换掉
`transcribe_audio` / `synthesize_speech`，测的是**路由的契约**：
解码、上限、状态码、latency 字段。
"""
from __future__ import annotations

import base64

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from math_tutor.api.routes import speech


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(speech.router, prefix="/api/v1")
    return TestClient(app)


def test_status_reports_both_directions(client: TestClient) -> None:
    body = client.get("/api/v1/speech/status").json()
    assert set(body) == {"asr", "tts", "limits"}
    assert body["limits"]["maxText"] == speech.MAX_TEXT
    assert body["limits"]["maxAudioBytes"] == speech.MAX_AUDIO_BYTES
    # 有没有装是环境的事，键必须在——界面靠它决定"能不能开口说"
    assert isinstance(body["asr"]["available"], bool)
    assert isinstance(body["tts"]["available"], bool)


def test_tts_returns_wav_and_latency(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speech, "synthesize_speech", lambda text, voice=None, speed=1.0: b"RIFFfake")
    res = client.post("/api/v1/tts", json={"text": "Hello!"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/wav")
    assert res.content == b"RIFFfake"
    assert int(res.headers["x-latency-ms"]) >= 0


def test_tts_rejects_empty_and_too_long(client: TestClient) -> None:
    assert client.post("/api/v1/tts", json={"text": "   "}).status_code == 400
    assert client.post("/api/v1/tts", json={"text": "a" * (speech.MAX_TEXT + 1)}).status_code == 413


def test_tts_is_honest_when_no_backend(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(text: str, voice=None, speed=1.0) -> bytes:
        raise RuntimeError("no backend")

    monkeypatch.setattr(speech, "synthesize_speech", boom)
    res = client.post("/api/v1/tts", json={"text": "Hello!"})
    assert res.status_code == 501
    assert res.json()["code"] == "tts-failed"


def test_asr_transcribes_and_reports_latency(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speech, "asr_available", lambda: True)
    monkeypatch.setattr(
        speech, "transcribe_audio", lambda raw, language="en", model_name=None: {"text": "Where is the station?", "language": "en"}
    )
    audio = base64.b64encode(b"fake-audio").decode()
    res = client.post("/api/v1/asr", json={"audio_base64": audio})
    assert res.status_code == 200
    assert res.json()["text"] == "Where is the station?"
    assert res.json()["latency_ms"] >= 0


def test_asr_rejects_bad_base64_and_oversize(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speech, "asr_available", lambda: True)
    assert client.post("/api/v1/asr", json={"audio_base64": "不是 base64"}).status_code == 400
    huge = base64.b64encode(b"x" * (speech.MAX_AUDIO_BYTES + 10)).decode()
    assert client.post("/api/v1/asr", json={"audio_base64": huge}).status_code == 413


def test_asr_is_honest_without_backend(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speech, "asr_available", lambda: False)
    res = client.post("/api/v1/asr", json={"audio_base64": base64.b64encode(b"x").decode()})
    assert res.status_code == 501
    assert res.json()["code"] == "asr-unavailable"


def test_transcode_failure_is_502_not_500(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """听不清是产品里的正常结局（"没听清，再说一次"），不是服务器崩了。"""

    def boom(raw: bytes, language: str = "en", model_name=None) -> dict:
        raise RuntimeError("音频转码失败")

    monkeypatch.setattr(speech, "asr_available", lambda: True)
    monkeypatch.setattr(speech, "transcribe_audio", boom)
    res = client.post("/api/v1/asr", json={"audio_base64": base64.b64encode(b"x").decode()})
    assert res.status_code == 502
    assert res.json()["code"] == "asr-failed"
