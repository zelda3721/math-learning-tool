#!/usr/bin/env python3
"""GPU 视频产能实测（设计 §09 P0 验收项）。

测量单条讲解视频的端到端耗时与一夜产能上限，所有延迟相关的产品承诺
（夜间预生成、错题一键视频）以本报告的实测数据为准（设计 §08 R4）。

前置条件：
  1. LMStudio（或其他 OpenAI 兼容端点）已启动并加载模型
  2. 引擎已启动：cd services/video-engine && .venv/bin/python -m math_tutor.api.main

用法：
  services/video-engine/.venv/bin/python scripts/bench_video_throughput.py \
      [--base-url http://localhost:8000] [--runs 3] [--night-hours 8]

输出：逐条耗时 + 汇总（中位数、估算一夜产能），并写 data/bench/throughput-<n>.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# 覆盖三个年级段的代表性题目（与引擎示例题风格一致）
DEFAULT_PROBLEMS: list[dict[str, str]] = [
    {"problem": "小明有 12 颗糖，分给 3 个小朋友，每人分得同样多，每人分到几颗？", "grade": "elementary_lower"},
    {"problem": "鸡兔同笼，共有 8 个头，22 只脚，鸡和兔各有几只？", "grade": "elementary_upper"},
    {"problem": "解方程：2x + 3 = 11", "grade": "middle"},
]


def post_json(url: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_up(base_url: str) -> None:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as exc:
        print(f"[fatal] 引擎不可达（{base_url}）：{exc}")
        print("请先启动引擎与 LMStudio，再运行本脚本（见文件头注释）。")
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="MathTutor 视频产能实测")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--runs", type=int, default=3, help="跑几条题（循环使用默认题组）")
    parser.add_argument("--night-hours", type=float, default=8.0, help="估算夜间时长（小时）")
    parser.add_argument("--timeout", type=float, default=3600.0, help="单条超时（秒）")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    check_up(base_url)

    results: list[dict] = []
    for i in range(args.runs):
        case = DEFAULT_PROBLEMS[i % len(DEFAULT_PROBLEMS)]
        print(f"[{i + 1}/{args.runs}] {case['grade']}: {case['problem'][:30]}…")
        t0 = time.monotonic()
        try:
            resp = post_json(f"{base_url}/api/v1/problems/process", case, args.timeout)
            elapsed = time.monotonic() - t0
            ok = resp.get("status") in ("ok", "success", "completed") or bool(resp.get("video_url"))
            results.append({
                "problem": case["problem"],
                "grade": case["grade"],
                "elapsed_s": round(elapsed, 1),
                "status": resp.get("status"),
                "session_id": resp.get("session_id"),
                "ok": ok,
            })
            print(f"    → {resp.get('status')} 用时 {elapsed:.0f}s")
        except Exception as exc:  # noqa: BLE001 — 基准脚本记录一切失败
            elapsed = time.monotonic() - t0
            results.append({
                "problem": case["problem"],
                "grade": case["grade"],
                "elapsed_s": round(elapsed, 1),
                "status": f"error: {exc}",
                "ok": False,
            })
            print(f"    → 失败（{elapsed:.0f}s）：{exc}")

    ok_times = [r["elapsed_s"] for r in results if r["ok"]]
    summary = {
        "runs": len(results),
        "succeeded": len(ok_times),
        "median_s": round(statistics.median(ok_times), 1) if ok_times else None,
        "mean_s": round(statistics.mean(ok_times), 1) if ok_times else None,
        "max_s": max(ok_times) if ok_times else None,
        "est_videos_per_night": (
            int(args.night_hours * 3600 / statistics.median(ok_times)) if ok_times else 0
        ),
        "night_hours": args.night_hours,
    }

    out_dir = Path(__file__).resolve().parent.parent / "data" / "bench"
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("throughput-*.json"))
    out_path = out_dir / f"throughput-{len(existing) + 1:03d}.json"
    out_path.write_text(
        json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n===== 产能报告 =====")
    print(f"成功 {summary['succeeded']}/{summary['runs']}，中位耗时 {summary['median_s']}s，最长 {summary['max_s']}s")
    print(f"估算一夜（{args.night_hours:.0f}h）产能：约 {summary['est_videos_per_night']} 条")
    print(f"已写入 {out_path}")


if __name__ == "__main__":
    main()
