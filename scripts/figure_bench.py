"""图形转写基准：拿真实照片裁图跑一遍转写 + 纠偏，与人工标注对照。

用法（在 services/video-engine 下）：
    uv run python ../../scripts/figure_bench.py            # 跑 data/figure_bench 下全部用例
    uv run python ../../scripts/figure_bench.py rect-three-triangles

每个用例：<id>.jpg + <id>.json（ground_truth 里是人给的：点、区域标注归属、阴影、答案）。
输出：转写出的点/线/标注 vs 基准；标注归属命中率。用来回归"读图"这一环，不打分模型的解题。
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "video-engine" / "src"))

from math_tutor.config.dependencies import get_vision_provider  # noqa: E402
from math_tutor.config.settings import get_settings  # noqa: E402
from math_tutor.infrastructure.agent.figure_transcription import (  # noqa: E402
    refine_transcription,
    transcribe_figure,
    transcription_conditions,
    transcription_summary,
)


async def run_case(case_path: Path) -> None:
    case = json.loads(case_path.read_text("utf8"))
    image = case_path.parent / case["image"]
    mime = "image/png" if image.suffix.lower() == ".png" else "image/jpeg"
    url = f"data:{mime};base64," + base64.b64encode(image.read_bytes()).decode()
    llm = get_vision_provider(get_settings())
    t = await transcribe_figure(llm, url)
    print(f"== {case['id']}")
    if not t:
        print("   转写失败")
        return
    refine_transcription(t, url, case.get("problem", ""))
    print("   转写：", transcription_summary(t))
    print("   纠偏：", t.get("reconciled"))
    print("   条件：", transcription_conditions(t))
    gt = case.get("ground_truth") or {}
    want_pts = set(gt.get("points") or [])
    got_pts = {p["id"] for p in t["points"]}
    print(f"   点：命中 {len(want_pts & got_pts)}/{len(want_pts)}，多出 {sorted(got_pts - want_pts)}")
    for item in gt.get("region_labels") or []:
        region = set(item["region"])
        hit = [l for l in t.get("labels") or [] if l["text"] == item["text"]]
        on = set(hit[0]["on"]) if hit else set()
        verdict = "✓" if on == region else ("~部分" if on & region else "✗")
        print(f"   标注「{item['text']}」应在 {''.join(item['region'])}，转写说 {''.join(sorted(on)) or '（没读到）'} {verdict}")
    if gt.get("shaded"):
        print(f"   阴影：应 {gt['shaded']}，转写 {t.get('shaded')}")


async def main(argv: list[str]) -> None:
    bench = ROOT / "data" / "figure_bench"
    cases = [bench / f"{name}.json" for name in argv] if argv else sorted(bench.glob("*.json"))
    for case in cases:
        await run_case(case)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
