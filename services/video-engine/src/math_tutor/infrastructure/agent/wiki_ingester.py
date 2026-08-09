"""wiki_ingester — post-session lesson extraction (Karpathy LLM-wiki ingest flow).

Triggered as a fire-and-forget background task after each session completes.
Loads the session's messages + tool calls from `ConversationStore`, builds a
compact summary, asks `fast_llm` whether anything non-trivial happened, and
writes a non-retrievable candidate. Repeated evidence from independent
sessions is required before `LearnedWiki.promote_candidate` exposes it to
production retrieval.

Failure modes (any one → skip silently, never raise):
  - LLM returned junk → can't parse → skip
  - LLM said "skip" → skip
  - LessonDecision contradicts schema (bad slug, bad category) → skip
  - Wiki disk write failed → skip + log warning

Feature gate: `LEARNED_WIKI_ENABLED=false` → ingester not constructed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from ...application.interfaces import (
    ChatMessage,
    ILLMProvider,
)
from ..storage import ConversationStore
from .learned_wiki import VALID_CATEGORIES, LearnedWiki, Lesson, slugify
from . import markdown_extract as md
from .prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


_MAX_SUMMARY_CHARS = 6000  # cap on session summary size sent to LLM


def _build_session_summary(
    *,
    session_id: str,
    problem: str,
    grade: str,
    messages: list[Any],
    tool_calls: list[Any],
    feedback: list[Any],
    success: bool,
    quality_evidence: str = "",
) -> str:
    """Render the session's salient events as compact markdown for ingest."""
    lines: list[str] = [
        f"# Session {session_id[:8]}",
        f"**问题**: {problem[:300]}",
        f"**年级**: {grade}",
        f"**最终结果**: {'成功' if success else '失败'}",
        "",
        "## 工具调用顺序与结果",
    ]
    # Just tool name + status + brief summary, plus error if failed
    for i, tc in enumerate(tool_calls[:30], start=1):
        name = getattr(tc, "tool_name", "") or getattr(tc, "name", "?")
        status = getattr(tc, "status", "")
        summary = (getattr(tc, "summary", "") or "")[:140]
        err = (getattr(tc, "error", "") or "")[:200]
        line = f"{i}. **{name}** → {status}"
        if summary:
            line += f" — {summary}"
        if err:
            line += f"  | 错误: {err}"
        lines.append(line)

    if feedback:
        lines.extend(["", "## 用户使用反馈"])
        for item in feedback[-5:]:
            label = str(getattr(item, "label", "") or "")
            notes = str(getattr(item, "notes", "") or "")[:500]
            lines.append(f"- label={label}; notes={notes or '（无文字说明）'}")

    if quality_evidence.strip():
        lines.extend(["", "## 成片质量证据", quality_evidence[:1800]])

    text = "\n".join(lines)
    if len(text) > _MAX_SUMMARY_CHARS:
        text = text[: _MAX_SUMMARY_CHARS] + "\n...（截断）"
    return text


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$")


def _copies_problem_content(lesson: Lesson, problem: str) -> bool:
    """Reject long verbatim fragments from one problem before quarantine."""
    lesson_text = re.sub(r"\s+", "", f"{lesson.title}\n{lesson.body}").lower()
    normalized_problem = re.sub(r"\s+", "", problem or "").lower()
    if len(normalized_problem) < 8:
        return False
    # Sliding fragments catch both CJK text and formula-rich statements
    # without requiring a language-specific tokenizer.
    fragment_size = 12
    for start in range(0, len(normalized_problem) - fragment_size + 1, 4):
        fragment = normalized_problem[start : start + fragment_size]
        if fragment in lesson_text:
            return True
    return False


def _parse_lesson_decision(text: str) -> Lesson | None:
    """Parse the ## Lesson Decision section. Returns None for skip / invalid."""
    section = md.find_section(text, "Lesson Decision", level=2) or md.find_section(
        text, "Lesson Decision"
    )
    if section is None:
        return None
    verdict = (md.get_field(section, "verdict") or "").strip().lower()
    if verdict != "write":
        return None  # skip / unknown verdict

    # The ingester must explicitly attest that the rule is independent of a
    # problem statement/type.  Ambiguous output is discarded, never guessed.
    scope = (md.get_field(section, "scope") or "").strip().lower()
    if scope != "universal":
        return None

    category = (md.get_field(section, "category") or "").strip().lower()
    if category not in VALID_CATEGORIES:
        return None
    title = (md.get_field(section, "title") or "").strip().strip('"').strip("'")
    if not title or len(title) < 3:
        return None

    raw_slug = (md.get_field(section, "slug") or "").strip().strip('"').strip("'").lower()
    # Tolerant slug validation: if it doesn't match strict pattern, derive from title
    slug = raw_slug if _SLUG_RE.match(raw_slug) else slugify(title)
    if not _SLUG_RE.match(slug):
        return None

    raw_kw = md.get_field(section, "keywords") or ""
    keywords = [k.strip() for k in re.split(r"[,，、]+", raw_kw) if k.strip()]
    if len(keywords) < 2:
        # Be lenient: the title itself can be a keyword
        keywords.append(title.lower())

    body_section = md.find_section(section, "body") or ""
    if not body_section.strip() or len(body_section.strip()) < 30:
        return None  # body too short to be useful

    return Lesson(
        title=title,
        category=category,
        slug=slug,
        body=body_section.strip(),
        keywords=keywords,
    )


class WikiIngester:
    """Glue between AgentLoop session-done events and the LearnedWiki."""

    def __init__(
        self,
        *,
        wiki: LearnedWiki,
        llm: ILLMProvider,
        prompts: PromptLibrary,
        store: ConversationStore,
    ) -> None:
        self._wiki = wiki
        self._llm = llm
        self._prompts = prompts
        self._store = store

    def schedule(self, session_id: str, *, success: bool) -> None:
        """Fire-and-forget: kick off ingestion in a background task. Errors
        are logged but never propagate (this must not break the agent)."""
        try:
            asyncio.create_task(self._safe_ingest(session_id, success=success))
        except Exception:
            logger.exception("wiki_ingester schedule failed (non-fatal)")

    async def _safe_ingest(self, session_id: str, *, success: bool) -> None:
        try:
            await self._ingest(session_id, success=success)
        except Exception:
            logger.exception(
                "wiki_ingester._ingest crashed for session %s (non-fatal)",
                session_id,
            )

    async def _ingest(self, session_id: str, *, success: bool) -> None:
        # 1. Load session data
        session = await self._store.get_session(session_id)
        if session is None:
            logger.info("wiki_ingester: session %s not found, skip", session_id)
            return
        messages = await self._store.list_messages(session_id)
        tool_calls = await self._store.list_tool_calls(session_id)
        feedback = await self._store.list_feedback(session_id)
        artifacts = await self._store.list_artifacts(session_id)
        quality_evidence = ""
        reports = [item for item in artifacts if item.kind == "quality_report"]
        if reports:
            raw_report = await self._store.archive.read_relative(reports[-1].path)
            try:
                report = json.loads(raw_report or "{}")
                evidence = {
                    "overall_quality": report.get("overall_quality"),
                    "b_total": report.get("b_total"),
                    "b_scores": report.get("b_scores"),
                    "technical_critical_issues": report.get("technical_critical_issues"),
                    "technical_warnings": report.get("technical_warnings"),
                    "issues": (report.get("issues") or [])[:5],
                    "fix_suggestion": (report.get("fix_suggestion") or [])[:3],
                }
                quality_evidence = json.dumps(evidence, ensure_ascii=False, indent=2)
            except (json.JSONDecodeError, TypeError):
                quality_evidence = ""

        # Heuristic prefilter: if the session had < 2 tool calls or success
        # on the first tool, very unlikely to have a non-trivial lesson.
        # Save an LLM call.
        if len(tool_calls) < 2:
            logger.info(
                "wiki_ingester: session %s has only %d tool calls, skip",
                session_id, len(tool_calls),
            )
            return

        # 2. Build summary
        summary = _build_session_summary(
            session_id=session_id,
            problem=session.problem,
            grade=session.grade,
            messages=messages,
            tool_calls=tool_calls,
            feedback=feedback,
            success=success,
            quality_evidence=quality_evidence,
        )

        # 3. Ask LLM
        prompt = self._prompts.render("wiki_ingest", session_summary=summary)
        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                temperature=0.2,
                max_tokens=2048,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
        except Exception:
            logger.exception("wiki_ingester LLM call failed (non-fatal)")
            return

        text = (getattr(done, "text", "") or "") or (
            getattr(done, "reasoning", "") or ""
        )
        lesson_draft = _parse_lesson_decision(text)
        if lesson_draft is None:
            logger.info(
                "wiki_ingester: session %s — verdict=skip or parse failed",
                session_id,
            )
            return
        if _copies_problem_content(lesson_draft, session.problem):
            logger.info(
                "wiki_ingester: session %s — candidate copied problem-specific content, skip",
                session_id,
            )
            return

        # 4. Attach session origin + write to quarantine.  The same stable
        # slug must recur across independent sessions before promotion.
        lesson_draft.session_origins = [session_id]
        try:
            written, created = self._wiki.write_candidate(lesson_draft)
            self._wiki.append_log(
                "candidate_create" if created else "candidate_merge",
                slug=written.slug,
                note=f"category={written.category} session={session_id[:8]}",
            )
            promoted = self._wiki.promote_candidate(written.slug, written.category)
            logger.info(
                "wiki_ingester: %s candidate %s/%s for session %s promoted=%s",
                "created" if created else "merged",
                written.category, written.slug, session_id[:8],
                promoted is not None,
            )
        except Exception:
            logger.exception("wiki_ingester write failed (non-fatal)")
