"""
ExamplesStore — distilled good/bad code examples for few-shot retrieval.

Phase 1 only provides the CRUD; the retrieval logic that injects examples
into prompts lives in Phase 4.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from ...application.interfaces.rerank_provider import IRerankProvider
from .conversation_store import _parse_iso, _utcnow_iso
from .database import Database
from .models import Example
from .semantic_index import SemanticIndex

logger = logging.getLogger(__name__)


def _tags_from_str(s: str) -> list[str]:
    return [t.strip() for t in s.split(",") if t.strip()]


def _tags_to_str(tags: list[str] | None) -> str:
    if not tags:
        return ""
    return ",".join(t.strip() for t in tags if t.strip())


class ExamplesStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def add_example(
        self,
        *,
        problem: str,
        grade: str,
        manim_code: str,
        label: str,
        session_id: str | None = None,
        video_path: str | None = None,
        tags: list[str] | None = None,
        notes: str = "",
    ) -> int:
        if label not in ("good", "bad"):
            raise ValueError(f"label must be 'good' or 'bad', got {label!r}")
        return await self._db.execute(
            """
            INSERT INTO examples
                (session_id, problem, grade, manim_code, video_path,
                 label, tags, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                problem,
                grade,
                manim_code,
                video_path,
                label,
                _tags_to_str(tags),
                notes,
                _utcnow_iso(),
            ),
        )

    async def list_examples(
        self,
        *,
        label: str | None = None,
        grade: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Example]:
        clauses: list[str] = []
        params: list[Any] = []
        if label is not None:
            clauses.append("label = ?")
            params.append(label)
        if grade is not None:
            clauses.append("grade = ?")
            params.append(grade)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])
        rows = await self._db.fetch_all(
            f"""
            SELECT * FROM examples
            {where}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params,
        )
        return [self._row_to_example(r) for r in rows]

    async def search_by_keywords(
        self,
        problem_text: str,
        *,
        label: str = "good",
        grade: str | None = None,
        top_k: int = 3,
    ) -> list[Example]:
        """Naive keyword scoring (substring + token overlap)."""
        candidates = await self.list_examples(label=label, grade=grade, limit=200)
        tokens = [t for t in _tokenize(problem_text) if len(t) >= 2]
        if not tokens:
            return candidates[:top_k]
        scored: list[tuple[int, Example]] = []
        for ex in candidates:
            problem_tokens = _tokenize(ex.problem)
            score = sum(1 for t in tokens if t in problem_tokens)
            if score > 0:
                scored.append((score, ex))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [ex for _, ex in scored[:top_k]]

    async def search_by_similarity(
        self,
        problem_text: str,
        *,
        semantic_index: SemanticIndex,
        label: str = "good",
        grade: str | None = None,
        top_k: int = 3,
        min_score: float = 0.35,
        rerank_provider: IRerankProvider | None = None,
        rerank_pool_size: int = 10,
    ) -> tuple[list[Example], str]:
        """Embedding-based semantic search, optionally followed by a
        reranker for second-stage refinement.

        Returns `(hits, method)` where method is one of:
          - "rerank"   : embedding shortlist → rerank picked top_k
          - "semantic" : embedding only
          - "keyword"  : fallback when both above fail or are unavailable
        """
        candidates = await self.list_examples(label=label, grade=grade, limit=200)
        if not candidates:
            return [], "semantic"

        # Stage 1: embedding shortlist. Use larger pool when reranking.
        pool_size = max(top_k, rerank_pool_size if rerank_provider else top_k)
        try:
            ranked = await semantic_index.rank(
                problem_text,
                [(ex.problem, ex) for ex in candidates],
                top_k=pool_size,
                min_score=0.0 if rerank_provider else min_score,
            )
        except Exception:
            logger.warning("semantic search failed; falling back to keyword")
            hits = await self.search_by_keywords(
                problem_text, label=label, grade=grade, top_k=top_k
            )
            return hits, "keyword"

        if not ranked:
            hits = await self.search_by_keywords(
                problem_text, label=label, grade=grade, top_k=top_k
            )
            return hits, "keyword"

        # No reranker → return embedding top-k respecting min_score
        if rerank_provider is None:
            filtered = [(s, ex) for s, ex in ranked if s >= min_score]
            return [ex for _, ex in filtered[:top_k]], "semantic"

        # Stage 2: rerank the embedding shortlist
        pool_examples = [ex for _, ex in ranked]
        try:
            rerank_results = await rerank_provider.rerank(
                problem_text,
                [ex.problem for ex in pool_examples],
                top_n=top_k,
            )
        except Exception:
            logger.warning("rerank failed; using embedding-only results")
            return [ex for _, ex in ranked[:top_k]], "semantic"

        if not rerank_results:
            return [ex for _, ex in ranked[:top_k]], "semantic"

        return [pool_examples[idx] for idx, _ in rerank_results], "rerank"

    async def delete_example(self, example_id: int) -> None:
        await self._db.execute("DELETE FROM examples WHERE id = ?", (example_id,))

    @staticmethod
    def _row_to_example(row: dict[str, Any]) -> Example:
        return Example(
            id=int(row["id"]),
            problem=row["problem"],
            grade=row["grade"],
            manim_code=row["manim_code"],
            label=row["label"],
            created_at=_parse_iso(row["created_at"]),
            session_id=row.get("session_id"),
            video_path=row.get("video_path"),
            tags=_tags_from_str(row.get("tags") or ""),
            notes=row.get("notes") or "",
        )


def _tokenize(text: str) -> set[str]:
    """Very rough tokenization that handles both Chinese characters and ASCII words."""
    out: set[str] = set()
    buf: list[str] = []
    for ch in text:
        if ch.isalnum() and ord(ch) < 128:
            buf.append(ch.lower())
        else:
            if buf:
                out.add("".join(buf))
                buf.clear()
            if "一" <= ch <= "鿿":  # CJK ideographs — single char tokens
                out.add(ch)
    if buf:
        out.add("".join(buf))
    return out
