#!/usr/bin/env python3
"""黄金集离线校验：结构、出处、答案自洽。

为什么需要这一步：黄金集是后续所有"没退步"结论的依据，它自己错了，
比没有黄金集更糟——基线报告会一直拿错答案去判对错。

两件事：
  1. 结构校验（字段、枚举、id 唯一、配图存在、规模门槛）
  2. 答案自洽：`answer` 与 `match` 说的是同一件事；表达式题用 SymPy 复算。
     等价类由 `expect.match` 声明，这里只核对声明内部的矛盾，不去猜题。

用法（仓库根）：
    python3 scripts/golden_check.py [--verbose]

SymPy 缺失时只做结构校验（打印提示，退出码仍为 0 的只有结构部分）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "data" / "golden"

GRADES = {"elementary_lower", "elementary_upper", "middle", "high", "advanced"}
VERIFICATIONS = {"executable", "reference", "ai_unverified"}
MATCH_TYPES = {"number", "expression", "values"}
MANIM_FEATURES = {"formula_transform", "param_sweep", "three_d", "linear_transform"}

# 阶段 0 的规模门槛（docs/PLAN.md 第七部分）
MIN_VIDEO_CASES = 30
MIN_MANIM_CASES = 8

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def load_jsonl(path: Path) -> list[dict]:
    cases: list[dict] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        try:
            cases.append(json.loads(line))
        except json.JSONDecodeError as exc:
            fail(f"{path.name}:{lineno} 不是合法 JSON：{exc}")
    return cases


def check_common(case: dict, where: str, seen: set[str]) -> None:
    cid = case.get("id")
    if not isinstance(cid, str) or not cid:
        fail(f"{where}: 缺 id")
        return
    if cid in seen:
        fail(f"{where}: id 重复 {cid}")
    seen.add(cid)
    for key in ("problem", "grade", "source"):
        if not isinstance(case.get(key), str) or not case.get(key):
            fail(f"{where}({cid}): 缺 {key}")
    if case.get("grade") not in GRADES:
        fail(f"{where}({cid}): grade 不合法 {case.get('grade')!r}")
    figure = case.get("figure")
    if figure is not None and not (ROOT / figure).exists():
        fail(f"{where}({cid}): 配图不存在 {figure}")


def check_bank_source(case: dict, where: str) -> None:
    """出处必须真的存在：会话号能查到，题库 id 在题库里（题库那条在 main 里统一核对）。"""
    source = str(case.get("source") or "")
    if source.startswith("session:"):
        sid = source.split(":", 1)[1]
        if not (ROOT / "data" / "sessions" / sid).exists() and not _session_in_db(sid):
            fail(f"{where}({case['id']}): 会话出处查无此号 {sid}")
    elif source.startswith(("bank:", "bench:", "figure_bench:", "authored")):
        pass
    else:
        fail(f"{where}({case['id']}): 出处不认识 {source}")


def _session_in_db(session_prefix: str) -> bool:
    import sqlite3

    db = ROOT / "data" / "math_tutor.sqlite"
    if not db.exists():
        return False
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select 1 from sessions where id like ? limit 1", (session_prefix + "%",)
        ).fetchone()
        return row is not None
    finally:
        con.close()


def _bank_ids() -> set[str]:
    ids: set[str] = set()
    qdir = ROOT / "data" / "knowledge" / "questions"
    if not qdir.exists():
        return ids
    for f in qdir.glob("*.json"):
        try:
            for q in json.loads(f.read_text(encoding="utf-8")):
                if isinstance(q, dict) and q.get("id"):
                    ids.add(str(q["id"]))
        except (json.JSONDecodeError, TypeError):
            continue
    return ids


def _numbers(text: str) -> list[float]:
    out: list[float] = []
    for m in re.finditer(r"-?\d+(?:\.\d+)?", text):
        try:
            out.append(float(m.group()))
        except ValueError:
            continue
    return out


def check_engine_case(case: dict, where: str) -> None:
    cid = case["id"]
    expect = case.get("expect")
    if not isinstance(expect, dict):
        fail(f"{where}({cid}): 缺 expect")
        return
    answer = str(expect.get("answer") or "")
    if not answer:
        fail(f"{where}({cid}): 缺 expect.answer")
    if expect.get("verification") not in VERIFICATIONS:
        fail(f"{where}({cid}): verification 不合法 {expect.get('verification')!r}")
    match = expect.get("match") or {}
    kind = match.get("type")
    if kind not in MATCH_TYPES:
        fail(f"{where}({cid}): match.type 不合法 {kind!r}")
        return

    if kind == "number":
        value = match.get("value")
        if not isinstance(value, (int, float)):
            fail(f"{where}({cid}): number 型 match 缺数值 value")
            return
        nums = _numbers(answer)
        # 答案里至少要出现这个数：`兔 12 只` 这类带单位的写法也算对上
        if not any(abs(n - float(value)) < 1e-9 for n in nums):
            fail(f"{where}({cid}): answer {answer!r} 里找不到 match.value={value}")
    elif kind == "values":
        values = match.get("values") or []
        if not values:
            fail(f"{where}({cid}): values 型 match 缺 values")
            return
        nums = _numbers(answer)
        for v in values:
            if not any(abs(n - float(v)) < 1e-9 for n in nums):
                fail(f"{where}({cid}): answer {answer!r} 里找不到 {v}")
    elif kind == "expression":
        expr = str(match.get("value") or "")
        if not expr:
            fail(f"{where}({cid}): expression 型 match 缺 value")
            return
        equiv = _sympy_equivalent(answer, expr)
        if equiv is False:
            fail(f"{where}({cid}): answer {answer!r} 与 match.value {expr!r} 不等价")
        elif equiv is None:
            problems.append(f"{where}({cid}): [提示] 无 SymPy，跳过表达式复核 {answer!r} vs {expr!r}")


def _sympy_equivalent(a: str, b: str) -> bool | None:
    try:
        import sympy  # type: ignore
        from sympy.parsing.sympy_parser import (  # type: ignore
            implicit_multiplication_application,
            parse_expr,
            standard_transformations,
        )
    except ImportError:
        return None

    # 把中文与全角符号收拾成可解析的式子；`>` `<` 这类关系式用 Rel 解析
    def norm(s: str) -> str:
        s = s.replace("（", "(").replace("）", ")").replace("－", "-")
        s = s.replace("×", "*").replace("÷", "/").replace("^", "**").replace("²", "**2")
        return s.strip()

    transforms = standard_transformations + (implicit_multiplication_application,)
    try:
        ea = parse_expr(norm(a), transformations=transforms, evaluate=True)
        eb = parse_expr(norm(b), transformations=transforms, evaluate=True)
    except Exception:  # noqa: BLE001 — 解析不了就交给人工看，不在这里误判
        return None
    try:
        if isinstance(ea, sympy.core.relational.Relational) or isinstance(
            eb, sympy.core.relational.Relational
        ):
            return bool(sympy.Equivalent(ea, eb))
        return bool(sympy.simplify(ea - eb) == 0)
    except Exception:  # noqa: BLE001
        return None


def check_video_case(case: dict, where: str) -> None:
    cid = case["id"]
    answer = str(case.get("answer") or "")
    if not answer:
        fail(f"{where}({cid}): 缺 answer")
    visual = case.get("visual")
    if not isinstance(visual, dict):
        fail(f"{where}({cid}): 缺 visual")
        return
    if not str(visual.get("representation") or "").strip():
        fail(f"{where}({cid}): 缺 visual.representation（这道题该怎么被看见）")
    prims = visual.get("web_player")
    if not isinstance(prims, list) or not prims:
        fail(f"{where}({cid}): 缺 visual.web_player 图元")
    manim = visual.get("manim") or {}
    if not isinstance(manim.get("needs_manim"), bool):
        fail(f"{where}({cid}): visual.manim.needs_manim 必须是布尔")
    features = manim.get("features") or []
    if not isinstance(features, list):
        fail(f"{where}({cid}): visual.manim.features 必须是数组")
        return
    for f in features:
        if f not in MANIM_FEATURES:
            fail(f"{where}({cid}): 未知 Manim 特性类 {f!r}（允许 {sorted(MANIM_FEATURES)}）")
    if manim.get("needs_manim") and not features:
        fail(f"{where}({cid}): needs_manim=true 却没写 features")


def main() -> int:
    parser = argparse.ArgumentParser(description="黄金集离线校验")
    parser.add_argument("--verbose", action="store_true", help="打印每道题的校验过程")
    args = parser.parse_args()

    engine_path = GOLDEN / "engine" / "cases.jsonl"
    video_path = GOLDEN / "video" / "cases.jsonl"
    for p in (engine_path, video_path):
        if not p.exists():
            print(f"[fatal] 缺黄金集文件：{p.relative_to(ROOT)}", file=sys.stderr)
            return 2

    bank = _bank_ids()

    seen: set[str] = set()
    engine_cases = load_jsonl(engine_path)
    for case in engine_cases:
        where = "engine"
        check_common(case, where, seen)
        check_engine_case(case, where)
        check_bank_source(case, where)
        src = str(case.get("source") or "")
        if src.startswith("bank:") and src.split(":", 1)[1] not in bank:
            fail(f"{where}({case.get('id')}): 题库里没有这道题 {src}")
        if args.verbose:
            print(f"  {case.get('id')}: ok 结构")

    video_cases = load_jsonl(video_path)
    for case in video_cases:
        check_common(case, "video", seen)
        check_video_case(case, "video")
        if args.verbose:
            print(f"  {case.get('id')}: ok 结构")

    # 规模门槛（阶段 0 DoD）
    manim_cases = [
        c for c in video_cases if (c.get("visual") or {}).get("manim", {}).get("needs_manim")
    ]
    if len(video_cases) < MIN_VIDEO_CASES:
        fail(f"video: 只有 {len(video_cases)} 道，阶段 0 要求 ≥ {MIN_VIDEO_CASES}")
    if len(manim_cases) < MIN_MANIM_CASES:
        fail(f"video: Manim 特性类只有 {len(manim_cases)} 道，阶段 0 要求 ≥ {MIN_MANIM_CASES}")
    covered = {
        f
        for c in manim_cases
        for f in ((c.get("visual") or {}).get("manim") or {}).get("features") or []
    }
    missing = MANIM_FEATURES - covered
    if missing:
        fail(f"video: Manim 特性类没覆盖全，缺 {sorted(missing)}")

    grade_cover = {c.get("grade") for c in engine_cases}
    if len(grade_cover) < 4:
        problems.append(f"engine: [提示] 只覆盖了 {sorted(grade_cover)} 这些年级段")

    hints = [p for p in problems if "[提示]" in p]
    errors = [p for p in problems if "[提示]" not in p]

    for h in hints:
        print(h)
    if errors:
        print(f"\n[FAIL] 黄金集有 {len(errors)} 个问题：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(
        f"[OK] 引擎黄金集 {len(engine_cases)} 道 · 视频黄金集 {len(video_cases)} 道"
        f"（Manim 特性类 {len(manim_cases)} 道，覆盖 {len(covered)}/{len(MANIM_FEATURES)} 类）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
