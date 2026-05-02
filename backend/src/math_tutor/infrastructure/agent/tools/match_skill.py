"""match_skill — wrap SkillRepository.find_best_match for the agent.

When the substring keyword match in the file repository fails or is
ambiguous, fall back to letting the LLM look at all skill names +
descriptions and pick the most fitting one. This handles synonyms,
paraphrases, and combination problems that pure substring miss.
"""
from __future__ import annotations

import logging
from typing import Any

from ....application.interfaces import (
    ChatMessage,
    ILLMProvider,
    ISkillRepository,
    ITool,
    ToolContext,
    ToolResult,
)
from ...storage import SemanticIndex
from .. import markdown_extract as md
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


class MatchSkillTool(ITool):
    def __init__(
        self,
        skill_repo: ISkillRepository,
        *,
        llm: ILLMProvider | None = None,
        prompts: PromptLibrary | None = None,
        llm_fallback: bool = True,
        llm_top_k: int = 1,
        semantic_index: SemanticIndex | None = None,
        semantic_min_score: float = 0.40,
    ) -> None:
        self._repo = skill_repo
        self._llm = llm
        self._prompts = prompts
        self._llm_fallback = llm_fallback and llm is not None
        self._llm_top_k = max(1, llm_top_k)
        self._semantic_index = semantic_index
        self._semantic_min_score = semantic_min_score

    @property
    def name(self) -> str:
        return "match_skill"

    @property
    def description(self) -> str:
        return (
            "在内置技能库（鸡兔同笼、二次函数、追及/相遇问题等）里匹配最契合的"
            "可视化技能。先用关键词，关键词没命中时自动让 LLM 从全量 skill 列表里挑。"
            "命中后返回 prompt_template、可选的 code_template，generate_manim_code "
            "会自动作为骨架使用。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "用于匹配的题目文本或核心概念",
                },
                "grade": {
                    "type": "string",
                    "description": "学生年级",
                },
                "include_prompt_template": {
                    "type": "boolean",
                    "description": "是否返回完整 prompt_template（默认 true）",
                    "default": True,
                },
                "force_llm": {
                    "type": "boolean",
                    "description": "跳过关键词匹配直接让 LLM 选（默认 false）",
                    "default": False,
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = (args.get("query") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        include_template = bool(args.get("include_prompt_template", True))
        force_llm = bool(args.get("force_llm", False))

        skill = None
        match_method = "keyword"

        if not force_llm:
            skill = self._repo.find_best_match(query, grade)

        # Semantic fallback for skill match (between keyword and LLM)
        if skill is None and not force_llm and self._semantic_index is not None:
            skill = await self._semantic_match_skill(query, grade)
            if skill is not None:
                match_method = "semantic"

        if skill is None and self._llm_fallback:
            match_method = "llm"
            skill = await self._llm_pick(query, grade)

        # Always also try to match generic visualization patterns. Patterns
        # are independent of specific math problems and provide reusable
        # helper code that generate_manim_code can splice into its prompt.
        # Use semantic ranking when available — much better than keyword.
        matched_patterns = []
        if self._semantic_index is not None and hasattr(self._repo, "list_patterns"):
            try:
                matched_patterns = await self._semantic_match_patterns(query)
            except Exception:
                logger.exception("semantic pattern match failed; falling back")
                matched_patterns = []
        if not matched_patterns and hasattr(self._repo, "find_matching_patterns"):
            try:
                matched_patterns = (
                    self._repo.find_matching_patterns(query, top_k=2) or []
                )
            except Exception:
                logger.exception("find_matching_patterns failed")
                matched_patterns = []

        # Build state entries for downstream tools regardless of skill outcome
        if matched_patterns:
            ctx.state["matched_patterns"] = [
                {
                    "name": p.name,
                    "description": p.description,
                    "core_code": p.core_code,
                }
                for p in matched_patterns
            ]

        if skill is None and not matched_patterns:
            return ToolResult(
                success=True,
                summary="未匹配到技能或可视化模式",
                data={"matched": False, "method": match_method, "patterns": []},
            )

        # Build response data
        data: dict[str, Any] = {
            "matched": skill is not None,
            "match_method": match_method,
            "patterns": [
                {"name": p.name, "description": p.description}
                for p in matched_patterns
            ],
        }
        if skill is not None:
            has_code_template = (
                bool(skill.code_template) and len(skill.code_template) > 100
            )
            data.update(
                {
                    "name": skill.name,
                    "description": skill.description,
                    "keywords": list(skill.keywords),
                    "has_code_template": has_code_template,
                }
            )
            if include_template:
                data["prompt_template"] = skill.prompt_template
                if has_code_template:
                    data["code_template"] = skill.code_template

            ctx.state["matched_skill"] = skill.name
            ctx.state["matched_skill_prompt"] = skill.prompt_template
            if has_code_template:
                ctx.state["matched_skill_code_template"] = skill.code_template

        # Build summary
        if skill is not None:
            summary = f"命中技能 {skill.name}（via {match_method}）"
            if data.get("has_code_template"):
                summary += "，含代码模板"
        else:
            summary = "未命中具体技能"
        if matched_patterns:
            pat_names = ", ".join(p.name for p in matched_patterns)
            summary += f"；匹配可视化模式：{pat_names}"
        return ToolResult(success=True, summary=summary, data=data)

    async def _semantic_match_skill(self, query: str, grade: str) -> Any:
        """Embedding-based skill ranking. Uses skill name + description as
        the embed-able text."""
        if self._semantic_index is None:
            return None
        try:
            skills = list(self._repo.list_skills(None) or [])
        except Exception:
            return None
        if not skills:
            return None
        candidates = [
            (f"{s.name}: {s.description or ''} {' '.join(s.keywords or [])}", s)
            for s in skills
        ]
        try:
            ranked = await self._semantic_index.rank(
                query,
                candidates,
                top_k=1,
                min_score=self._semantic_min_score,
            )
        except Exception:
            logger.exception("semantic skill match failed")
            return None
        return ranked[0][1] if ranked else None

    async def _semantic_match_patterns(self, query: str) -> list[Any]:
        """Embedding-based pattern ranking. Returns top-2 patterns above
        threshold."""
        if self._semantic_index is None:
            return []
        patterns = list(self._repo.list_patterns())
        if not patterns:
            return []
        candidates = [
            (f"{p.name}: {p.description} {' '.join(p.keywords or [])}", p)
            for p in patterns
        ]
        ranked = await self._semantic_index.rank(
            query,
            candidates,
            top_k=2,
            min_score=0.30,  # patterns are intentionally generic, lower threshold
        )
        return [p for _, p in ranked]

    async def _llm_pick(self, query: str, grade: str) -> Any:
        if self._llm is None or self._prompts is None:
            return None
        try:
            skills = list(self._repo.list_skills(None) or [])
        except Exception:
            logger.exception("list_skills failed in match_skill LLM fallback")
            skills = []
        if not skills:
            return None

        catalog_lines: list[str] = []
        for s in skills:
            kws = ",".join(s.keywords[:6]) if s.keywords else ""
            line = f"- {s.name}: {s.description}"
            if kws:
                line += f"（关键词：{kws}）"
            catalog_lines.append(line)
        catalog = "\n".join(catalog_lines)

        prompt = self._prompts.render(
            "match_skill_llm", grade=grade, query=query, catalog=catalog
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.0,
                max_tokens=512,
                # Tiny structured pick — thinking is overkill.
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception:
            logger.exception("match_skill LLM fallback failed")
            return None

        # Try `**选择**: name` markdown first, then JSON fallback.
        name = ""
        for source in (
            getattr(done, "text", "") or "",
            getattr(done, "reasoning", "") or "",
        ):
            if not source:
                continue
            picked = md.get_field(source, "选择", "pick", "选中", "答案")
            if picked:
                name = picked.strip()
                break
            json_payload = md.parse_json_anywhere(source)
            if json_payload and isinstance(json_payload.get("name"), str):
                name = json_payload["name"].strip()
                break

        if not name or name.upper() == "NONE":
            return None
        for s in skills:
            if s.name == name:
                return s
        return None
