"""阶段重复性基准：同一道带图题多轮全链路，量"good 是巧合还是必然"。

用法（仓库根）：
    python3 scripts/bench_stage_repeatability.py qwen/qwen3.6-27b:3 qwen/qwen3.8-27b:3

每个参数是 模型:轮数。逐模型：重启引擎（环境变量覆盖 LLM_MODEL）→ 顺序跑 N 轮
/api/v1/chat → 每轮把各阶段结果写一行 JSONL 到 data/bench/repeatability-<日期>.jsonl。
温度非零，每轮都是真采样——通过率才是"必然"的度量。串行跑：本地 GPU 只有一份。
"""
from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_DIR = ROOT / "services" / "video-engine"
OUT = ROOT / "data" / "bench" / f"repeatability-{datetime.now().strftime('%Y%m%d-%H%M')}.jsonl"
PROBLEM = "如图所示，长方形ABCD中，其中三个小三角形的面积已经在图中标出，则阴影部分的面积为______．"


def payload() -> bytes:
    fig = (ROOT / "data" / "figure_bench" / "rect-three-triangles.jpg").read_bytes()
    whole = (ROOT / "data" / "photo_samples" / "2026-08-18T00-57-33-634Z-question.jpg").read_bytes()
    return json.dumps({
        "problem": PROBLEM, "grade": "elementary_upper",
        "figure_image": "data:image/jpeg;base64," + base64.b64encode(fig).decode(),
        "problem_image": "data:image/jpeg;base64," + base64.b64encode(whole).decode(),
    }).encode()


def restart_engine(model: str) -> None:
    subprocess.run(["pkill", "-f", "math_tutor.api.main"], check=False)
    time.sleep(2)
    env = {**os.environ, "LLM_MODEL": model}
    subprocess.Popen(
        [str(ENGINE_DIR / ".venv" / "bin" / "python"), "-m", "math_tutor.api.main"],
        cwd=ENGINE_DIR, env=env,
        stdout=open(ROOT / "data" / "bench" / "engine-bench.log", "ab"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(30):
        time.sleep(2)
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=3) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
    raise RuntimeError(f"engine did not come up for {model}")


def run_trial(model: str, trial: int) -> dict:
    req = urllib.request.Request(
        "http://127.0.0.1:8000/api/v1/chat", payload(),
        {"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    t0 = time.time()
    stages: list[dict] = []
    done: dict = {}
    event = ""
    with urllib.request.urlopen(req, timeout=5400) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:") and event == "tool_result":
                d = json.loads(line[5:])
                data = d.get("data") or {}
                stages.append({
                    "stage": d.get("name"), "ok": d.get("success"),
                    "s": round((d.get("duration_ms") or 0) / 1000),
                    "summary": (d.get("summary") or "")[:80],
                    "degraded": "降级" in (d.get("summary") or "")
                                 or bool(data.get("discarded_plan_summary")),
                })
            elif line.startswith("data:") and event == "done":
                done = json.loads(line[5:])
    solve = next((s for s in stages if s["stage"] == "solve_problem"), {})
    director = next((s for s in stages if s["stage"] == "direct_video"), {})
    watch = next((s for s in stages if s["stage"] == "watch_video"), {})
    verdict = ("good" if "good" in watch.get("summary", "")
               else "acceptable" if "acceptable" in watch.get("summary", "")
               else "best-candidate" if "最佳候选" in watch.get("summary", "")
               else "none")
    row = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": model, "trial": trial,
        "total_s": round(time.time() - t0),
        "done": done.get("status"),
        "answer_in_text": "答案：6" in (done.get("text") or ""),
        "director_clean": bool(director) and not director.get("degraded"),
        "watch_verdict": verdict,
        "stages": stages,
    }
    with OUT.open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"TRIAL {model} #{trial}: done={row['done']} answer6={row['answer_in_text']} "
          f"director={'clean' if row['director_clean'] else 'degraded'} "
          f"watch={verdict} {row['total_s']}s", flush=True)
    return row


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    plan = [(spec.rsplit(":", 1)[0], int(spec.rsplit(":", 1)[1])) for spec in sys.argv[1:]]
    for model, trials in plan:
        print(f"MODEL {model}: restarting engine", flush=True)
        restart_engine(model)
        for i in range(1, trials + 1):
            try:
                run_trial(model, i)
            except Exception as exc:  # noqa: BLE001 — 单轮失败不终止实验
                print(f"TRIAL {model} #{i}: EXCEPTION {str(exc)[:120]}", flush=True)
                with OUT.open("a") as f:
                    f.write(json.dumps({"model": model, "trial": i, "error": str(exc)[:200]}) + "\n")
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
