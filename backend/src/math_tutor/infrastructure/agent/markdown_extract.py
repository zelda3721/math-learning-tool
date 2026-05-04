"""
Lenient markdown extraction for LLM-emitted structured output.

LLMs (especially Qwen3 / Claude / GPT) are heavily trained on markdown,
so asking for `## Section`, `**field**: value`, and `- item` lists
produces more reliable output than JSON or XML — and it's also the most
human-readable raw form.

Functions are tolerant: missing sections return empty/None instead of
raising. JSON parsing is provided as a final fallback.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)

# Defensive cleanup for thinking-mode residue.
#
# Even though the LLM provider's _ReasoningSplitter routes <think>...</think>
# blocks to a separate reasoning channel, three things can leave residual
# tags in the text we parse here:
#   1. A non-conforming server that doesn't strip tags before sending
#   2. An unclosed <think> at end of stream (max_tokens hit mid-thought)
#   3. The caller deliberately passing the *reasoning* channel to us as a
#      fallback (then the raw <think>/</think> tags are still inside)
#
# Strip them so all section/field/bullet extractors see only the structured
# answer content, regardless of upstream behavior. Idempotent — calling on
# already-clean text is a no-op.
_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"<think>[\s\S]*$", re.IGNORECASE)
_THINK_CLOSE_RE = re.compile(r"^[\s\S]*?</think>", re.IGNORECASE)


def strip_thinking(text: str) -> str:
    """Remove any <think>...</think> blocks (closed, unclosed, or orphan
    closing tags) from `text`. Defensive — works on partial/malformed input."""
    if not text:
        return text
    # 1. Closed blocks: <think>...</think>
    cleaned = _THINK_BLOCK_RE.sub("", text)
    # 2. Unclosed opening: <think> at end without close → drop tail
    cleaned = _THINK_OPEN_RE.sub("", cleaned)
    # 3. Orphan closing: text starts with content + </think> without earlier open
    # Only triggers if </think> appears in the first ~300 chars (otherwise it's
    # legitimately part of the body). Drops everything up to and including the close.
    head = cleaned[:300].lower()
    if "</think>" in head and "<think>" not in head:
        cleaned = _THINK_CLOSE_RE.sub("", cleaned, count=1)
    return cleaned.strip()


def _normalize(s: str) -> str:
    return s.strip().lower().replace("　", " ")


def find_section(text: str, heading: str, *, level: int | None = None) -> str | None:
    """Return the inner content of the first markdown section whose heading
    matches `heading` (case- and whitespace-insensitive).

    Section content runs from the heading line until the next heading at
    the **same or shallower** level (or end of document).

    `level` (1-6) restricts which heading depth to look for; None matches any.

    Thinking blocks are stripped first so that `## 解题` inside a `<think>`
    block doesn't shadow the real answer's heading after it.
    """
    if not text:
        return None
    text = strip_thinking(text)
    target = _normalize(heading)
    for m in _HEADING_RE.finditer(text):
        hashes, title = m.group(1), m.group(2)
        if level is not None and len(hashes) != level:
            continue
        if _normalize(title) != target:
            continue
        start = m.end()
        my_level = len(hashes)
        # Find next heading at same or shallower level
        next_pos = None
        for nm in _HEADING_RE.finditer(text, start):
            if len(nm.group(1)) <= my_level:
                next_pos = nm.start()
                break
        return text[start:next_pos].strip() if next_pos else text[start:].strip()
    return None


def find_subsections(text: str, level: int) -> list[tuple[str, str]]:
    """Return [(heading_title, content), ...] for every heading at exactly
    the given level inside `text`."""
    if not text:
        return []
    text = strip_thinking(text)
    out: list[tuple[str, str]] = []
    matches = list(_HEADING_RE.finditer(text))
    for i, m in enumerate(matches):
        if len(m.group(1)) != level:
            continue
        start = m.end()
        # next heading at same or shallower level
        next_pos = None
        for nm in matches[i + 1 :]:
            if len(nm.group(1)) <= level:
                next_pos = nm.start()
                break
        body = text[start:next_pos].strip() if next_pos else text[start:].strip()
        out.append((m.group(2).strip(), body))
    return out


_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$", re.MULTILINE)


def get_bullets(text: str | None) -> list[str]:
    """All `- x`, `* x`, `+ x`, `1. x` lines as their content strings."""
    if not text:
        return []
    return [m.group(1).strip() for m in _BULLET_RE.finditer(text)]


_KV_RE = re.compile(
    r"^\s*(?:[-*+]|\d+\.)\s+"          # bullet (optional)
    r"(?:\*\*([^*]+?)\*\*|([^：:]+?))"   # bold or plain key
    r"\s*[：:]\s*(.+?)\s*$",            # colon then value
    re.MULTILINE,
)
_INLINE_KV_RE = re.compile(
    r"\*\*([^*\n]+?)\*\*\s*[：:]\s*(.+?)(?=\n|$)",
)


def get_kv_dict(text: str | None) -> dict[str, str]:
    """Extract `**key**: value` and `- key: value` patterns as a dict."""
    if not text:
        return {}
    out: dict[str, str] = {}
    # Bold inline fields like `**Strategy**: 假设法`
    for m in _INLINE_KV_RE.finditer(text):
        out[m.group(1).strip()] = m.group(2).strip()
    # Bullet KV lines (possibly with bold key)
    for m in _KV_RE.finditer(text):
        key = (m.group(1) or m.group(2) or "").strip()
        val = m.group(3).strip()
        if key and key not in out:
            out[key] = val
    return out


def get_field(text: str | None, *names: str) -> str:
    """Convenience: try each name in turn against `**name**: value` and
    return the first hit (case-insensitive). Empty string if none."""
    if not text:
        return ""
    kv = get_kv_dict(text)
    lowered = {k.lower(): v for k, v in kv.items()}
    for name in names:
        v = lowered.get(name.lower())
        if v:
            return v
    return ""


def parse_json_anywhere(text: str) -> dict[str, Any] | None:
    """Best-effort JSON object extraction (final fallback when models
    ignore markdown formatting)."""
    if not text:
        return None
    text = strip_thinking(text)
    match = re.search(r"\{[\s\S]*\}", text)
    if match is None:
        return None
    try:
        result = json.loads(match.group())
    except Exception:
        return None
    return result if isinstance(result, dict) else None
