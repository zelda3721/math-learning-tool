"""
OpenAI-compatible embedding provider.

Targets any endpoint speaking the `/v1/embeddings` shape: LMStudio with a
loaded embedding model, Ollama (OpenAI shim), text-embeddings-inference,
vLLM with an embedding model, or real OpenAI.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

import httpx
from openai import AsyncOpenAI

from ...application.interfaces.embedding_provider import IEmbeddingProvider

logger = logging.getLogger(__name__)


def _is_local_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} or host.endswith(".local")


class OpenAIEmbeddingProvider(IEmbeddingProvider):
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        dimension: int = 0,
        timeout: float = 60.0,
        max_batch: int = 64,
        bypass_proxy_for_local: bool = True,
    ) -> None:
        client_kwargs: dict[str, Any] = {
            "base_url": base_url,
            "api_key": api_key or "lm-studio",
            "timeout": timeout,
        }
        if bypass_proxy_for_local and _is_local_url(base_url):
            client_kwargs["http_client"] = httpx.AsyncClient(
                trust_env=False,
                timeout=timeout,
                mounts={
                    "http://": httpx.AsyncHTTPTransport(),
                    "https://": httpx.AsyncHTTPTransport(),
                },
            )
        self._client = AsyncOpenAI(**client_kwargs)
        self._model = model
        self._dimension = dimension if dimension > 0 else None
        self._max_batch = max(1, max_batch)
        logger.info(
            "OpenAIEmbeddingProvider ready (base_url=%s, model=%s, dim=%s)",
            base_url,
            model,
            self._dimension or "auto",
        )

    @property
    def model(self) -> str:
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # Filter out empties so we don't choke the endpoint
        cleaned = [t if t and t.strip() else " " for t in texts]

        out: list[list[float]] = []
        for i in range(0, len(cleaned), self._max_batch):
            batch = cleaned[i : i + self._max_batch]
            kwargs: dict[str, Any] = {"model": self._model, "input": batch}
            if self._dimension:
                kwargs["dimensions"] = self._dimension
            try:
                resp = await self._client.embeddings.create(**kwargs)
            except Exception:
                logger.exception(
                    "embedding call failed (model=%s, batch_size=%d)",
                    self._model,
                    len(batch),
                )
                raise
            # OpenAI client preserves order in resp.data
            for item in resp.data:
                vec = list(item.embedding)
                out.append(vec)
        return out
