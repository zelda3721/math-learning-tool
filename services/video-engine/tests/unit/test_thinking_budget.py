"""思考型模型的预算处理：不关思考，接住它（截断重试 + 开销头寸）。"""
from __future__ import annotations

import asyncio

from math_tutor.infrastructure.llm.openai_provider import OpenAILLMProvider, StreamDone


class _Scripted(OpenAILLMProvider):
    """chat_stream 换成剧本：记录每次收到的 max_tokens，按剧本吐 StreamDone。"""

    def __init__(self, script):
        # 不调父类 __init__（不建网络客户端），手工放上需要的属性
        self._default_max_tokens = 4096
        self._script = list(script)
        self.calls: list[int] = []

    async def chat_stream(self, messages, tools=None, **kwargs):  # type: ignore[override]
        self.calls.append(int(kwargs.get("max_tokens") or 0))
        yield self._script.pop(0)


def _done(finish, text, reasoning=""):
    return StreamDone(finish_reason=finish, text=text, reasoning=reasoning)


def test_思考吃掉预算_指数加注最多两跳():
    p = _Scripted([
        _done("length", "", reasoning="推" * 3000),      # ≈1532 tok 思考，被截断
        _done("length", "", reasoning="推" * 2000),      # 首跳仍不够，但思考在收敛
        _done("stop", "答案：6", reasoning="推" * 1500),
    ])
    out = asyncio.run(p.chat_complete([], max_tokens=1024))
    assert out.text == "答案：6"
    assert p.calls[0] == 1024
    assert p.calls[1] >= 1024 + 4096          # 首跳 ≥4096
    assert p.calls[2] == 1024 + 12000         # 末跳顶到上限
    assert len(p.calls) == 3                  # 之后不再试


def test_思考发散就停止加注_不再喂token():
    p = _Scripted([
        _done("length", "", reasoning="转" * 3000),      # 截断
        _done("length", "", reasoning="转" * 9000),      # 加注后思考反而更长 = 原地打转
        _done("stop", "不该到这里"),
    ])
    out = asyncio.run(p.chat_complete([], max_tokens=1024))
    assert len(p.calls) == 2                  # 发散后立即停手
    assert out.finish_reason == "length"      # 如实返回截断结果（流层已把思考尾提升为 text）


def test_思考开销进EMA_下一次调用自动加头寸():
    p = _Scripted([
        _done("stop", "第一问答案", reasoning="想" * 2000),   # ≈1032 tok 思考
        _done("stop", "第二问答案"),
    ])
    asyncio.run(p.chat_complete([], max_tokens=1000))
    asyncio.run(p.chat_complete([], max_tokens=1000))
    assert p.calls[0] == 1000
    assert p.calls[1] > 1000                   # 学到了思考开销
    assert p.calls[1] <= 1000 + 12000


def test_不思考的模型行为不变_没有重试没有头寸():
    p = _Scripted([
        _done("stop", "普通回答"),
        _done("length", "被截断但没有思考"),
    ])
    asyncio.run(p.chat_complete([], max_tokens=2048))
    out = asyncio.run(p.chat_complete([], max_tokens=2048))
    assert len(p.calls) == 2 and p.calls == [2048, 2080] or p.calls[1] <= 2100
    assert out.text == "被截断但没有思考"      # 无 reasoning 的 length 不重试
