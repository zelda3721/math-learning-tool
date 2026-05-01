"""
Self-hosted reranker over HTTP. Two API shapes supported:

- **cohere** (default): Cohere / Jina / Infinity / voyage style
    POST {base_url}/rerank
    body: {"model": "...", "query": "...", "documents": ["...", ...], "top_n": K?}
    response: {"results": [{"index": int, "relevance_score": float}, ...]}

- **tei**: HuggingFace text-embeddings-inference
    POST {base_url}/rerank
    body: {"query": "...", "texts": ["...", ...]}
    response: [{"index": int, "score": float}, ...]   (or {"results": [...]})

Both flavors run fine on `infinity` or `TEI` self-hosted servers loaded
with bge-reranker-v2-m3 / bge-reranker-large / similar.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

import httpx

from ...application.interfaces.rerank_provider import IRerankProvider

logger = logging.getLogger(__name__)


def _is_local_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} or host.endswith(".local")


class OpenAIRerankProvider(IRerankProvider):
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        api_type: str = "cohere",
        timeout: float = 60.0,
        bypass_proxy_for_local: bool = True,
    ) -> None:
        if api_type not in ("cohere", "tei"):
            raise ValueError(f"unsupported rerank api_type: {api_type}")
        self._model = model
        self._api_type = api_type
        self._endpoint = base_url.rstrip("/") + "/rerank"
        self._api_key = api_key

        client_kwargs: dict[str, Any] = {"timeout": timeout}
        if bypass_proxy_for_local and _is_local_url(base_url):
            client_kwargs["trust_env"] = False
            client_kwargs["mounts"] = {
                "http://": httpx.AsyncHTTPTransport(),
                "https://": httpx.AsyncHTTPTransport(),
            }
        self._client = httpx.AsyncClient(**client_kwargs)
        logger.info(
            "OpenAIRerankProvider ready (endpoint=%s, model=%s, api_type=%s)",
            self._endpoint,
            self._model,
            self._api_type,
        )

    @property
    def model(self) -> str:
        return self._model

    async def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        if not documents:
            return []
        if not query or not query.strip():
            # Without a query the reranker can't score; fall back to identity
            return [(i, 0.0) for i in range(len(documents))]

        if self._api_type == "cohere":
            body: dict[str, Any] = {
                "model": self._model,
                "query": query,
                "documents": documents,
            }
            if top_n is not None:
                body["top_n"] = top_n
        else:  # tei
            body = {"query": query, "texts": documents}
            if top_n is not None:
                body["top_n"] = top_n

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        try:
            response = await self._client.post(
                self._endpoint, json=body, headers=headers
            )
        except Exception as exc:
            logger.exception("rerank HTTP call failed (model=%s)", self._model)
            raise

        if response.status_code >= 400:
            logger.error(
                "rerank returned %d: %s",
                response.status_code,
                response.text[:500],
            )
            response.raise_for_status()

        try:
            data = response.json()
        except Exception:
            logger.exception("rerank response not JSON: %s", response.text[:500])
            raise

        return self._parse_response(data)

    def _parse_response(self, data: Any) -> list[tuple[int, float]]:
        # Cohere/Jina/Infinity: {"results": [{"index": ..., "relevance_score": ...}, ...]}
        # TEI:                  [{"index": ..., "score": ...}] OR {"results": [...]}
        if isinstance(data, dict) and "results" in data:
            items = data["results"]
        elif isinstance(data, list):
            items = data
        else:
            logger.warning("unexpected rerank response shape: %s", type(data).__name__)
            return []

        out: list[tuple[int, float]] = []
        for entry in items:
            if not isinstance(entry, dict):
                continue
            idx = entry.get("index")
            score = entry.get("relevance_score", entry.get("score"))
            if idx is None or score is None:
                continue
            try:
                out.append((int(idx), float(score)))
            except (TypeError, ValueError):
                continue
        out.sort(key=lambda pair: pair[1], reverse=True)
        return out

    async def aclose(self) -> None:
        await self._client.aclose()
