"""重画完整性：字母不当标注、错位点回收、合并弦拆分、转写缓存复用。

实机（2026-08-23 前端成片）：F 未校准成悬空点 → 合并弦 A-M 绕过它、区域畸形、
面积标签丢失；字母 E/M/N 被归属成区域标签画了两遍；视频会话重掷转写把抽取步
的好结果掷丢了。
"""

from __future__ import annotations

import asyncio
import io

import numpy as np
from PIL import Image, ImageDraw

import math_tutor.infrastructure.agent.figure_geometry as G
from math_tutor.infrastructure.agent.figure_transcription import (
    cache_grounded_transcription,
    cached_grounded_transcription,
    to_figure_params,
    transcribe_figure,
    transcription_conditions,
)


def _synthetic():
    W, H = 640, 480
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    P = {"A": (100, 80), "B": (540, 80), "C": (540, 400), "D": (100, 400), "O": (320, 240)}
    for a, b in [("A", "B"), ("B", "C"), ("C", "D"), ("D", "A"), ("A", "C"), ("B", "D")]:
        d.line([P[a], P[b]], fill="black", width=3)
    return np.asarray(im.convert("L")), P, (W, H)


def test_letter_label_is_not_attributed_nor_redrawn() -> None:
    gray, P, (W, H) = _synthetic()
    t = {
        "points": [{"id": k, "x": x / W, "y": y / H} for k, (x, y) in P.items()],
        "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"]],
        "shaded": [],
        "labels": [
            # 顶点字母被 VLM 当成标注抄下来（at 就是字母自己的位置）
            {"text": "O", "on": ["O"], "at": [318 / W, 236 / H]},
        ],
    }
    G.ground_transcription(t, gray)
    label = t["labels"][0]
    assert label.get("resolved") != "geometry"  # 不归属、不盖章
    params = to_figure_params(t)
    assert all(poly.get("label") != "O" for poly in params["polygons"])
    assert all(seg.get("label") != "O" for seg in params["segments"])
    assert transcription_conditions(t) == []  # 也不进题面


def test_displaced_point_recovered_and_chord_split() -> None:
    gray, P, (W, H) = _synthetic()
    t = {
        "points": [
            # O 初判偏 60px（超出常规吸附半径 0.08*480=38px）；其余点准确
            {"id": k, "x": (x + (60 if k == "O" else 0)) / W, "y": y / H}
            for k, (x, y) in P.items()
        ],
        # 合并弦：VLM 只说了 A-C 整条，没连 O
        "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"]],
        "shaded": [],
        "labels": [],
    }
    G.ground_transcription(t, gray)
    pts = {p["id"]: (p["x"] * W, p["y"] * H) for p in t["points"]}
    assert abs(pts["O"][0] - 320) < 10 and abs(pts["O"][1] - 240) < 10  # 放宽半径回收
    assert t.get("snap_matched") == t.get("snap_total") == 5
    pairs = {frozenset(s) for s in t["segments"]}
    assert frozenset("AO") in pairs and frozenset("OC") in pairs  # 弦在 O 处拆开
    assert frozenset("AC") not in pairs


def test_degenerate_figure_region_is_rejected() -> None:
    # 实机：重规划把抵消区错叫成 CEN（N∈CE，三点近共线），关键拍讲着色画面无色
    from math_tutor.infrastructure.agent.tools.visual_plan import (
        _degenerate_figure_region_errors,
    )

    t = {"points": [
        {"id": "C", "x": 0.9, "y": 0.8}, {"id": "E", "x": 0.4, "y": 0.5},
        {"id": "N", "x": 0.65, "y": 0.65},  # 恰在 CE 连线上
        {"id": "A", "x": 0.1, "y": 0.1}, {"id": "B", "x": 0.9, "y": 0.1},
    ]}
    plan = {"scenes": [{"figure_ops": [
        {"op": "highlight_region", "points": ["C", "E", "N"], "label": "S"},
        {"op": "highlight_region", "points": ["A", "B", "C"], "label": "T"},
    ]}]}
    errors = _degenerate_figure_region_errors(plan, t)
    assert len(errors) == 1 and "CEN" in errors[0]
    assert not _degenerate_figure_region_errors(plan, None)


def test_transcription_cache_round_trip_skips_vlm() -> None:
    url = "data:image/jpeg;base64,QUJD"
    grounded = {"points": [{"id": "A", "x": 0.1, "y": 0.1}], "segments": [], "labels": [],
                "shaded": [], "snap_matched": 1, "snap_total": 1}
    cache_grounded_transcription(url, grounded)
    assert cached_grounded_transcription(url) == grounded
    assert cached_grounded_transcription(url) is not grounded  # 深拷贝，互不污染

    class _Boom:
        async def chat_complete(self, *a, **k):
            raise AssertionError("cache hit 时不得调用视觉模型")

    out = asyncio.run(transcribe_figure(_Boom(), url))
    assert out == grounded
