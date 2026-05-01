"""
SemanticIndex — in-memory embedding cache + cosine similarity search.

Wraps an `IEmbeddingProvider`. Caches per-text vectors by hash so we don't
re-embed the same problem / skill description on every call. For our scale
(≤ 100 candidates) a flat in-memory store is plenty; if catalog grows past
~10k, swap in FAISS / Milvus.
"""
from __future__ import annotations

import hashlib
import logging
import math
from typing import Generic, TypeVar

from ...application.interfaces.embedding_provider import IEmbeddingProvider

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


class SemanticIndex:
    def __init__(self, provider: IEmbeddingProvider) -> None:
        self._provider = provider
        self._cache: dict[str, list[float]] = {}  # hash -> vector

    @property
    def model(self) -> str:
        return self._provider.model

    async def embed_one(self, text: str) -> list[float]:
        return (await self.embed_many([text]))[0]

    async def embed_many(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # Identify items not in cache
        missing_indices: list[int] = []
        missing_texts: list[str] = []
        keys = [_key(t) for t in texts]
        for i, k in enumerate(keys):
            if k not in self._cache:
                missing_indices.append(i)
                missing_texts.append(texts[i])

        if missing_texts:
            try:
                new_vecs = await self._provider.embed(missing_texts)
            except Exception:
                logger.exception("embed batch failed (n=%d)", len(missing_texts))
                # Fail soft: return zero vectors so callers fall back gracefully
                new_vecs = [[] for _ in missing_texts]
            for idx, vec in zip(missing_indices, new_vecs):
                self._cache[keys[idx]] = vec

        return [self._cache.get(k, []) for k in keys]

    @staticmethod
    def cosine(a: list[float], b: list[float]) -> float:
        if not a or not b:
            return 0.0
        if len(a) != len(b):
            return 0.0
        dot = 0.0
        na = 0.0
        nb = 0.0
        for x, y in zip(a, b):
            dot += x * y
            na += x * x
            nb += y * y
        if na == 0 or nb == 0:
            return 0.0
        return dot / (math.sqrt(na) * math.sqrt(nb))

    async def rank(
        self,
        query: str,
        candidates: list[tuple[str, T]],
        *,
        top_k: int = 5,
        min_score: float = 0.0,
    ) -> list[tuple[float, T]]:
        """Embed `query` plus every candidate text, return top-K by cosine.

        `candidates` is a list of `(text_to_embed, payload)` pairs; payload is
        whatever object you want returned (Skill / Example / dict / ...).
        """
        if not candidates:
            return []
        all_texts = [query] + [c[0] for c in candidates]
        vectors = await self.embed_many(all_texts)
        q_vec = vectors[0]
        if not q_vec:
            return []
        scored: list[tuple[float, T]] = []
        for i, (_, payload) in enumerate(candidates):
            score = self.cosine(q_vec, vectors[i + 1])
            if score >= min_score:
                scored.append((score, payload))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return scored[:top_k]

    def cache_size(self) -> int:
        return len(self._cache)
