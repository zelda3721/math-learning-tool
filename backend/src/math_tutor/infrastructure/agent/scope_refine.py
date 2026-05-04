"""ScopeRefine — three-tier fix mechanism inspired by Code2Video.

Instead of "regenerate the whole file every time something fails", classify
the error and start fixing at the smallest reasonable scope. Escalate only
when the smaller fix exhausts its budget. This is the single biggest
engineering win Code2Video reported (15.4 min vs 42.9 min, 2.8× faster).

Three scopes:
  line   — fix line ± 1 (e.g. SyntaxError on line N, NameError, typo)
  block  — fix the enclosing method/function/Phase comment block
           (e.g. wrong API signature, missing arrange, overlap inside one
           Phase). A "block" here is heuristically the smallest top-level
           function or `# ---- Phase N ----` comment region.
  global — regenerate the whole file (current default behavior)

Escalation policy (default budgets — caller can override):
  K_line   = 2   line attempts before bumping to block
  K_block  = 2   block attempts before bumping to global
  K_global = 1   global attempt before triggering visual_plan replan

Usage:
  >>> scope = classify_error_scope(err_text, source="run")
  >>> if scope == "line":
  ...     ctx, lo, hi = extract_line_context(code, line_no=42, radius=1)
  ...     # ask LLM to rewrite just `ctx`
  ...     code = splice_lines(code, lo, hi, fixed_lines)
"""
from __future__ import annotations

import logging
import re
from typing import Literal

logger = logging.getLogger(__name__)


Scope = Literal["line", "block", "global"]

DEFAULT_BUDGETS: dict[Scope, int] = {"line": 2, "block": 2, "global": 1}


# ---------------------------------------------------------------------------
# Error → Scope classification
# ---------------------------------------------------------------------------

_LINE_RE = re.compile(r"\bline\s+(\d+)", re.IGNORECASE)
_SYNTAX_HINTS = (
    "syntaxerror",
    "indentationerror",
    "unexpected indent",
    "unexpected token",
    "invalid syntax",
    "eol while scanning",
    "language line",  # our own validator's "Line 42: ..."
)
_NAME_HINTS = ("nameerror", "is not defined", "attributeerror", "no attribute")
_BLOCK_HINTS = (
    "禁用对象",
    "缺少 vgroup",
    "缺少 from manim",
    "缺少 layout",
    "缺少 latex",
    "动画过密",
    "重叠风险",
    "overlap_risk",
    "missing_layout",
    "missing_quality",
    "code_too_long",
)
_GLOBAL_HINTS = (
    "structure_issues",
    "缺少 solutionscene",
    "modulenotfounderror",
    "importerror",
    "无法解析",
    "parse_error",
    "manim 执行异常",
)


def classify_error_scope(
    error_text: str,
    *,
    source: Literal["validate", "run", "inspect"] = "run",
    inspect_payload: dict | None = None,
) -> Scope:
    """Classify an error string into the smallest reasonable fix scope.

    Decision tree:
      1. inspect_video failures: smart-route via `classify_visual_failure`
         using the rubric scores (B6 / blacklist / issue keywords)
      2. structural / module-level errors ⇒ "global"
      3. block-level hints (banned obj, density, overlap) ⇒ "block"
      4. anything with a clear `line N` and a syntax/name signature ⇒ "line"
      5. otherwise ⇒ "block" (safe middle ground)
    """
    if source == "inspect":
        return classify_visual_failure(inspect_payload, error_text)

    text = (error_text or "").lower()
    if not text.strip():
        return "global"

    if any(h in text for h in _GLOBAL_HINTS):
        return "global"

    if any(h in text for h in _BLOCK_HINTS):
        return "block"

    has_line = bool(_LINE_RE.search(text))
    is_syntax = any(h in text for h in _SYNTAX_HINTS)
    is_name = any(h in text for h in _NAME_HINTS)

    if has_line and (is_syntax or is_name):
        return "line"
    if is_syntax or is_name:
        return "line"

    return "block"


def extract_error_line(error_text: str) -> int | None:
    """Best-effort: pull a single line number out of an error message.
    Returns None if multiple lines or none are mentioned."""
    if not error_text:
        return None
    matches = _LINE_RE.findall(error_text)
    if len(matches) == 1:
        try:
            return int(matches[0])
        except ValueError:
            return None
    if matches:
        # Multiple line numbers — take the first one as primary.
        try:
            return int(matches[0])
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# Code slicing utilities
# ---------------------------------------------------------------------------


def extract_line_context(
    code: str, *, line_no: int, radius: int = 1
) -> tuple[str, int, int]:
    """Return (snippet, start_line, end_line) covering line_no ± radius.

    Line numbers are 1-based. Returned start/end are 1-based and inclusive.
    """
    lines = code.split("\n")
    n = len(lines)
    line_no = max(1, min(n, line_no))
    lo = max(1, line_no - radius)
    hi = min(n, line_no + radius)
    snippet = "\n".join(lines[lo - 1 : hi])
    return snippet, lo, hi


_PHASE_RE = re.compile(r"^\s*#\s*={3,}\s*Phase\s+\d+", re.MULTILINE | re.IGNORECASE)
_DEF_RE = re.compile(r"^(\s*)(def|class)\s+\w+", re.MULTILINE)


def extract_enclosing_block(
    code: str, *, line_no: int
) -> tuple[str, int, int]:
    """Return (block_text, start_line, end_line) of the smallest natural
    block enclosing `line_no`.

    Priority order:
      1. nearest preceding `# ==== Phase N ====` comment block — extends to
         the next `# ====` or end of containing method
      2. nearest preceding `def construct(self):` body
      3. fallback: line ± 6
    """
    if not code.strip():
        return code, 1, len(code.split("\n"))

    lines = code.split("\n")
    n = len(lines)
    line_no = max(1, min(n, line_no))

    # 1) Try Phase comment blocks
    phase_starts: list[int] = []
    for m in _PHASE_RE.finditer(code):
        # Convert match position to 1-based line number
        line_idx = code[: m.start()].count("\n") + 1
        phase_starts.append(line_idx)

    enclosing_phase: int | None = None
    next_phase_after: int | None = None
    for s in phase_starts:
        if s <= line_no:
            enclosing_phase = s
        elif next_phase_after is None and s > line_no:
            next_phase_after = s
            break

    if enclosing_phase is not None:
        end_line = (next_phase_after - 1) if next_phase_after else n
        block = "\n".join(lines[enclosing_phase - 1 : end_line])
        return block, enclosing_phase, end_line

    # 2) Try def boundaries
    def_starts: list[tuple[int, int]] = []  # (line_idx, indent_level)
    for m in _DEF_RE.finditer(code):
        line_idx = code[: m.start()].count("\n") + 1
        indent = len(m.group(1))
        def_starts.append((line_idx, indent))

    enclosing_def: tuple[int, int] | None = None
    for s, indent in def_starts:
        if s <= line_no:
            enclosing_def = (s, indent)
        else:
            break

    if enclosing_def is not None:
        s_line, s_indent = enclosing_def
        # Block ends at next def at same-or-shallower indent, or EOF
        end_line = n
        for next_s, next_indent in def_starts:
            if next_s > s_line and next_indent <= s_indent:
                end_line = next_s - 1
                break
        block = "\n".join(lines[s_line - 1 : end_line])
        return block, s_line, end_line

    # 3) Fallback: ±6 lines
    radius = 6
    lo = max(1, line_no - radius)
    hi = min(n, line_no + radius)
    return "\n".join(lines[lo - 1 : hi]), lo, hi


def splice_lines(
    code: str, *, start_line: int, end_line: int, replacement: str
) -> str:
    """Replace `code` lines [start_line, end_line] (1-based, inclusive) with
    `replacement`. Returns the new full text."""
    lines = code.split("\n")
    n = len(lines)
    if start_line < 1 or end_line < start_line or start_line > n:
        return code
    end_line = min(end_line, n)
    new_lines = lines[: start_line - 1] + replacement.split("\n") + lines[end_line:]
    return "\n".join(new_lines)


# ---------------------------------------------------------------------------
# Escalation state machine
# ---------------------------------------------------------------------------


def next_scope(
    current: Scope,
    *,
    attempts_so_far: dict[str, int] | None = None,
    budgets: dict[Scope, int] | None = None,
) -> Scope | None:
    """Decide what scope to use next, given how many times each scope has
    been tried. Returns None when the global budget is exhausted (caller
    should trigger a visual_plan replan)."""
    attempts = attempts_so_far or {}
    b = budgets or DEFAULT_BUDGETS

    line_used = attempts.get("line", 0)
    block_used = attempts.get("block", 0)
    global_used = attempts.get("global", 0)

    if current == "line":
        if line_used < b["line"]:
            return "line"
        if block_used < b["block"]:
            return "block"
        if global_used < b["global"]:
            return "global"
        return None
    if current == "block":
        if block_used < b["block"]:
            return "block"
        if global_used < b["global"]:
            return "global"
        return None
    # current == "global"
    if global_used < b["global"]:
        return "global"
    return None


# ---------------------------------------------------------------------------
# Visual failure routing (inspect_video)
# ---------------------------------------------------------------------------

# Strategy-level failures: the visual approach is fundamentally wrong, so
# block-scope patches just shuffle deck chairs. Need a fresh take (global)
# and likely a visual_plan replan.
_STRATEGY_BLACKLIST = (
    "ppt 翻页",
    "公式墙",
    "文字搬运",
    "抽象越级",
    "静态幻灯片",  # entire video is essentially static — deep approach issue
)

# Layout/style failures: the approach is OK but specific placement / colors /
# spacing need adjusting. block-scope can fix these surgically.
_LAYOUT_KEYWORDS = (
    "重叠", "overlap", "裁切", "出界", "off-screen", "遮挡", "相交",
    "anchor", "位置", "区域",
    "对比", "颜色", "color",
    "节奏", "时长", "wait",
    "可读", "字号", "太小", "太大",
)


def classify_visual_failure(
    payload: dict | None, error_text: str = ""
) -> Scope:
    """Route an inspect_video failure to the right fix scope.

    Decision tree:
      1. B6 = 0 (essence not delivered) ⇒ "global"
         The video totally missed the point of the rationale; need rewrite.
      2. Strategy blacklist hit (PPT 翻页 / 公式墙 / 文字搬运 / 抽象越级
         / 静态幻灯片) ⇒ "global"
         Fundamental visual approach is wrong.
      3. Layout/style keywords in issues (重叠 / 颜色 / 位置 / 节奏)
         ⇒ "block"
         Specific placement issues — can be patched in one Phase.
      4. B 段 total < 5 (very low across many dimensions) ⇒ "global"
         Multiple things wrong simultaneously, full rewrite is cleaner.
      5. Otherwise ⇒ "block"
         Conservative middle: try a block fix first; ScopeRefine escalates
         if that doesn't work.
    """
    payload = payload or {}
    err = (error_text or "").lower()

    # 1) B6 = 0 forces global — essence not delivered, this is a planning
    # failure not a code bug.
    b_scores = payload.get("b_scores") or {}
    if b_scores.get("b6") == 0:
        return "global"

    # 2) Strategy-level blacklist hits
    blacklist = payload.get("blacklist_hits") or []
    if isinstance(blacklist, list):
        bl_lower = " ".join(str(x).lower() for x in blacklist)
        if any(s in bl_lower for s in _STRATEGY_BLACKLIST):
            return "global"
    elif isinstance(blacklist, str):
        if any(s in blacklist.lower() for s in _STRATEGY_BLACKLIST):
            return "global"

    # 3) Layout/style: look in issues + the error_text for layout keywords
    issues = payload.get("issues") or []
    issues_text = " ".join(str(x) for x in issues if x).lower() + " " + err
    layout_hits = sum(1 for kw in _LAYOUT_KEYWORDS if kw in issues_text)
    strategy_hits = sum(1 for s in _STRATEGY_BLACKLIST if s in issues_text)

    if layout_hits >= 1 and strategy_hits == 0:
        return "block"

    # 4) Very low total → multi-dimensional failure → global
    try:
        b_total_raw = payload.get("b_total")
        b_total = (
            int(str(b_total_raw).split("/")[0])
            if b_total_raw not in (None, "")
            else None
        )
    except (ValueError, TypeError):
        b_total = None
    if b_total is not None and b_total < 5:
        return "global"

    # 5) Default to block (conservative: try local first, escalate if fail)
    return "block"
