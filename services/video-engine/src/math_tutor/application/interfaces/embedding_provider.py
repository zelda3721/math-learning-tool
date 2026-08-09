"""
Embedding Provider Interface — batch text → vector for semantic search.

Used by skill / pattern / example retrieval to score similarity between
the user's problem and known items. Optional — when no embedding endpoint
is configured the system falls back to keyword scoring.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class IEmbeddingProvider(ABC):
    @property
    @abstractmethod
    def model(self) -> str: ...

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text. Order is preserved."""
        ...
