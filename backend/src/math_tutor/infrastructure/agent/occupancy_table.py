"""Occupancy Table — explicit screen-region accounting borrowed from Code2Video.

Manim's canvas is x ∈ [-7, 7], y ∈ [-4, 4]. We discretize it into a
**6 × 6 grid** with cells named A1 … F6:

       Col:   A     B     C     D     E     F
       x ≈ -5.83 -3.50 -1.17  1.17  3.50  5.83
  Row 1: y= 3.33   ┌───┬───┬───┬───┬───┬───┐  TOP
  Row 2: y= 2.00   │A1 │B1 │C1 │D1 │E1 │F1 │
  Row 3: y= 0.67   │A2 │B2 │C2 │D2 │E2 │F2 │
  Row 4: y=-0.67   │A3 │B3 │C3 │D3 │E3 │F3 │
  Row 5: y=-2.00   │A4 │B4 │C4 │D4 │E4 │F4 │
  Row 6: y=-3.33   │A5 │B5 │C5 │D5 │E5 │F5 │
                   └A6─B6─C6─D6─E6─F6─────┘  BOTTOM

A *zone* is "A1-F1" (a rectangle from one anchor to another, inclusive).
visual_plan declares each scene's `anchor_zone`; the generated Manim code
must place that scene's elements inside the zone. `parse_placements_from_code`
extracts (element_var, x, y) tuples from the code and `detect_*` functions
flag violations.

This is intentionally heuristic — we statically scan for `.move_to([x,y,0])`
and `.to_edge(UP)` patterns. We won't catch every case (e.g. dynamic
positions inside a `for`), but we catch the most common manual placements
which is what causes most overlaps.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Iterable

logger = logging.getLogger(__name__)

# Manim canvas extents
X_MIN, X_MAX = -7.0, 7.0
Y_MIN, Y_MAX = -4.0, 4.0

GRID_COLS = 6  # A-F
GRID_ROWS = 6  # 1-6
COL_WIDTH = (X_MAX - X_MIN) / GRID_COLS  # 2.333
ROW_HEIGHT = (Y_MAX - Y_MIN) / GRID_ROWS  # 1.333


@dataclass
class Anchor:
    col: str   # 'A'..'F'
    row: int   # 1..6

    @property
    def label(self) -> str:
        return f"{self.col}{self.row}"

    @property
    def x(self) -> float:
        col_idx = ord(self.col) - ord("A")
        return X_MIN + COL_WIDTH * (col_idx + 0.5)

    @property
    def y(self) -> float:
        # Row 1 is top (high y), row 6 is bottom
        return Y_MAX - ROW_HEIGHT * (self.row - 0.5)


@dataclass
class Zone:
    """An inclusive rectangle of anchors. e.g. parse_zone("B3-E5")."""

    top_left: Anchor
    bottom_right: Anchor

    def contains_anchor(self, a: Anchor) -> bool:
        col_lo = ord(self.top_left.col) - ord("A")
        col_hi = ord(self.bottom_right.col) - ord("A")
        return (
            col_lo <= ord(a.col) - ord("A") <= col_hi
            and self.top_left.row <= a.row <= self.bottom_right.row
        )

    def contains_xy(self, x: float, y: float) -> bool:
        # Convert to anchor and check containment
        return self.contains_anchor(xy_to_anchor(x, y))

    def anchors(self) -> list[Anchor]:
        col_lo = ord(self.top_left.col) - ord("A")
        col_hi = ord(self.bottom_right.col) - ord("A")
        out: list[Anchor] = []
        for c in range(col_lo, col_hi + 1):
            for r in range(self.top_left.row, self.bottom_right.row + 1):
                out.append(Anchor(col=chr(ord("A") + c), row=r))
        return out

    @property
    def label(self) -> str:
        return f"{self.top_left.label}-{self.bottom_right.label}"


@dataclass
class Placement:
    """An element placed at an inferred (x, y). Source line for debugging."""

    var: str
    x: float
    y: float
    line_no: int
    method: str  # "move_to" / "to_edge" / "next_to" / "arrange" / "edge"
    raw: str = ""

    @property
    def anchor(self) -> Anchor:
        return xy_to_anchor(self.x, self.y)


# ---------------------------------------------------------------------------
# Anchor / zone parsing
# ---------------------------------------------------------------------------


_ANCHOR_RE = re.compile(r"^\s*([A-Fa-f])\s*([1-6])\s*$")
_ZONE_RE = re.compile(r"^\s*([A-Fa-f])([1-6])\s*[-–—~～to至]+\s*([A-Fa-f])([1-6])\s*$")


def parse_anchor(label: str) -> Anchor | None:
    if not label:
        return None
    m = _ANCHOR_RE.match(label.strip())
    if not m:
        return None
    return Anchor(col=m.group(1).upper(), row=int(m.group(2)))


def parse_zone(label: str) -> Zone | None:
    """Accept 'B3-E5' / 'b3-e5' / 'A1' (single anchor → 1×1 zone)."""
    if not label:
        return None
    txt = label.strip()
    # Single anchor degrades to a 1×1 zone
    single = parse_anchor(txt)
    if single is not None:
        return Zone(top_left=single, bottom_right=single)
    m = _ZONE_RE.match(txt)
    if not m:
        return None
    a = Anchor(col=m.group(1).upper(), row=int(m.group(2)))
    b = Anchor(col=m.group(3).upper(), row=int(m.group(4)))
    # Normalize so a is top-left, b is bottom-right
    col_a = ord(a.col)
    col_b = ord(b.col)
    if col_a > col_b:
        a, b = Anchor(col=b.col, row=a.row), Anchor(col=a.col, row=b.row)
    if a.row > b.row:
        a, b = Anchor(col=a.col, row=b.row), Anchor(col=b.col, row=a.row)
    return Zone(top_left=a, bottom_right=b)


def anchor_to_xy(label: str) -> tuple[float, float] | None:
    a = parse_anchor(label)
    return (a.x, a.y) if a else None


def xy_to_anchor(x: float, y: float) -> Anchor:
    """Snap a Manim (x, y) to the nearest 6×6 anchor cell."""
    col_idx = int((x - X_MIN) / COL_WIDTH)
    col_idx = max(0, min(GRID_COLS - 1, col_idx))
    # Row 1 is top (high y); compute distance from top
    row_idx = int((Y_MAX - y) / ROW_HEIGHT) + 1
    row_idx = max(1, min(GRID_ROWS, row_idx))
    return Anchor(col=chr(ord("A") + col_idx), row=row_idx)


# ---------------------------------------------------------------------------
# Static placement extraction from Manim code
# ---------------------------------------------------------------------------


# Targets a single line that places one variable. Forms supported:
#   var.move_to(np.array([x, y, 0]))
#   var.move_to([x, y, 0])
#   var.move_to((x, y, 0))
#   var.move_to(ORIGIN)               -> (0, 0)
#   var.move_to(UP * 2)               -> (0, 2)
#   var.move_to(LEFT * 3 + UP * 1)    -> (-3, 1)
#   var.to_edge(UP, buff=0.5)         -> (0,  ~3.5)
#   var.to_edge(DOWN)                 -> (0, ~-3.5)

_VAR_DOT_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?)\.(move_to|to_edge|next_to|to_corner)\s*\((.*?)\)\s*$"
)
_VAR_ASSIGN_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*.+?\.(?:move_to|to_edge|next_to|to_corner)\s*\((.*?)\)"
)


_DIRECTION_VEC = {
    "ORIGIN": (0.0, 0.0),
    "UP": (0.0, 1.0),
    "DOWN": (0.0, -1.0),
    "LEFT": (-1.0, 0.0),
    "RIGHT": (1.0, 0.0),
    "UL": (-1.0, 1.0),
    "UR": (1.0, 1.0),
    "DL": (-1.0, -1.0),
    "DR": (1.0, -1.0),
    "UPLEFT": (-1.0, 1.0),
    "UPRIGHT": (1.0, 1.0),
    "DOWNLEFT": (-1.0, -1.0),
    "DOWNRIGHT": (1.0, -1.0),
}


def _eval_direction_expr(expr: str) -> tuple[float, float] | None:
    """Best-effort evaluation of `LEFT * 3 + UP * 1` style arg.
    Returns (x, y) or None."""
    expr = expr.strip()
    if not expr:
        return None

    # Drop trailing args like ", buff=..."  — only the first positional matters
    # Nope: callers pass us only the first positional. Just be defensive.
    expr = expr.split(",")[0].strip()

    if expr in _DIRECTION_VEC:
        return _DIRECTION_VEC[expr]

    # ORIGIN / UP * 2 / LEFT * 3 + UP * 1
    parts = re.split(r"\s*\+\s*", expr)
    x_total = 0.0
    y_total = 0.0
    matched_any = False
    for p in parts:
        sign = 1
        p = p.strip()
        if p.startswith("-"):
            sign = -1
            p = p[1:].strip()
        m = re.match(
            r"^([A-Z]+)\s*(?:\*\s*([0-9.+-]+))?\s*$", p
        )
        if not m:
            continue
        direction = m.group(1)
        scalar = float(m.group(2)) if m.group(2) else 1.0
        vec = _DIRECTION_VEC.get(direction)
        if vec is None:
            continue
        x_total += sign * scalar * vec[0]
        y_total += sign * scalar * vec[1]
        matched_any = True

    if matched_any:
        return (x_total, y_total)

    # np.array([x, y, 0]) or [x, y, 0] or (x, y, 0)
    nm = re.search(r"\[\s*([\-\d.eE+]+)\s*,\s*([\-\d.eE+]+)\s*,\s*([\-\d.eE+]+)\s*\]", expr)
    if nm is None:
        nm = re.search(r"\(\s*([\-\d.eE+]+)\s*,\s*([\-\d.eE+]+)\s*,\s*([\-\d.eE+]+)\s*\)", expr)
    if nm is not None:
        try:
            return float(nm.group(1)), float(nm.group(2))
        except ValueError:
            return None

    return None


def _to_edge_xy(direction: str, buff: float = 0.5) -> tuple[float, float]:
    """to_edge maps to roughly the canvas edge minus buff."""
    if direction == "UP":
        return (0.0, Y_MAX - buff)
    if direction == "DOWN":
        return (0.0, Y_MIN + buff)
    if direction == "LEFT":
        return (X_MIN + buff, 0.0)
    if direction == "RIGHT":
        return (X_MAX - buff, 0.0)
    return (0.0, 0.0)


def _to_corner_xy(direction: str, buff: float = 0.5) -> tuple[float, float]:
    """to_corner: UR / UL / DR / DL."""
    vec = _DIRECTION_VEC.get(direction, (0.0, 0.0))
    return (vec[0] * (X_MAX - buff), vec[1] * (Y_MAX - buff))


def parse_placements_from_code(code: str) -> list[Placement]:
    """Static, line-by-line scan for placements. Heuristic — designed to
    catch the obvious manual `.move_to(...)` / `.to_edge(...)` cases."""
    placements: list[Placement] = []
    if not code:
        return placements

    for i, raw in enumerate(code.split("\n"), start=1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        m = _VAR_DOT_RE.match(line)
        if not m:
            continue
        var, method, arg = m.group(1), m.group(2), m.group(3)

        xy: tuple[float, float] | None = None
        if method == "move_to":
            xy = _eval_direction_expr(arg)
        elif method == "to_edge":
            # First positional arg is the direction
            direction = arg.split(",")[0].strip()
            buff_match = re.search(r"buff\s*=\s*([\-\d.eE+]+)", arg)
            buff = float(buff_match.group(1)) if buff_match else 0.5
            if direction in {"UP", "DOWN", "LEFT", "RIGHT"}:
                xy = _to_edge_xy(direction, buff)
        elif method == "to_corner":
            direction = arg.split(",")[0].strip()
            buff_match = re.search(r"buff\s*=\s*([\-\d.eE+]+)", arg)
            buff = float(buff_match.group(1)) if buff_match else 0.5
            xy = _to_corner_xy(direction, buff)
        elif method == "next_to":
            # Skip — depends on the *other* element's position; static
            # analysis can't resolve cheaply.
            continue

        if xy is None:
            continue
        placements.append(
            Placement(
                var=var,
                x=xy[0],
                y=xy[1],
                line_no=i,
                method=method,
                raw=line,
            )
        )

    return placements


# ---------------------------------------------------------------------------
# Overlap / zone-violation detection
# ---------------------------------------------------------------------------


def detect_overlap(placements: Iterable[Placement]) -> list[str]:
    """Group placements by anchor cell. Cells with ≥ 3 distinct vars are
    flagged (≥3 because 2 elements often legitimately stack — a label
    next_to its parent, etc., even though we don't see those statically)."""
    by_cell: dict[str, list[Placement]] = {}
    for p in placements:
        by_cell.setdefault(p.anchor.label, []).append(p)

    issues: list[str] = []
    for cell, plist in by_cell.items():
        unique_vars = {p.var for p in plist}
        if len(unique_vars) >= 3:
            sample = ", ".join(sorted(unique_vars)[:4])
            issues.append(
                f"重叠风险：anchor {cell} 至少 {len(unique_vars)} 个元素 "
                f"({sample})；建议把这些元素分散到不同 anchor"
            )
    return issues


def detect_zone_violation(
    placements: Iterable[Placement],
    *,
    declared_zones: dict[str, Zone],
) -> list[str]:
    """Check that elements stay within their *declared* zone. `declared_zones`
    is `{var_name_pattern: Zone}` — pattern can be a regex prefix matching
    the var. Unmatched vars are skipped (we don't punish vars that visual_plan
    didn't mention)."""
    issues: list[str] = []
    for p in placements:
        zone = _match_zone_for_var(p.var, declared_zones)
        if zone is None:
            continue
        if not zone.contains_xy(p.x, p.y):
            issues.append(
                f"元素 {p.var} (line {p.line_no}) 落在 anchor {p.anchor.label}, "
                f"但应在 zone {zone.label} 内"
            )
    return issues


def _match_zone_for_var(var: str, zones: dict[str, Zone]) -> Zone | None:
    if var in zones:
        return zones[var]
    # Try prefix match (e.g. "title_1" matches "title")
    for k, z in zones.items():
        if var.startswith(k):
            return z
    return None


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def build_occupancy_report(placements: Iterable[Placement]) -> dict:
    by_cell: dict[str, list[str]] = {}
    for p in placements:
        by_cell.setdefault(p.anchor.label, []).append(p.var)
    return {
        "total_placements": sum(1 for _ in placements) if isinstance(placements, list) else None,
        "cells": {k: sorted(set(v)) for k, v in by_cell.items()},
    }
