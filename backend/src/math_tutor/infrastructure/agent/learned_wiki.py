"""learned_wiki — Karpathy-style auto-evolving knowledge base for the agent.

Triggered after each session completes, an LLM-based ingester decides
whether anything non-trivial was learned and writes a lesson page. Future
RITL-DOC retrievals merge static `manim_api_kb.md` + these learned lessons.

3 layers (cf. https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
  - Sources: `data/sessions/<id>/` (already exists, immutable)
  - Wiki: `data/learned_wiki/lessons/{api,errors,strategies}/<slug>.md`
    + `index.md` (auto-rebuilt) + `log.md` (append-only)
  - Schema: `data/learned_wiki/wiki_schema.md` (you maintain)

This module owns the read/write/dedup/index logic. The actual LLM
ingestion is in `wiki_ingester.py`. Retrieval merge happens in
`manim_api_kb.py`.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

VALID_CATEGORIES = ("api", "errors", "strategies")

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_SLUG_OK_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$")


@dataclass
class Lesson:
    """One lesson page parsed from disk."""

    title: str
    category: str
    slug: str
    body: str
    keywords: list[str] = field(default_factory=list)
    created: str = ""           # ISO 8601 UTC
    updated: str = ""
    session_origins: list[str] = field(default_factory=list)
    retrievals: int = 0
    tags: list[str] = field(default_factory=list)
    path: Path | None = None    # set when loaded from disk

    def to_markdown(self) -> str:
        """Render as the canonical YAML-frontmatter + body format."""
        fm_lines = [
            f'title: "{self.title.replace(chr(34), chr(39))}"',
            f"category: {self.category}",
            f"slug: {self.slug}",
            f"keywords: [{', '.join(self.keywords)}]",
            f"created: {self.created}",
            f"updated: {self.updated}",
            f"session_origins: [{', '.join(self.session_origins)}]",
            f"retrievals: {self.retrievals}",
        ]
        if self.tags:
            fm_lines.append(f"tags: [{', '.join(self.tags)}]")
        return "---\n" + "\n".join(fm_lines) + "\n---\n\n" + self.body.strip() + "\n"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slugify(text: str) -> str:
    """Convert a title into kebab-case slug. ASCII-safe, file-safe."""
    s = text.lower().strip()
    # Replace any non-alphanumeric run with single dash
    s = re.sub(r"[^\w一-鿿]+", "-", s, flags=re.UNICODE)
    # Drop CJK (filename safety) — fall back to a hash if all gone
    s = re.sub(r"[一-鿿]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s or len(s) < 3:
        # Fallback: hash original text
        import hashlib
        s = "lesson-" + hashlib.md5(text.encode("utf-8")).hexdigest()[:8]
    return s[:60]


def _parse_yaml_list(value: str) -> list[str]:
    """Parse a simple YAML inline list [a, b, c]. Doesn't do real YAML."""
    s = value.strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1].strip()
    return [t.strip().strip('"').strip("'") for t in s.split(",") if t.strip()]


def _parse_lesson(text: str, path: Path | None = None) -> Lesson | None:
    """Parse a lesson markdown file."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    fm_text, body = m.group(1), m.group(2)
    fm: dict[str, str] = {}
    for line in fm_text.split("\n"):
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip()

    if not fm.get("title") or not fm.get("category") or not fm.get("slug"):
        return None
    category = fm["category"]
    if category not in VALID_CATEGORIES:
        return None

    try:
        retrievals = int(fm.get("retrievals", "0") or "0")
    except ValueError:
        retrievals = 0

    return Lesson(
        title=fm["title"].strip().strip('"').strip("'"),
        category=category,
        slug=fm["slug"].strip(),
        body=body.strip(),
        keywords=_parse_yaml_list(fm.get("keywords", "")),
        created=fm.get("created", "").strip(),
        updated=fm.get("updated", "").strip(),
        session_origins=_parse_yaml_list(fm.get("session_origins", "")),
        retrievals=retrievals,
        tags=_parse_yaml_list(fm.get("tags", "")),
        path=path,
    )


class LearnedWiki:
    """Filesystem-backed lesson store + index + log.

    Idempotent: every operation is safe to retry. Failures are logged
    but never raise out (wiki is a side-feature, must not break agent).
    """

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
        self._lessons_dir = self._root / "lessons"
        self._index_path = self._root / "index.md"
        self._log_path = self._root / "log.md"
        # Ensure structure exists, but don't crash if read-only fs
        try:
            for cat in VALID_CATEGORIES:
                (self._lessons_dir / cat).mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.warning("Could not create wiki dirs at %s", self._root)

    @property
    def root(self) -> Path:
        return self._root

    def list_lessons(self) -> list[Lesson]:
        """Load all lessons from disk. Sorted by category then slug."""
        out: list[Lesson] = []
        if not self._lessons_dir.exists():
            return out
        for cat in VALID_CATEGORIES:
            cat_dir = self._lessons_dir / cat
            if not cat_dir.exists():
                continue
            for md in sorted(cat_dir.glob("*.md")):
                try:
                    text = md.read_text(encoding="utf-8")
                except OSError:
                    continue
                lesson = _parse_lesson(text, path=md)
                if lesson is not None:
                    out.append(lesson)
        return out

    def get_lesson(self, slug: str, category: str | None = None) -> Lesson | None:
        """Find a lesson by slug. If category is given, only look there."""
        cats = [category] if category else VALID_CATEGORIES
        for cat in cats:
            if cat not in VALID_CATEGORIES:
                continue
            path = self._lessons_dir / cat / f"{slug}.md"
            if path.exists():
                try:
                    return _parse_lesson(path.read_text(encoding="utf-8"), path=path)
                except OSError:
                    return None
        return None

    def write_or_merge(self, lesson: Lesson) -> tuple[Lesson, bool]:
        """Write a new lesson or merge into existing same-slug one.

        Returns (final_lesson, created):
          - created=True: new file written
          - created=False: existing lesson updated (session_origins
            unioned, updated bumped, body kept from new lesson)
        """
        if lesson.category not in VALID_CATEGORIES:
            raise ValueError(f"invalid category: {lesson.category}")
        if not _SLUG_OK_RE.match(lesson.slug):
            raise ValueError(f"invalid slug: {lesson.slug}")

        existing = self.get_lesson(lesson.slug, category=lesson.category)
        now = _now_iso()
        if existing is not None:
            # Merge: keep created, bump updated, union origins, increment
            # retrievals stays as-is (only RITL-DOC writes that field)
            merged_origins = list(
                dict.fromkeys(existing.session_origins + lesson.session_origins)
            )
            merged = Lesson(
                title=lesson.title or existing.title,
                category=lesson.category,
                slug=lesson.slug,
                body=lesson.body or existing.body,  # new body wins
                keywords=list(dict.fromkeys(existing.keywords + lesson.keywords)),
                created=existing.created or now,
                updated=now,
                session_origins=merged_origins,
                retrievals=existing.retrievals,
                tags=list(dict.fromkeys(existing.tags + lesson.tags)),
            )
            self._write(merged)
            return merged, False

        new = Lesson(
            title=lesson.title,
            category=lesson.category,
            slug=lesson.slug,
            body=lesson.body,
            keywords=lesson.keywords,
            created=lesson.created or now,
            updated=now,
            session_origins=lesson.session_origins,
            retrievals=0,
            tags=lesson.tags,
        )
        self._write(new)
        return new, True

    def _write(self, lesson: Lesson) -> None:
        path = self._lessons_dir / lesson.category / f"{lesson.slug}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(lesson.to_markdown(), encoding="utf-8")

    def increment_retrievals(self, lesson: Lesson) -> None:
        """Bump the retrieval counter on disk (for stale detection)."""
        if lesson.path is None:
            return
        try:
            current = self.get_lesson(lesson.slug, category=lesson.category)
            if current is None:
                return
            current.retrievals = current.retrievals + 1
            self._write(current)
        except OSError:
            pass

    def rebuild_index(self) -> None:
        """Regenerate `index.md` from disk."""
        lessons = self.list_lessons()
        lines = ["# Learned Wiki — Index", "",
                 "_Auto-generated. Do not edit by hand — changes lost on next ingest._",
                 ""]
        if not lessons:
            lines.append("(空，还没积累任何 lesson — `LEARNED_WIKI_ENABLED=true` 跑几道题就有了)")
        else:
            for cat in VALID_CATEGORIES:
                cat_lessons = [l for l in lessons if l.category == cat]
                if not cat_lessons:
                    continue
                cat_label = {"api": "API 用法", "errors": "错误模式", "strategies": "视觉策略"}[cat]
                lines.append(f"## {cat_label}")
                lines.append("")
                for l in sorted(cat_lessons, key=lambda x: x.slug):
                    lines.append(
                        f"- [{l.title}](lessons/{cat}/{l.slug}.md) "
                        f"— created {l.created[:10]}, retrievals {l.retrievals}"
                    )
                lines.append("")
        try:
            self._index_path.write_text("\n".join(lines), encoding="utf-8")
        except OSError:
            logger.warning("Could not write index.md")

    def append_log(self, action: str, slug: str = "", note: str = "") -> None:
        """Append a single line to log.md."""
        line = f"- {_now_iso()} | {action}"
        if slug:
            line += f" | slug={slug}"
        if note:
            line += f" | {note[:200]}"
        try:
            with self._log_path.open("a", encoding="utf-8") as f:
                if self._log_path.stat().st_size == 0:
                    f.write("# Learned Wiki — Log\n\n")
                f.write(line + "\n")
        except OSError:
            logger.warning("Could not append to log.md")
