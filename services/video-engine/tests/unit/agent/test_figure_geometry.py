"""像素几何：模型认字、像素量图。真图（用户实拍）+ 合成图两条腿。"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from math_tutor.infrastructure.agent import figure_geometry as G
from math_tutor.infrastructure.agent.figure_transcription import (
    problem_with_figure_conditions,
    refine_transcription,
    transcription_conditions,
)

BENCH = Path(__file__).resolve().parents[5] / "data" / "figure_bench"


def _model_like_transcription() -> dict:
    """本地 27B 对用户实拍的一次真实转写（坐标整体偏、把 AC/BD 当成画出来的线、标注归属乱猜）"""
    return {
        "points": [
            {"id": "A", "x": 0.16, "y": 0.20}, {"id": "B", "x": 0.83, "y": 0.18},
            {"id": "C", "x": 0.89, "y": 0.82}, {"id": "D", "x": 0.18, "y": 0.82},
            {"id": "E", "x": 0.44, "y": 0.46}, {"id": "F", "x": 0.53, "y": 0.39},
            {"id": "M", "x": 0.66, "y": 0.52}, {"id": "N", "x": 0.59, "y": 0.63},
        ],
        "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"],
                     ["A", "M"], ["B", "M"], ["D", "M"]],
        "shaded": [["M", "N", "C"]],
        "labels": [
            {"text": "5", "on": ["A", "E"], "at": [0.47, 0.41]},
            {"text": "8", "on": ["D", "E"], "at": [0.48, 0.57]},
            {"text": "7", "on": ["F", "M"], "at": [0.66, 0.38]},
        ],
    }


@pytest.mark.skipif(not (BENCH / "rect-three-triangles.jpg").exists(), reason="基准图不在")
def test_真图_点吸附到交点_线段按墨迹_数字按包含关系归属():
    case = json.loads((BENCH / "rect-three-triangles.json").read_text("utf8"))
    gray = np.asarray(Image.open(BENCH / case["image"]).convert("L"))
    t = _model_like_transcription()
    G.ground_transcription(t, gray)
    got = {l["text"]: l["on"] for l in t["labels"]}
    for item in case["ground_truth"]["region_labels"]:
        assert set(got[item["text"]]) == set(item["region"]), (item, got)
        assert next(l for l in t["labels"] if l["text"] == item["text"])["resolved"] == "geometry"
    pairs = {frozenset(s) for s in t["segments"]}
    assert frozenset("AC") not in pairs and frozenset("BD") not in pairs   # 模型脑补的对角线
    for real in ("AB", "BC", "CD", "DA", "AE", "EF", "BF", "DE", "EN", "DN", "MN", "CN", "CM"):
        assert frozenset(real) in pairs, real
    pts = {p["id"]: (p["x"], p["y"]) for p in t["points"]}
    # 吸附后的角点接近真实角点（真值来自人工量图：A(0.245,0.17) C(0.89,0.80)）
    assert abs(pts["A"][0] - 0.245) < 0.02 and abs(pts["A"][1] - 0.17) < 0.03
    assert abs(pts["C"][0] - 0.89) < 0.02 and abs(pts["C"][1] - 0.80) < 0.03


@pytest.mark.skipif(not (BENCH / "rect-three-triangles.jpg").exists(), reason="基准图不在")
def test_真图_走完refine_条件按几何断言_并替换抽取器的猜测():
    case = json.loads((BENCH / "rect-three-triangles.json").read_text("utf8"))
    img = (BENCH / case["image"]).read_bytes()
    url = "data:image/jpeg;base64," + base64.b64encode(img).decode()
    t = _model_like_transcription()
    refine_transcription(t, url, case["problem"])
    conds = transcription_conditions(t, case["problem"])
    # 题干说"面积"，区域里的裸数字就是面积
    assert "三角形AEF的面积为5" in conds and "三角形DEN的面积为8" in conds and "三角形BFM的面积为7" in conds
    # 抽取器猜错的那句被像素几何的结论换掉
    guessed = case["problem"] + "图中标注：$S_{\\triangle AEF}=5$，$S_{\\triangle EFN}=8$，$S_{\\triangle BFM}=7$"
    out = problem_with_figure_conditions(guessed, t)
    assert "EFN" not in out and "三角形DEN的面积为8" in out and "像素几何核对" in out


def _synthetic(with_labels: bool = True):
    W, H = 640, 480
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    P = {"A": (100, 80), "B": (540, 80), "C": (540, 400), "D": (100, 400)}
    P["O"] = (320, 240)
    for a, b in [("A", "B"), ("B", "C"), ("C", "D"), ("D", "A"), ("A", "C"), ("B", "D")]:
        d.line([P[a], P[b]], fill="black", width=3)
    if with_labels:
        try:
            f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 26)
        except OSError:
            f = ImageFont.load_default(size=26) if hasattr(ImageFont, "load_default") else ImageFont.load_default()
        d.text((300, 120), "12", fill="black", font=f)   # 上面的三角形 AOB 里
        d.text((50, 225), "6cm", fill="black", font=f)   # AD 边旁
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return np.asarray(im.convert("L")), P, (W, H)


def test_合成图_对角线交点吸附_标注归属_单位标注贴边():
    gray, P, (W, H) = _synthetic()
    t = {
        "points": [{"id": k, "x": x / W + 0.03, "y": y / H - 0.02} for k, (x, y) in P.items()],  # 整体偏一点
        "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"], ["A", "O"]],
        "shaded": [],
        "labels": [
            {"text": "12", "on": ["A", "B", "C"], "at": [305 / W, 125 / H]},   # 模型说在 ABC，其实在 AOB
            {"text": "6cm", "on": ["A", "B"], "at": [70 / W, 235 / H]},          # 模型说在 AB，其实贴着 AD
        ],
    }
    G.ground_transcription(t, gray)
    got = {l["text"]: l for l in t["labels"]}
    assert set(got["12"]["on"]) == {"A", "O", "B"} and got["12"]["resolved"] == "geometry"
    assert set(got["6cm"]["on"]) == {"A", "D"} and got["6cm"]["resolved"] == "geometry"
    pts = {p["id"]: (p["x"] * W, p["y"] * H) for p in t["points"]}
    assert abs(pts["O"][0] - 320) < 8 and abs(pts["O"][1] - 240) < 8   # 吸到对角线交点


def test_几乎没有直线的图原样返回():
    gray = np.full((300, 300), 240, dtype=np.uint8)
    t = {"points": [{"id": "A", "x": 0.2, "y": 0.2}], "segments": [], "shaded": [], "labels": []}
    assert G.ground_transcription(dict(t), gray) == t


def test_题干形状约束_只认题干说的那种区域():
    gray, P, (W, H) = _synthetic()
    t = {
        "points": [{"id": k, "x": x / W, "y": y / H} for k, (x, y) in P.items()],
        "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"]],
        "shaded": [],
        "labels": [{"text": "12", "on": ["A", "B"], "at": [305 / W, 125 / H]}],
    }
    G.ground_transcription(t, gray, region_sizes={3})
    assert set(t["labels"][0]["on"]) == {"A", "O", "B"}
    t2 = {"points": t["points"], "segments": [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"]],
          "shaded": [], "labels": [{"text": "12", "on": ["A", "B"], "at": [305 / W, 125 / H]}]}
    G.ground_transcription(t2, gray, region_sizes={4})   # 题干说是四边形，可像素里它在三角形 AOB 里 → 不下结论
    assert t2["labels"][0].get("resolved") is None


def test_题干里的形状约束解析():
    from math_tutor.infrastructure.agent.figure_transcription import labeled_region_sizes
    assert labeled_region_sizes("长方形ABCD中，其中三个小三角形的面积已经在图中标出") == {3}
    assert labeled_region_sizes("三角形ABE的面积为12，阴影四边形EDFB的面积为28") == {3, 4}
    assert labeled_region_sizes("如图，E是BC的中点，求阴影部分的面积") is None


@pytest.mark.skipif(not (BENCH / "rect-three-triangles.jpg").exists(), reason="基准图不在")
def test_解答位置断言按像素几何核对_假对角线与假共线被打回():
    from math_tutor.infrastructure.agent.figure_transcription import figure_consistency_issues
    case = json.loads((BENCH / "rect-three-triangles.json").read_text("utf8"))
    url = "data:image/jpeg;base64," + base64.b64encode((BENCH / case["image"]).read_bytes()).decode()
    t = _model_like_transcription()
    refine_transcription(t, url, case["problem"])
    bad = "长方形 ABCD 中，对角线 AC 和 BD 交于点 F，点 M 在线段 BF 上，$E$ 在 $BD$ 上。"
    issues = figure_consistency_issues(bad, t)
    joined = "\n".join(issues)
    assert "对角线 AC" in joined and "对角线 BD" in joined
    assert "M 在 BF 上" in joined and "E 在 BD 上" in joined
    good = "A、F、M 共线，E、F、B 共线；连接 BD 作辅助线（注意 E 不在 BD 上）。"
    assert figure_consistency_issues(good, t) == []
    assert figure_consistency_issues(bad, {"points": [], "segments": [], "labels": []}) == []  # 没校准过不当裁判
