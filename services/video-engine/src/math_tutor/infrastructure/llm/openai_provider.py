"""
OpenAI-compatible LLM provider.

Targets LMStudio by default; works with any OpenAI-compatible endpoint
(vLLM, Ollama with OpenAI shim, real OpenAI, DeepSeek, etc.). Handles
Qwen3-style `<think>...</think>` reasoning blocks and the
`reasoning_content` field that some providers (DeepSeek-R1) expose.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
from typing import Any, AsyncIterator
from urllib.parse import urlparse

import httpx
from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    InternalServerError,
    RateLimitError,
)

from ...application.interfaces.llm_provider import (
    ChatMessage,
    ILLMProvider,
    ReasoningDelta,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCallEvent,
    ToolDefinition,
)

logger = logging.getLogger(__name__)

# Errors worth retrying. These are transient on the server / network side
# (LMStudio 502/503, model still loading, brief connection blips).
_RETRYABLE = (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)


class _ReasoningSplitter:
    """
    Splits incoming text into (visible, reasoning) chunks based on
    `<think>...</think>` markers, preserving state across chunk boundaries.

    Qwen3 emits reasoning inside these tags as part of regular content when
    `enable_thinking` is on. We strip them out and route them to the
    reasoning channel so the UI can show a separate "thinking" panel.
    """

    OPEN = "<think>"
    CLOSE = "</think>"

    def __init__(self) -> None:
        self._buffer = ""
        self._in_thinking = False

    def feed(self, chunk: str) -> tuple[str, str]:
        self._buffer += chunk
        visible_parts: list[str] = []
        reasoning_parts: list[str] = []

        while self._buffer:
            if self._in_thinking:
                idx = self._buffer.find(self.CLOSE)
                if idx >= 0:
                    reasoning_parts.append(self._buffer[:idx])
                    self._buffer = self._buffer[idx + len(self.CLOSE):]
                    self._in_thinking = False
                    continue
                # Hold a tail in case CLOSE is split across chunks
                hold = len(self.CLOSE) - 1
                if len(self._buffer) > hold:
                    reasoning_parts.append(self._buffer[:-hold])
                    self._buffer = self._buffer[-hold:]
                break
            else:
                idx = self._buffer.find(self.OPEN)
                if idx >= 0:
                    visible_parts.append(self._buffer[:idx])
                    self._buffer = self._buffer[idx + len(self.OPEN):]
                    self._in_thinking = True
                    continue
                hold = len(self.OPEN) - 1
                if len(self._buffer) > hold:
                    visible_parts.append(self._buffer[:-hold])
                    self._buffer = self._buffer[-hold:]
                break

        return "".join(visible_parts), "".join(reasoning_parts)

    def flush(self) -> tuple[str, str]:
        if not self._buffer:
            return "", ""
        if self._in_thinking:
            return "", self._buffer
        return self._buffer, ""


class OpenAILLMProvider(ILLMProvider):
    """OpenAI-compatible streaming chat provider."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        default_model: str,
        default_temperature: float = 0.6,
        default_max_tokens: int = 8192,
        timeout: float = 120.0,
        default_extra_body: dict[str, Any] | None = None,
        max_retries: int = 3,
        retry_initial_delay_s: float = 1.0,
        retry_max_delay_s: float = 8.0,
        disable_thinking_with_tools: bool = True,
        bypass_proxy_for_local: bool = True,
    ) -> None:
        client_kwargs: dict[str, Any] = {
            "base_url": base_url,
            "api_key": api_key or "lm-studio",
            "timeout": timeout,
        }
        bypassed = False
        if bypass_proxy_for_local and _is_local_url(base_url):
            # Corporate / system HTTP_PROXY commonly intercepts localhost
            # traffic and returns 502 because it can't reach an upstream.
            # When the LLM lives on the same box we bypass any system proxy.
            #
            # NOTE: `proxy=None` alone is NOT enough — httpx still consults
            # HTTP_PROXY/HTTPS_PROXY/ALL_PROXY env vars unless trust_env=False.
            # We also explicitly set mounts to a transport with no proxy so
            # this works on every httpx version.
            client_kwargs["http_client"] = httpx.AsyncClient(
                trust_env=False,
                timeout=timeout,
                # Some local servers (e.g. Jan.ai) WARN-log when the Origin
                # header is empty. CORS doesn't actually block server-to-
                # server calls, but adding a benign Origin keeps logs clean
                # AND lets Jan's "trusted origins" allowlist match. LMStudio
                # ignores Origin entirely so this is a no-op there.
                headers={"Origin": "http://localhost"},
                mounts={
                    "http://": httpx.AsyncHTTPTransport(),
                    "https://": httpx.AsyncHTTPTransport(),
                },
            )
            bypassed = True
        self._client = AsyncOpenAI(**client_kwargs)
        self._default_model = default_model
        self._default_temperature = default_temperature
        self._default_max_tokens = default_max_tokens
        self._default_extra_body = default_extra_body or {}
        self._max_retries = max(0, max_retries)
        self._retry_initial_delay = retry_initial_delay_s
        self._retry_max_delay = retry_max_delay_s
        self._disable_thinking_with_tools = disable_thinking_with_tools
        logger.info(
            "OpenAILLMProvider ready (base_url=%s, model=%s, max_retries=%d, "
            "disable_thinking_with_tools=%s, bypass_proxy=%s)",
            base_url,
            default_model,
            self._max_retries,
            self._disable_thinking_with_tools,
            bypassed,
        )

    async def _create_with_retry(self, request_kwargs: dict[str, Any]) -> Any:
        """Call chat.completions.create with exponential-backoff retry on
        transient server errors (502/503/504) and connection failures."""
        delay = self._retry_initial_delay
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                return await self._client.chat.completions.create(**request_kwargs)
            except _RETRYABLE as exc:
                last_exc = exc
                status = getattr(exc, "status_code", None)
                # Pull the upstream response body so the user can see what
                # LMStudio (or whichever provider) actually said. The openai
                # SDK only stringifies "Error code: 502" otherwise.
                body = _extract_response_body(exc)
                if attempt >= self._max_retries:
                    logger.error(
                        "LLM call failed after %d retries (%s, status=%s): %s | body=%s",
                        self._max_retries,
                        type(exc).__name__,
                        status,
                        _short_error(exc),
                        body or "<empty>",
                    )
                    raise
                logger.warning(
                    "LLM call failed (%s, status=%s), retrying in %.1fs (attempt %d/%d) | body=%s",
                    type(exc).__name__,
                    status,
                    delay,
                    attempt + 1,
                    self._max_retries,
                    body or "<empty>",
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, self._retry_max_delay)
        # Defensive — should not reach here.
        if last_exc:
            raise last_exc
        raise RuntimeError("LLM call failed without an exception")

    @staticmethod
    def _to_openai_messages(messages: list[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            # content may be a plain string or a list of multimodal parts.
            content = m.content if m.content is not None else ""
            d: dict[str, Any] = {"role": m.role, "content": content}
            if m.tool_calls:
                d["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        },
                    }
                    for tc in m.tool_calls
                ]
                # OpenAI requires content to be present (can be empty string)
                # when tool_calls are set.
            if m.tool_call_id:
                d["tool_call_id"] = m.tool_call_id
            if m.name and m.role == "tool":
                d["name"] = m.name
            out.append(d)
        return out

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        merged_extra: dict[str, Any] = dict(self._default_extra_body)
        if extra_body:
            merged_extra.update(extra_body)

        # Qwen3 (and similar models) have a "thinking" mode that produces a
        # long reasoning_content stream before they emit tool_calls. With many
        # / complex tools this either burns tokens or wedges the LMStudio
        # chat-template renderer into a 502. When tools are in play, default
        # to thinking=False unless the user has explicitly opted in.
        if tools and self._disable_thinking_with_tools:
            ctk = dict(merged_extra.get("chat_template_kwargs") or {})
            if "enable_thinking" not in ctk:
                ctk["enable_thinking"] = False
                merged_extra["chat_template_kwargs"] = ctk

        request_kwargs: dict[str, Any] = {
            "model": model or self._default_model,
            "messages": self._to_openai_messages(messages),
            "temperature": (
                temperature if temperature is not None else self._default_temperature
            ),
            "max_tokens": max_tokens or self._default_max_tokens,
            "stream": True,
        }
        if tools:
            request_kwargs["tools"] = [t.to_openai_format() for t in tools]
            request_kwargs["tool_choice"] = "auto"
            # Encourage the model to emit multiple independent tool_calls in
            # one turn (we run them concurrently in AgentLoop). Some local
            # backends ignore this; harmless in that case.
            request_kwargs["parallel_tool_calls"] = True
        if merged_extra:
            request_kwargs["extra_body"] = merged_extra

        splitter = _ReasoningSplitter()
        text_acc: list[str] = []
        reasoning_acc: list[str] = []
        tc_buf: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"

        logger.info(
            "LLM stream: model=%s msgs=%d tools=%d max_tokens=%d temperature=%.2f extra_body=%s",
            request_kwargs["model"],
            len(request_kwargs["messages"]),
            len(request_kwargs.get("tools") or []),
            request_kwargs["max_tokens"],
            request_kwargs["temperature"],
            "yes" if request_kwargs.get("extra_body") else "no",
        )

        stream = await self._create_with_retry(request_kwargs)
        async for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if delta.content:
                visible, reasoning = splitter.feed(delta.content)
                if reasoning:
                    reasoning_acc.append(reasoning)
                    yield ReasoningDelta(text=reasoning)
                if visible:
                    text_acc.append(visible)
                    yield TextDelta(text=visible)

            reasoning_content = getattr(delta, "reasoning_content", None)
            if reasoning_content:
                reasoning_acc.append(reasoning_content)
                yield ReasoningDelta(text=reasoning_content)

            if delta.tool_calls:
                for d in delta.tool_calls:
                    idx = d.index
                    slot = tc_buf.setdefault(
                        idx, {"id": "", "name": "", "arguments": ""}
                    )
                    if d.id:
                        slot["id"] = d.id
                    fn = getattr(d, "function", None)
                    if fn is not None:
                        if getattr(fn, "name", None):
                            slot["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            slot["arguments"] += fn.arguments

            if choice.finish_reason:
                finish_reason = choice.finish_reason

        tail_visible, tail_reasoning = splitter.flush()
        if tail_reasoning:
            reasoning_acc.append(tail_reasoning)
            yield ReasoningDelta(text=tail_reasoning)
        if tail_visible:
            text_acc.append(tail_visible)
            yield TextDelta(text=tail_visible)

        tool_events: list[ToolCallEvent] = []
        for idx in sorted(tc_buf):
            slot = tc_buf[idx]
            if not slot["name"]:
                continue
            try:
                args = json.loads(slot["arguments"]) if slot["arguments"] else {}
            except json.JSONDecodeError:
                logger.warning(
                    "Tool call %s has invalid JSON arguments: %r",
                    slot["name"],
                    slot["arguments"],
                )
                args = {"_raw": slot["arguments"], "_parse_error": True}
            # `json.loads` happily returns strings/ints/lists when the LLM
            # emits a JSON value that's not an object (e.g. arguments='"foo"').
            # Tools all expect dicts; coerce defensively so `.get(...)` works.
            if not isinstance(args, dict):
                logger.warning(
                    "Tool call %s decoded args as non-dict (%s): %r",
                    slot["name"], type(args).__name__, args,
                )
                args = {"_value": args}
            evt = ToolCallEvent(
                id=slot["id"] or f"call_{idx}",
                name=slot["name"],
                arguments=args,
            )
            tool_events.append(evt)
            yield evt

        # Hermes / Qwen3 fallback: when the model emits tool calls as XML-like
        # text instead of using OpenAI native tool_calls (a known behavior on
        # LMStudio + Qwen3.x, especially under retry / error conditions),
        # parse them out of the visible text and emit as proper tool_call
        # events so the agent loop can route them like any other.
        if not tool_events:
            full_text = "".join(text_acc) + "".join(reasoning_acc)
            hermes_calls = _parse_hermes_tool_calls(full_text)
            if hermes_calls:
                logger.info(
                    "Recovered %d Hermes-format tool call(s) from text",
                    len(hermes_calls),
                )
                for evt in hermes_calls:
                    tool_events.append(evt)
                    yield evt

        full_text = "".join(text_acc)
        full_reasoning = "".join(reasoning_acc)

        # Robustness: when finish_reason='length' AND visible text is empty
        # but reasoning has content, the model probably had its <think>
        # block truncated by max_tokens (Qwen3.5+ thinking-mode pitfall, see
        # lmstudio-bug-tracker#1559). Promote the reasoning's tail into text
        # so downstream parsers have *something* to extract from. The text
        # still won't include the model's intended final answer, but often
        # the structured output exists inside the truncated reasoning.
        if (
            finish_reason == "length"
            and not full_text.strip()
            and full_reasoning.strip()
        ):
            logger.info(
                "Promoting truncated reasoning (%d chars) to text channel: "
                "model ran out of tokens before closing <think>",
                len(full_reasoning),
            )
            full_text = full_reasoning

        yield StreamDone(
            finish_reason=finish_reason,
            text=full_text,
            reasoning=full_reasoning,
            tool_calls=tool_events,
        )

    #: 思考型模型（qwen3.8 等）reasoning 会占用 completion 预算，且部分模型的
    #: enable_thinking 开关不生效。这里不关思考、而是**接住**它：
    #: ① 前瞻：按最近调用的思考开销（EMA）给 max_tokens 自动加头寸；
    #: ② 反应：finish=length 且确有 reasoning 时，按本次思考长度加预算重试一次。
    #: 单次追加封顶，防失控。
    _REASONING_HEADROOM_CAP = 12000

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        # Qwen 系对中文压缩率高（约 2~3 字/词元），len//2 偏保守够用
        return len(text) // 2 + 32

    async def _collect(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None,
        **kwargs: Any,
    ) -> StreamDone:
        last: StreamDone | None = None
        async for evt in self.chat_stream(messages, tools, **kwargs):
            if isinstance(evt, StreamDone):
                last = evt
        if last is None:
            return StreamDone(finish_reason="error")
        return last

    async def chat_complete(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        **kwargs: Any,
    ) -> StreamDone:
        requested = int(kwargs.get("max_tokens") or self._default_max_tokens)
        overhead = int(getattr(self, "_reasoning_overhead_ema", 0.0))
        if overhead > 0:
            kwargs["max_tokens"] = requested + min(
                int(overhead * 1.5), self._REASONING_HEADROOM_CAP
            )
        last = await self._collect(messages, tools, **kwargs)
        observed = self._estimate_tokens(last.reasoning or "")
        # EMA：偏向最近一次（0.5），模型/题型切换后几次调用内就能跟上
        prev = float(getattr(self, "_reasoning_overhead_ema", 0.0))
        self._reasoning_overhead_ema = prev * 0.5 + observed * 0.5
        # 截断的思考只给出真实开销的**下界**：首跳按估算×3（至少 4096），
        # 还不够就直接顶到上限——最多两跳，之后 EMA 会让后续调用免遭冷启动。
        # 两道护栏（实机：temp 0.0 的审计调用思考 1.6 万 token 截断，加注后涨到
        # 2.7 万还截断——那不是预算不够，是模型在原地打转）：
        # ① 重试把温度抬到 ≥0.3，打破贪心解码的复读循环；
        # ② 加注后思考不降反升 = 发散，立即停手，别再喂 token
        prev_est = self._estimate_tokens(last.reasoning or "")
        for bump in (max(4096, observed * 3), self._REASONING_HEADROOM_CAP):
            if not (last.finish_reason == "length" and (last.reasoning or "").strip()):
                break
            if prev_est > 8000:
                # 思考已经这么长还被截断，加注从未救活过（实测三战三败、每败 8~11 分钟）
                logger.warning(
                    "runaway thinking (≈%d tok truncated); skipping budget retries", prev_est
                )
                break
            kwargs["max_tokens"] = requested + min(bump, self._REASONING_HEADROOM_CAP)
            kwargs["temperature"] = max(0.3, float(kwargs.get("temperature") or 0.0))
            logger.info(
                "thinking ate the budget (reasoning≈%d tok, finish=length); "
                "retrying with max_tokens=%d temperature=%.1f",
                prev_est,
                kwargs["max_tokens"],
                kwargs["temperature"],
            )
            last = await self._collect(messages, tools, **kwargs)
            new_est = self._estimate_tokens(last.reasoning or "")
            self._reasoning_overhead_ema = (
                self._reasoning_overhead_ema * 0.5 + new_est * 0.5
            )
            if last.finish_reason == "length" and new_est >= prev_est:
                logger.warning(
                    "thinking diverges (%d → %d tok), budget retries won't help",
                    prev_est,
                    new_est,
                )
                break
            prev_est = new_est
        # 末级护栏：预算救不了的循环思考（发散/两跳后仍截断），对**这一次调用**
        # 请求最低推理力度重来。思考仍是全链路默认开启的——这里只在模型被证实
        # 原地打转时救场；不支持该参数的端点会忽略它或报错，报错就如实返回上一结果
        if last.finish_reason == "length" and (last.reasoning or "").strip():
            clamped = dict(kwargs)
            clamped["max_tokens"] = requested + 2048
            clamped["extra_body"] = {**(kwargs.get("extra_body") or {}), "reasoning_effort": "none"}
            logger.info(
                "looping thinking; final attempt with reasoning_effort=none max_tokens=%d",
                clamped["max_tokens"],
            )
            try:
                final = await self._collect(messages, tools, **clamped)
                if (final.text or "").strip() and final.finish_reason != "error":
                    return final
            except Exception:
                logger.exception("reasoning_effort clamp attempt failed; returning previous result")
        return last


_HERMES_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*"
    r"<function=([^>\s]+)\s*>"          # <function=name>
    r"\s*([\s\S]*?)\s*"                  # JSON args (or empty)
    r"</function>\s*"
    r"</tool_call>",
    re.IGNORECASE,
)
# Some Qwen3 fine-tunes use a slightly different shape:
#   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
_HERMES_JSON_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(\{[\s\S]*?\})\s*</tool_call>",
    re.IGNORECASE,
)


def _parse_hermes_tool_calls(text: str) -> list[ToolCallEvent]:
    """Recover tool calls emitted as Hermes/Qwen3-style XML blocks in text.

    Two shapes supported:
      1. <tool_call><function=NAME>{json args}</function></tool_call>
      2. <tool_call>{"name": "NAME", "arguments": {...}}</tool_call>
    """
    if "<tool_call>" not in text:
        return []
    out: list[ToolCallEvent] = []
    seen: set[tuple[str, str]] = set()  # de-dupe identical calls

    # Shape 1: <function=NAME> wrapper
    for i, m in enumerate(_HERMES_TOOL_CALL_RE.finditer(text)):
        name = m.group(1).strip()
        raw_args = m.group(2).strip()
        if not name:
            continue
        try:
            args = json.loads(raw_args) if raw_args else {}
            if not isinstance(args, dict):
                args = {"_value": args}
        except Exception:
            args = {"_raw": raw_args, "_parse_error": True} if raw_args else {}
        key = (name, json.dumps(args, sort_keys=True, ensure_ascii=False))
        if key in seen:
            continue
        seen.add(key)
        out.append(ToolCallEvent(id=f"hermes_{i}", name=name, arguments=args))

    # Shape 2: bare JSON object inside <tool_call>...</tool_call>
    for i, m in enumerate(_HERMES_JSON_TOOL_CALL_RE.finditer(text)):
        try:
            payload = json.loads(m.group(1))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        name = payload.get("name") or payload.get("function") or ""
        if not name or not isinstance(name, str):
            continue
        args = payload.get("arguments") or payload.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        key = (name, json.dumps(args, sort_keys=True, ensure_ascii=False))
        if key in seen:
            continue
        seen.add(key)
        out.append(ToolCallEvent(id=f"hermes_json_{i}", name=name, arguments=args))

    return out


def _is_local_url(url: str) -> bool:
    """Return True for loopback, LAN, and mDNS model endpoints."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
        return True
    if host.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(host)
        return address.is_private or address.is_loopback or address.is_link_local
    except ValueError:
        return False


def _short_error(exc: Exception) -> str:
    msg = str(exc)
    if len(msg) <= 240:
        return msg
    return msg[:240] + "…"


def _extract_response_body(exc: Exception) -> str | None:
    """Pull the upstream response body out of an openai APIStatusError-like
    exception so the actual provider error reaches the logs."""
    # openai SDK's APIStatusError stores .response (httpx.Response) and .body
    body_attr = getattr(exc, "body", None)
    if body_attr:
        try:
            text = json.dumps(body_attr, ensure_ascii=False) if not isinstance(body_attr, str) else body_attr
        except Exception:
            text = str(body_attr)
        return text[:1500]
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            return (response.text or "")[:1500] or None
        except Exception:
            return None
    return None
