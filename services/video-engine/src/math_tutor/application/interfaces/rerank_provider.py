"""
Rerank Provider Interface — given a query and a list of candidate texts,
return them re-scored by a cross-encoder rerank model.

Used as a second-stage refinement after embedding shortlist. Optional —
when no rerank endpoint is configured the system uses pure embedding
similarity.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class IRerankProvider(ABC):
    @property
    @abstractmethod
    def model(self) -> str: ...

    @abstractmethod
    async def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        """Score each document against the query.

        Returns a list of `(original_index, score)` tuples sorted desc by
        score. `top_n` (when set) caps the number of results returned.
        """
        ...
