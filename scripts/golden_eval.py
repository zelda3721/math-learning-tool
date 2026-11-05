#!/usr/bin/env python3
"""黄金集基线：对活引擎跑一遍，落一份可对比的报告。

这是 docs/PLAN.md 阶段 0 的"基线入库"——之后换模型（oMLX）、改提示词、加确定性构造器，
都重跑同一份黄金集，两份报告并排就是全部论据。

两组跑的端点不同，因为要验的东西不同：
  --set engine  POST /api/v1/chat（SSE，五阶段全链路）→ 答案对不对、门禁过不过、耗时
  --set video   POST /api/v1/plan（Solve→Verify→Direct，不渲染）→ 讲解计划有没有画对样子、
                是不是确定性构造器出的、用到了期望的图元

前置：引擎与本地模型都已启动。引擎不可达时直接退出（基线不能凭空造）。

用法（仓库根）：
    python3 scripts/golden_eval.py --set engine
    python3 scripts/golden_eval.py --set video --limit 5
    python3 scripts/golden_eval.py --only eng-006,eng-010 --label "oMLX qwen3.8"

输出：data/bench/golden-<set>-<日期>-<时分>.json（汇总）
      同目录 *-partial.jsonl（逐题一行，边跑边写，中断也不丢）
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "data" / "golden"
BENCH = ROOT / "data" / "bench"

# 只打本机引擎：系统代理会把 127.0.0.1 也送进代理
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ── 取数与比对 ────────────────────────────────────────────────────────────


def read_cases(set_name: str) -> list[dict]:
    path = GOLDEN / set_name / "cases.jsonl"
    if not path.exists():
        sys.exit(f"[fatal] 找不到黄金集：{path.relative_to(ROOT)}")
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _data_url(path: Path) -> str:
    suffix = path.suffix.lower().lstrip(".")
    mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix}"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def request_body(case: dict) -> dict:
    body: dict = {"problem": case["problem"], "grade": case["grade"]}
    fig = case.get("figure")
    if fig:
        p = ROOT / fig
        if p.exists():
            # 带图题两个字段都给：figure_image 是题干配图，problem_image 是整题照片。
            # 黄金集只有一张图时，把它当配图用（导演按它重画）。
            body["figure_image"] = _data_url(p)
    return body


def numbers_in(text: str) -> list[float]:
    import re

    out: list[float] = []
    for m in re.finditer(r"-?\d+(?:\.\d+)?", _strip_latex(text or "")):
        try:
            out.append(float(m.group()))
        except ValueError:
            continue
    return out


def _strip_latex(text: str) -> str:
    """
    引擎的答案常带 LaTeX（`$\\frac{1}{2}$`、`$3x^2$`）——那是**同一个答案的另一种写法**，
    不是错。不认它会把对的判成错的，而这种假阴性会让基线准确率系统性偏低，
    比漏判更糟：你会照着错的数字去换模型。

    只做规范化，不做数学化简（那交给 SymPy）。
    """
    import re

    s = text or ""
    s = re.sub(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", s)
    s = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"sqrt(\1)", s)
    s = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\\(cdot|times)", "*", s)
    s = re.sub(r"\\left|\\right", "", s)
    s = re.sub(r"\\[,;:! ]", " ", s)
    s = s.replace("$", "").replace("²", "**2").replace("³", "**3")
    s = s.replace("×", "*").replace("÷", "/").replace("－", "-")
    s = re.sub(r"\^\{([^{}]*)\}", r"**(\1)", s)  # 先收拾 ^{\cdots}，再处理裸 ^
    s = re.sub(r"\^(?!\*)", "**", s)
    return s.strip()


def judge_answer(answer: str, match: dict) -> bool:
    """按黄金集声明的规则判分。判不准时返回 False，由人看报告复核。"""
    kind = (match or {}).get("type")
    nums = numbers_in(answer or "")
    if kind == "number":
        target = float(match["value"])
        return any(abs(n - target) <= max(1e-6, abs(target) * 1e-6) for n in nums)
    if kind == "values":
        return all(
            any(abs(n - float(v)) <= max(1e-6, abs(float(v)) * 1e-6) for n in nums)
            for v in match.get("values") or []
        )
    if kind == "expression":
        return _expr_equal(answer, str(match.get("value") or ""))
    return False


def _expr_equal(answer: str, target: str) -> bool:
    try:
        import sympy
        from sympy.parsing.sympy_parser import (
            implicit_multiplication_application,
            parse_expr,
            standard_transformations,
        )
    except ImportError:
        return (answer or "").replace(" ", "") == target.replace(" ", "")

    def norm(s: str) -> str:
        # LaTeX 与全角符号先规范化，再做符号等价判定
        return _strip_latex(s).replace(" ", "")

    transforms = standard_transformations + (implicit_multiplication_application,)
    try:
        a = parse_expr(norm(answer), transformations=transforms, evaluate=True)
        b = parse_expr(norm(target), transformations=transforms, evaluate=True)
    except Exception:  # noqa: BLE001
        return norm(answer) == norm(target)
    try:
        if isinstance(a, sympy.core.relational.Relational) or isinstance(
            b, sympy.core.relational.Relational
        ):
            return bool(sympy.Equivalent(a, b))
        return bool(sympy.simplify(a - b) == 0)
    except Exception:  # noqa: BLE001
        return False


# ── 跑单题 ────────────────────────────────────────────────────────────────


def run_chat(base_url: str, case: dict, timeout: float) -> dict:
    """五阶段全链路：收 SSE，攒出各阶段结果。"""
    req = urllib.request.Request(
        f"{base_url}/api/v1/chat",
        json.dumps(request_body(case)).encode("utf-8"),
        {"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    t0 = time.monotonic()
    stages: list[dict] = []
    done: dict = {}
    answer = ""
    event = ""
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    payload = line[5:].strip()
                    if event == "tool_result":
                        d = json.loads(payload)
                        data = d.get("data") or {}
                        stages.append(
                            {
                                "name": d.get("name"),
                                "ok": bool(d.get("success")),
                                "s": round((d.get("duration_ms") or 0) / 1000, 1),
                                "summary": (d.get("summary") or "")[:120],
                            }
                        )
                        if d.get("name") == "solve_problem" and isinstance(data, dict):
                            answer = str(data.get("answer") or answer)
                    elif event == "done":
                        done = json.loads(payload)
                    elif event == "error":
                        done = {"status": "error", "error": json.loads(payload)}
    except Exception as exc:  # noqa: BLE001 — 单题失败不该终止整批
        return {
            "id": case["id"],
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "total_s": round(time.monotonic() - t0, 1),
            "stages": stages,
        }

    total = round(time.monotonic() - t0, 1)
    answer = answer or str(done.get("text") or "")
    expect = case.get("expect") or {}
    watch = next((s for s in stages if s["name"] == "watch_video"), None)
    compiled = next((s for s in stages if s["name"] == "compile_video"), None)
    status = done.get("status")
    return {
        "id": case["id"],
        # 引擎的收尾状态是 "ok"（不是 "done"）；两种历史写法都认，免得把跑完的题记成失败
        "ok": status in ("ok", "done", "success", "completed"),
        "status": status,
        "answer_expected": expect.get("answer"),
        "answer_got": (answer or "")[:200],
        "answer_correct": judge_answer(answer, expect.get("match") or {}),
        "compiled": bool(compiled and compiled["ok"]),
        "gate": (watch or {}).get("summary") if watch else None,
        "total_s": total,
        "stages": stages,
    }


def run_plan(base_url: str, case: dict, timeout: float) -> dict:
    """只跑到 Direct：要的是讲解计划长什么样，不是成片。"""
    req = urllib.request.Request(
        f"{base_url}/api/v1/plan",
        json.dumps(request_body(case)).encode("utf-8"),
        {"Content-Type": "application/json"},
    )
    t0 = time.monotonic()
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {
            "id": case["id"],
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "total_s": round(time.monotonic() - t0, 1),
        }

    total = round(time.monotonic() - t0, 1)
    spec = body.get("scene_spec") or {}
    prims = sorted(
        {
            str(o.get("primitive"))
            for o in (spec.get("objects") or spec.get("visuals") or [])
            if isinstance(o, dict) and o.get("primitive")
        }
    )
    expected_prims = list(((case.get("visual") or {}).get("web_player")) or [])
    source = spec.get("grounding_source") if isinstance(spec, dict) else None
    answer = str(body.get("solution_answer") or "")
    return {
        "id": case["id"],
        "ok": body.get("status") == "ok",
        "status": body.get("status"),
        "error": body.get("error"),
        "answer_expected": case.get("answer"),
        "answer_got": answer[:200],
        "answer_correct": judge_answer(answer, _answer_match(case)),
        "has_spec": bool(spec),
        "grounding_source": source,
        "deterministic": isinstance(source, str) and bool(source),
        "primitives": prims,
        "primitives_expected": expected_prims,
        # 期望图元里实际用到了几个（Host 的图元支持度，不是对错的判据）
        "primitives_hit": len([p for p in expected_prims if p in prims]),
        "verification_untrusted": bool(body.get("verification_untrusted")),
        "total_s": total,
    }


def _answer_match(case: dict) -> dict:
    """视频黄金集只写了人读的 answer；这里按"数值出现"宽松比对。"""
    nums = numbers_in(str(case.get("answer") or ""))
    if len(nums) == 1:
        return {"type": "number", "value": nums[0]}
    if len(nums) > 1:
        return {"type": "values", "values": nums}
    return {"type": "expression", "value": str(case.get("answer") or "")}


def check_up(base_url: str) -> None:
    try:
        with _OPENER.open(f"{base_url}/api/health", timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as exc:
        sys.exit(
            f"[fatal] 引擎不可达（{base_url}）：{exc}\n"
            "先把 LMStudio（或 oMLX）与引擎起起来：\n"
            "  cd services/video-engine && .venv/bin/python -m math_tutor.api.main"
        )


def summarize(set_name: str, rows: list[dict]) -> dict:
    ran = [r for r in rows if "error" not in r]
    times = [r["total_s"] for r in ran if r.get("total_s")]
    out: dict = {
        "cases": len(rows),
        "ran": len(ran),
        "errored": len(rows) - len(ran),
        "answer_correct": sum(1 for r in ran if r.get("answer_correct")),
        "answer_accuracy": round(
            sum(1 for r in ran if r.get("answer_correct")) / len(ran), 3
        ) if ran else None,
        "median_s": round(statistics.median(times), 1) if times else None,
        "p90_s": round(sorted(times)[max(0, int(len(times) * 0.9) - 1)], 1) if times else None,
    }
    if set_name == "engine":
        out["compiled"] = sum(1 for r in ran if r.get("compiled"))
        out["done"] = sum(1 for r in ran if r.get("ok"))
    else:
        out["has_spec"] = sum(1 for r in ran if r.get("has_spec"))
        out["deterministic_lane"] = sum(1 for r in ran if r.get("deterministic"))
        out["verification_untrusted"] = sum(1 for r in ran if r.get("verification_untrusted"))
    return out


def regrade(report_path: Path, set_name: str) -> int:
    """
    用报告里已经记下的原答案重判一遍，**不调引擎**。

    为什么需要这个：判分规则本身会改良（比如开始认 LaTeX），而重跑一遍引擎要几小时。
    改了规则却只能拿旧结论说话，等于逼着人拿假阴性去指责模型。
    """
    report = json.loads(report_path.read_text(encoding="utf-8"))
    cases = {c["id"]: c for c in read_cases(set_name)}
    changed = 0
    rows = []
    for row in report.get("cases") or []:
        case = cases.get(row.get("id"))
        if not case or not row.get("answer_got"):
            rows.append(row)
            continue
        match = (case.get("expect") or {}).get("match") or _answer_match(case)
        new = judge_answer(str(row["answer_got"]), match)
        if new != row.get("answer_correct"):
            changed += 1
            print(
                f"  {row['id']}: {'✗→✓' if new else '✓→✗'}  {str(row['answer_got'])[:44]!r}"
                f"  期望 {case.get('expect', {}).get('answer', case.get('answer'))}"
            )
        rows.append({**row, "answer_correct": new})

    summary = summarize(set_name, rows)
    summary["regraded_from"] = report_path.name
    summary["changed_by_regrade"] = changed
    out = report_path.with_name(report_path.stem + "-regraded.json")
    out.write_text(
        json.dumps({**report, "summary": summary, "cases": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\n" + json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"重判报告：{out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="黄金集基线（对活引擎）")
    parser.add_argument("--set", dest="set_name", choices=["engine", "video"], default="engine")
    parser.add_argument("--base-url", default=os.environ.get("ENGINE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--only", default="", help="只跑这些 id，逗号分隔")
    parser.add_argument("--limit", type=int, default=0, help="只跑前 N 道（冒烟用）")
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--label", default="", help="给这份基线起个名字，例如 'oMLX qwen3.8'")
    parser.add_argument(
        "--regrade",
        default="",
        help="用已有报告里的原答案重判（不调引擎），参数是报告的路径",
    )
    args = parser.parse_args()

    if args.regrade:
        return regrade(Path(args.regrade), args.set_name)

    base_url = args.base_url.rstrip("/")
    cases = read_cases(args.set_name)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        cases = [c for c in cases if c["id"] in wanted]
        if not cases:
            sys.exit("[fatal] --only 没有匹配到任何用例")
    if args.limit:
        cases = cases[: args.limit]

    check_up(base_url)

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    BENCH.mkdir(parents=True, exist_ok=True)
    partial = BENCH / f"golden-{args.set_name}-{stamp}-partial.jsonl"
    runner = run_chat if args.set_name == "engine" else run_plan

    rows: list[dict] = []
    with partial.open("w", encoding="utf-8") as fh:
        for i, case in enumerate(cases, 1):
            print(f"[{i}/{len(cases)}] {case['id']} {case['problem'][:32]}…", flush=True)
            row = runner(base_url, case, args.timeout)
            rows.append(row)
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            mark = "✓" if row.get("answer_correct") else "✗"
            print(
                f"    {mark} 用时 {row.get('total_s')}s 答案={str(row.get('answer_got'))[:40]!r}"
                + (f" 错误={row['error']}" if row.get("error") else ""),
                flush=True,
            )

    summary = summarize(args.set_name, rows)
    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "set": args.set_name,
        "label": args.label,
        "base_url": base_url,
        "summary": summary,
        "cases": rows,
    }
    out = BENCH / f"golden-{args.set_name}-{stamp}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"报告：{out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
