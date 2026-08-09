"""
PromptLibrary — load externalized prompt markdown templates and render
them with safe slot substitution.

Templates live in `prompt_templates/<name>.md`. Slots are written as
`{slot_name}`. A missing slot is left as-is rather than raising — the
caller stays in control of what to fill.

This is the static layer of our prompt strategy (DispatchMind-style):
  - Identity / role / output format / constraints  →  the .md file
  - Per-call dynamic context (problem text, grade, error hints, …)
    →  passed as render() kwargs

We deliberately don't use Jinja2: the substitution model here is simple
enough that a pure-stdlib regex is clearer, and tool implementations
(not templates) are the right place to assemble conditional sections.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")


def safe_format(template: str, **slots: object) -> str:
    """Substitute `{slot}` placeholders with provided values; leave unknown
    placeholders untouched (no KeyError). String coercion via str(value).
    """

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key in slots:
            return str(slots[key])
        return match.group(0)

    return _PLACEHOLDER_RE.sub(replace, template)


class PromptLibrary:
    def __init__(self, templates_dir: Path | str | None = None) -> None:
        if templates_dir is None:
            templates_dir = Path(__file__).parent / "prompt_templates"
        self._dir = Path(templates_dir)
        self._cache: dict[str, str] = {}
        self._load_all()

    def _load_all(self) -> None:
        if not self._dir.exists():
            logger.warning("prompt templates dir not found: %s", self._dir)
            return
        for md_file in self._dir.glob("*.md"):
            try:
                self._cache[md_file.stem] = md_file.read_text(encoding="utf-8")
            except Exception:
                logger.exception("failed to read %s", md_file)
        logger.info(
            "PromptLibrary loaded %d templates: %s",
            len(self._cache),
            sorted(self._cache.keys()),
        )

    def has(self, name: str) -> bool:
        return name in self._cache

    def get(self, name: str) -> str:
        try:
            return self._cache[name]
        except KeyError:
            raise KeyError(
                f"prompt template not found: {name!r} (available: "
                f"{sorted(self._cache.keys())})"
            ) from None

    def render(self, name: str, **slots: object) -> str:
        return safe_format(self.get(name), **slots)

    def reload(self) -> None:
        """Re-read all template files. Useful in development."""
        self._cache.clear()
        self._load_all()
