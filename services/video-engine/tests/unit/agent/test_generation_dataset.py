"""讲解生成数据集：字段稳定、坏行不致命、聚合能回答"该往哪条路使劲"。"""

from __future__ import annotations

import json

from math_tutor.infrastructure.agent.generation_dataset import (
    ROUTE_DETERMINISTIC,
    ROUTE_LLM_HTML,
    attach_feedback,
    dataset_path,
    read_records,
    record_generation,
    summarize,
)


def test_一次生成留一条可训练的记录(tmp_path):
    rec = record_generation(
        tmp_path,
        route=ROUTE_DETERMINISTIC,
        problem="鸡兔同笼，头35，脚94",
        grade="elementary_upper",
        grounding_source="linear_mix_swap",
        math_request={"operations": [{"op": "solve"}]},
        math_evidence={"all_claims_passed": True},
        artifact={"visual_objects": []},
        gate={"ok": True, "errors": [], "warnings": []},
    )
    rows = list(read_records(tmp_path))
    assert len(rows) == 1
    row = rows[0]
    # 训练要用的三样：输入、产物、标签，缺一不可
    assert row["problem"] == "鸡兔同笼，头35，脚94"
    assert row["math_evidence"] == {"all_claims_passed": True}
    assert row["gate"]["ok"] is True
    assert row["route"] == ROUTE_DETERMINISTIC
    assert row["grounding_source"] == "linear_mix_swap"
    assert row["id"] == rec.id and row["version"] >= 1


def test_HTML_产物整篇存下来(tmp_path):
    html = '<article data-explain="1"><section data-beat="0"></section></article>'
    record_generation(
        tmp_path,
        route=ROUTE_LLM_HTML,
        problem="p",
        artifact=html,
        artifact_kind="html",
        gate={"ok": False, "errors": ["答案不许画错"], "warnings": []},
    )
    row = next(iter(read_records(tmp_path)))
    assert row["artifact_kind"] == "html" and row["artifact"] == html
    # 失败样本同样要留：偏好学习需要负例
    assert row["gate"]["ok"] is False and row["gate"]["errors"]


def test_坏行跳过而不是整份读不出来(tmp_path):
    record_generation(tmp_path, route=ROUTE_DETERMINISTIC, problem="a")
    path = dataset_path(tmp_path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{ 这不是 json\n")
    record_generation(tmp_path, route=ROUTE_LLM_HTML, problem="b")
    rows = list(read_records(tmp_path))
    assert [r["problem"] for r in rows] == ["a", "b"]


def test_人工反馈可以事后补录(tmp_path):
    rec = record_generation(tmp_path, route=ROUTE_LLM_HTML, problem="p")
    assert attach_feedback(tmp_path, rec.id, {"label": "good", "by": "parent"}) is True
    row = next(iter(read_records(tmp_path)))
    assert row["feedback"] == {"label": "good", "by": "parent"}
    # 找不到的 id 不该悄悄改别人
    assert attach_feedback(tmp_path, "nope", {"label": "bad"}) is False


def test_按路线聚合出通过率(tmp_path):
    record_generation(tmp_path, route=ROUTE_DETERMINISTIC, problem="a", gate={"ok": True})
    record_generation(tmp_path, route=ROUTE_DETERMINISTIC, problem="b", gate={"ok": True})
    record_generation(tmp_path, route=ROUTE_LLM_HTML, problem="c", gate={"ok": True})
    record_generation(tmp_path, route=ROUTE_LLM_HTML, problem="d", gate={"ok": False})
    stats = summarize(tmp_path)
    assert stats["total"] == 4
    assert stats["by_route"][ROUTE_DETERMINISTIC] == {"count": 2, "gate_ok": 2, "with_feedback": 0}
    assert stats["by_route"][ROUTE_LLM_HTML]["gate_ok"] == 1


def test_没有数据集文件时读回空而不是报错(tmp_path):
    assert list(read_records(tmp_path)) == []
    assert summarize(tmp_path) == {"total": 0, "by_route": {}}


def test_每行都是独立完整的_json(tmp_path):
    for i in range(3):
        record_generation(tmp_path, route=ROUTE_LLM_HTML, problem=f"题{i}\n带换行")
    text = dataset_path(tmp_path).read_text(encoding="utf-8")
    lines = [l for l in text.split("\n") if l.strip()]
    assert len(lines) == 3
    # 题干里的换行不能把记录撕成两行
    for line in lines:
        json.loads(line)
