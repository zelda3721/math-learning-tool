"""manim_api_kb — RITL-DOC retrieval over the Manim API knowledge base.

Loads `manim_api_kb.md` once, parses it into per-API entries (each H3 section
with a `**关键词**:` line), and provides keyword-based lookup against an
error message. Returns top-K relevant entries ready to inject into a fix-
mode prompt.

Rationale: when generate_manim_code's first attempt fails (validate / run /
inspect), the next attempt benefits from seeing the *correct* signature +
common gotchas of the APIs implicated in the error, rather than the model
re-guessing from training memory. Code2Video / ManimTrainer paper reports
RITL-DOC giving +6-8% render-success vs RITL alone.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class KBEntry:
    """One API documentation entry."""

    name: str           # e.g. "Transform"
    body: str           # full markdown content under the heading
    keywords: list[str] = field(default_factory=list)
    section: str = ""   # parent H2 section (e.g. "变换动画")


_KEYWORDS_RE = re.compile(r"\*\*关键词\*\*\s*[:：]\s*(.+?)(?:\n|$)")


def _split_keywords(raw: str) -> list[str]:
    """Split a `**关键词**:` line into discrete tokens. Accepts , / 、 / spaces."""
    return [t.strip().lower() for t in re.split(r"[,，、/\s]+", raw) if t.strip()]


def _parse_entries(text: str) -> list[KBEntry]:
    """Parse the KB markdown into per-H3 entries, tracking parent H2 section."""
    if not text:
        return []
    entries: list[KBEntry] = []
    current_h2 = ""
    # Match any H2 (## ...) and H3 (### ...). Scan top-down keeping H2 state.
    chunks = re.split(r"^(#{2,3})\s+(.+?)$", text, flags=re.MULTILINE)
    # chunks: [pre, hashes1, title1, body1, hashes2, title2, body2, ...]
    # Iterate in groups of 3 starting from index 1.
    i = 1
    while i + 2 < len(chunks):
        hashes = chunks[i]
        title = chunks[i + 1].strip()
        body = chunks[i + 2]
        i += 3
        if hashes == "##":
            current_h2 = title
            continue
        if hashes != "###":
            continue
        # H3 — an entry. Body runs until next ## or ### (already split).
        kw_match = _KEYWORDS_RE.search(body)
        keywords = _split_keywords(kw_match.group(1)) if kw_match else []
        # Add the API name itself + any inline-listed names ("Transform / ReplacementTransform")
        for n in re.split(r"[\s/、]+", title):
            n = n.strip()
            if n and n.lower() not in keywords:
                keywords.append(n.lower())
        entries.append(
            KBEntry(
                name=title,
                body=body.strip(),
                keywords=keywords,
                section=current_h2,
            )
        )
    return entries


class ManimApiKnowledgeBase:
    """Singleton-ish loader + retriever for the Manim API KB.

    Optionally merges learned wiki lessons (Karpathy-style auto-evolving
    KB) on each lookup. The static KB is loaded once at construction; the
    learned wiki is read-on-demand so freshly written lessons are visible
    immediately without restart.
    """

    DEFAULT_KB_PATH = Path(__file__).parent / "manim_api_kb.md"

    def __init__(
        self,
        path: Path | None = None,
        learned_wiki_dir: Path | None = None,
    ) -> None:
        self._path = Path(path) if path else self.DEFAULT_KB_PATH
        self._learned_wiki_dir = Path(learned_wiki_dir) if learned_wiki_dir else None
        self._entries: list[KBEntry] = []
        self._load()

    def set_learned_wiki_dir(self, learned_wiki_dir: Path | str | None) -> None:
        """Configure the learned wiki path (called from dependencies.py)."""
        self._learned_wiki_dir = Path(learned_wiki_dir) if learned_wiki_dir else None

    def _load(self) -> None:
        if not self._path.exists():
            logger.warning("Manim API KB not found at %s", self._path)
            return
        try:
            text = self._path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("Failed to read Manim API KB: %s", exc)
            return
        self._entries = _parse_entries(text)
        logger.info(
            "ManimApiKB loaded: %d entries (sections=%s)",
            len(self._entries),
            sorted({e.section for e in self._entries if e.section}),
        )

    def reload(self) -> None:
        """Re-parse the file. Useful in dev when iterating on the KB."""
        self._load()

    @property
    def entries(self) -> list[KBEntry]:
        return list(self._entries)

    def lookup(self, error_text: str, top_k: int = 3) -> list[KBEntry]:
        """Return up to top_k entries whose keywords best match the error text.

        Scoring is keyword-overlap based (case-insensitive substring): each
        matched keyword contributes +1; multi-word keywords matching as a
        block get a small bonus. Learned-wiki lessons get a +0.5 bonus over
        static KB entries with same score (more specific to this project).
        Ties broken by entry order.
        """
        if not error_text:
            return []
        haystack = error_text.lower()
        all_entries = list(self._entries) + self._learned_entries()
        if not all_entries:
            return []

        scored: list[tuple[float, int, KBEntry]] = []
        for idx, e in enumerate(all_entries):
            score = 0.0
            for kw in e.keywords:
                if not kw:
                    continue
                if kw in haystack:
                    score += 1.5 if (" " in kw or len(kw) >= 8) else 1.0
            if score > 0:
                # Section "learned/*" gets a small priority bump
                if e.section.startswith("learned/"):
                    score += 0.5
                scored.append((score, idx, e))
        scored.sort(key=lambda t: (-t[0], t[1]))
        return [e for _, _, e in scored[:top_k]]

    def _learned_entries(self) -> list[KBEntry]:
        """Read learned wiki lessons fresh each lookup. Empty if not
        configured or if the directory doesn't exist yet."""
        if self._learned_wiki_dir is None:
            return []
        lessons_dir = self._learned_wiki_dir / "lessons"
        if not lessons_dir.exists():
            return []
        out: list[KBEntry] = []
        # Reuse parser by treating lesson body as KB body. Section label
        # encodes category for retrieval bias.
        try:
            # Local import to avoid circular dep at module load time
            from .learned_wiki import VALID_CATEGORIES, _parse_lesson
        except ImportError:
            return []
        for cat in VALID_CATEGORIES:
            cat_dir = lessons_dir / cat
            if not cat_dir.exists():
                continue
            for md_file in cat_dir.glob("*.md"):
                try:
                    text = md_file.read_text(encoding="utf-8")
                except OSError:
                    continue
                lesson = _parse_lesson(text, path=md_file)
                if lesson is None:
                    continue
                out.append(
                    KBEntry(
                        name=lesson.title,
                        body=lesson.body,
                        keywords=list(lesson.keywords),
                        section=f"learned/{lesson.category}",
                    )
                )
        return out

    def render_section(self, entries: list[KBEntry], *, max_chars: int = 2400) -> str:
        """Format a list of entries as a markdown block ready for prompt injection.

        Truncates each entry's body to keep the total under `max_chars`."""
        if not entries:
            return ""
        chunks: list[str] = ["## 相关 Manim API 文档（按错误信息自动匹配）"]
        budget = max_chars
        per_entry = max(300, max_chars // max(1, len(entries)))
        for e in entries:
            body = e.body
            if len(body) > per_entry:
                body = body[:per_entry].rstrip() + "\n…（截断）"
            chunk = f"### {e.name}\n{body}"
            if len(chunk) > budget:
                break
            chunks.append(chunk)
            budget -= len(chunk)
        return "\n\n".join(chunks)


# Module-level convenience instance. Tools can import and use directly.
_KB_SINGLETON: ManimApiKnowledgeBase | None = None


def get_kb() -> ManimApiKnowledgeBase:
    global _KB_SINGLETON
    if _KB_SINGLETON is None:
        _KB_SINGLETON = ManimApiKnowledgeBase()
    return _KB_SINGLETON
