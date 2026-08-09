"""search_examples — query the labelled examples store for few-shot context."""
from __future__ import annotations

import logging
from typing import Any

from ....application.interfaces import IRerankProvider, ITool, ToolContext, ToolResult
from ...storage import ExamplesStore, SemanticIndex

logger = logging.getLogger(__name__)

_CODE_PREVIEW_LIMIT = 1200


def _preview(code: str) -> str:
    if len(code) <= _CODE_PREVIEW_LIMIT:
        return code
    return code[:_CODE_PREVIEW_LIMIT] + "\n# ... (代码过长，已截断)"


class SearchExamplesTool(ITool):
    def __init__(
        self,
        examples_store: ExamplesStore,
        *,
        semantic_index: SemanticIndex | None = None,
        rerank_provider: IRerankProvider | None = None,
        rerank_pool_size: int = 10,
    ) -> None:
        self._store = examples_store
        self._semantic_index = semantic_index
        self._rerank_provider = rerank_provider
        self._rerank_pool_size = rerank_pool_size

    @property
    def name(self) -> str:
        return "search_examples"

    @property
    def description(self) -> str:
        return (
            "从历史标注的好/坏案例库中检索与当前题目相似的样本。返回 good 样本"
            "可直接用作 few-shot 参考；返回 bad 样本提醒你避免相同的失败模式。"
            "建议在生成 Manim 代码前调用一次。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "题目文本或核心问题描述",
                },
                "grade": {
                    "type": "string",
                    "description": "学生年级（可选，缺省按当前会话的年级过滤）",
                },
                "label": {
                    "type": "string",
                    "enum": ["good", "bad"],
                    "description": "要检索的标签，默认 good",
                    "default": "good",
                },
                "top_k": {
                    "type": "integer",
                    "description": "返回数量（1-5），默认 3",
                    "default": 3,
                    "minimum": 1,
                    "maximum": 5,
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = (args.get("query") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        label = args.get("label", "good")
        top_k = int(args.get("top_k", 3))
        top_k = max(1, min(5, top_k))

        if label not in ("good", "bad"):
            return ToolResult(
                success=False,
                summary=f"非法 label: {label}",
                error="invalid_label",
            )

        if self._semantic_index is not None:
            try:
                hits, used_method = await self._store.search_by_similarity(
                    query,
                    semantic_index=self._semantic_index,
                    label=label,
                    grade=grade,
                    top_k=top_k,
                    rerank_provider=self._rerank_provider,
                    rerank_pool_size=self._rerank_pool_size,
                )
            except Exception:
                logger.exception("semantic search_examples failed; falling back")
                hits = await self._store.search_by_keywords(
                    query, label=label, grade=grade, top_k=top_k
                )
                used_method = "keyword"
        else:
            hits = await self._store.search_by_keywords(
                query, label=label, grade=grade, top_k=top_k
            )
            used_method = "keyword"

        items = [
            {
                "id": ex.id,
                "problem": ex.problem,
                "grade": ex.grade,
                "tags": ex.tags,
                "notes": ex.notes,
                "manim_code_preview": _preview(ex.manim_code),
                "video_path": ex.video_path,
            }
            for ex in hits
        ]
        # Store full hits in state so generate_manim_code can pick them up
        # without the agent having to re-pass them as arguments.
        if hits:
            state_key = "recent_good_examples" if label == "good" else "recent_bad_examples"
            ctx.state[state_key] = [
                {
                    "id": ex.id,
                    "problem": ex.problem,
                    "manim_code": ex.manim_code,
                    "tags": ex.tags,
                    "notes": ex.notes,
                }
                for ex in hits
            ]
            ctx.state.setdefault("examples_seen", []).extend(ex.id for ex in hits)

        summary = (
            f"检索到 {len(items)} 个 {label} 样本（{used_method}）"
            if items
            else f"没有找到匹配的 {label} 样本"
        )
        return ToolResult(
            success=True,
            summary=summary,
            data={"label": label, "method": used_method, "items": items},
        )
