"""原图转写：测量式转写的解析纪律 + 图形对象的确定性注入。

产品定案（2026-08-15）：有原图的题，各形式**按转写重画**，不贴截图。
真实性两条腿：转写只记录看得见的；图形对象由引擎注入，坐标不经模型的手。
"""
from math_tutor.infrastructure.agent.figure_transcription import (
    figure_object,
    inject_figure_object,
    parse_transcription,
    to_figure_params,
    transcription_summary,
)

RAW = (
    '{"points":[{"id":"A","x":0.36,"y":0.23},{"id":"B","x":0.55,"y":0.88},'
    '{"id":"C","x":0.95,"y":0.86},{"id":"D","x":0.62,"y":0.05}],'
    '"segments":[["A","B"],["B","C"],["C","D"],["D","A"]],'
    '"shaded":[["A","B","C"]]}'
)


def test_正常转写全部收下():
    t = parse_transcription(RAW)
    assert t is not None
    assert [p["id"] for p in t["points"]] == ["A", "B", "C", "D"]
    assert t["segments"] == [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"]]
    assert t["shaded"] == [["A", "B", "C"]]
    assert "A(0.36,0.23)" in transcription_summary(t)


def test_越界坐标与未知字母整点丢弃():
    raw = (
        '{"points":[{"id":"A","x":0.1,"y":0.1},{"id":"B","x":1.7,"y":0.2},'
        '{"id":"C","x":0.5,"y":0.9},{"id":"D","x":0.9,"y":0.4}],'
        '"segments":[["A","C"],["A","X"]],"shaded":[["A","B","C"]]}'
    )
    t = parse_transcription(raw)
    assert t is not None
    assert [p["id"] for p in t["points"]] == ["A", "C", "D"]  # B 越界被丢
    assert t["segments"] == [["A", "C"]]  # X 不存在
    assert t["shaded"] == []  # 引用了被丢的 B → 整环不要


def test_点太少或者垃圾输出判为转写失败():
    assert parse_transcription("看不清") is None
    assert parse_transcription('{"points":[{"id":"A","x":0.1,"y":0.1}]}') is None


def test_转写坐标翻成数学坐标_y向上():
    t = parse_transcription(RAW)
    params = to_figure_params(t)
    a = next(p for p in params["points"] if p["id"] == "A")
    assert a["at"] == [0.36, 0.77]  # y 翻转：图像 0.23 → 数学 1-0.23
    assert params["polygons"] == [{"points": ["A", "B", "C"], "shaded": True}]


def test_注入覆盖模型的占位对象并去重():
    t = parse_transcription(RAW)
    plan = {
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "占位"},
            {"id": "fig2", "primitive": "figure", "params": {}, "meaning": "多余的"},
            {"id": "note", "primitive": "relation_node", "meaning": "差额"},
        ],
        "scenes": [{"role": "setup", "actions": [{"op": "create", "target": "original_figure"}]}],
    }
    out = inject_figure_object(plan, t)
    figures = [o for o in out["visual_objects"] if o["primitive"] == "figure"]
    assert len(figures) == 1  # 多余的 figure 被删——孩子不该看到两张图
    assert figures[0]["params"]["points"], "占位参数必须被真实坐标覆盖"
    assert len(out["scenes"][0]["actions"]) == 1  # 已有 create 就不重复插


def test_模型忘了声明也要补上对象和第一拍的create():
    t = parse_transcription(RAW)
    plan = {
        "visual_objects": [{"id": "note", "primitive": "relation_node", "meaning": "差额"}],
        "scenes": [{"role": "setup", "actions": [{"op": "measure", "target": "note"}]}],
    }
    out = inject_figure_object(plan, t)
    assert out["visual_objects"][0]["id"] == "original_figure"
    first_actions = out["scenes"][0]["actions"]
    assert first_actions[0]["op"] == "create"
    assert first_actions[0]["targets"] == ["original_figure"]  # Manim 编译器只认 targets


def test_figure_object形状与编译器约定一致():
    t = parse_transcription(RAW)
    obj = figure_object(t)
    assert obj["id"] == "original_figure"
    assert obj["primitive"] == "figure"
    # 编译器按 points[*].at / segments[*].from,to / polygons[*].points 读
    assert all(len(p["at"]) == 2 for p in obj["params"]["points"])
    assert all({"from", "to"} <= set(s) for s in obj["params"]["segments"])


# ── transcribe_figure 本体：消息必须是 ChatMessage（裸 dict 在 provider 里会炸，实机踩过） ──

import asyncio

from math_tutor.application.interfaces import ChatMessage
from math_tutor.infrastructure.agent.figure_transcription import transcribe_figure


class _FakeDone:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeLLM:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[list] = []

    async def chat_complete(self, messages, **kwargs):
        self.calls.append(messages)
        # 复刻真 provider 的姿势：直接访问 .content——裸 dict 立刻暴露
        for m in messages:
            assert isinstance(m, ChatMessage), f"provider 只认 ChatMessage，收到 {type(m)}"
            _ = m.content
        return _FakeDone(self.reply)


def test_transcribe_figure_发出的是ChatMessage并带图():
    llm = _FakeLLM(RAW)
    t = asyncio.run(transcribe_figure(llm, "data:image/jpeg;base64,QUJD"))
    assert t is not None and [p["id"] for p in t["points"]] == ["A", "B", "C", "D"]
    user = llm.calls[0][1]
    assert isinstance(user.content, list)
    assert user.content[1]["image_url"]["url"].startswith("data:image/jpeg")


def test_transcribe_figure_模型答非所问返回None不拦路():
    t = asyncio.run(transcribe_figure(_FakeLLM("看不清"), "data:image/jpeg;base64,QUJD"))
    assert t is None


def test_不是dataURL直接返回None():
    llm = _FakeLLM(RAW)
    assert asyncio.run(transcribe_figure(llm, "http://example.com/x.jpg")) is None
    assert llm.calls == []


# ── 注入的必经之路：store_visual_plan——降级兜底计划也必须带图（实机踩过：
#    导演降级成"数量链"计划后，几何题的画面变成了纯数点点，转写好的图没人用） ──

from math_tutor.application.interfaces import ToolContext
from math_tutor.infrastructure.agent.tools.visual_plan import store_visual_plan


def _plan_ctx(state: dict) -> ToolContext:
    return ToolContext(session_id="s1", turn_index=0, grade="elementary_upper", problem="题", state=state)


def test_store_visual_plan_对降级计划同样注入图形():
    t = parse_transcription(RAW)
    state = {"figure_transcription": t}
    # 模拟 build_safe_visual_plan 的产物：只有数量对象，没有 figure
    plan = {
        "visual_thesis": "让已验证运算链中的每个数量状态连续变化并最终落到答案",
        "visual_objects": [
            {"id": "verified_value_0", "primitive": "quantity_bar", "params": {"value": 40}, "meaning": "40"},
        ],
        "scenes": [{"role": "setup", "actions": [{"op": "create", "target": "verified_value_0"}]}],
    }
    store_visual_plan(_plan_ctx(state), plan)
    stored = state["visual_plan"]
    figures = [o for o in stored["visual_objects"] if o.get("primitive") == "figure"]
    assert len(figures) == 1 and figures[0]["params"]["points"]
    assert stored["scenes"][0]["actions"][0]["targets"] == ["original_figure"]


def test_store_visual_plan_没有转写时不动计划():
    state = {}
    plan = {
        "visual_thesis": "x",
        "visual_objects": [{"id": "a", "primitive": "quantity_bar", "params": {}, "meaning": "a"}],
        "scenes": [{"actions": []}],
    }
    store_visual_plan(_plan_ctx(state), plan)
    assert all(o.get("primitive") != "figure" for o in state["visual_plan"]["visual_objects"])


# ── 编排解析：模型只许指字母，坐标由转写解析；自由几何一律剥掉 ──

from math_tutor.infrastructure.agent.figure_transcription import choreograph_figure


def _choreo_plan() -> dict:
    return {
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
            # 模型自由画的三角形——实机上它和真图打架（"乱做题"），必须剥掉
            {"id": "tri_free", "primitive": "polygon", "params": {"vertices": [[0, 0], [1, 0], [0, 1]]}, "meaning": "野图"},
            {"id": "note", "primitive": "relation_node", "label": "28-12=16", "meaning": "差额"},
        ],
        "scenes": [
            {
                "role": "setup",
                "actions": [{"op": "create", "targets": ["tri_free"]}, {"op": "create", "targets": ["note"]}],
                "figure_ops": [
                    {"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"},
                    {"op": "draw_segment", "from": "B", "to": "D", "label": "辅助线"},
                    {"op": "highlight_region", "points": ["A", "B", "X"]},  # X 不存在 → 丢
                ],
            },
            {"role": "verify", "actions": [{"op": "verify", "targets": ["note"]}]},
        ],
    }


def test_编排_自由几何被剥掉_引用动作一并清理():
    t = parse_transcription(RAW)
    plan = choreograph_figure(_choreo_plan(), t)
    ids = [o["id"] for o in plan["visual_objects"]]
    assert "tri_free" not in ids
    assert all(
        "tri_free" not in (a.get("targets") or []) for s in plan["scenes"] for a in s["actions"]
    )


def test_编排_字母解析成坐标_错字母丢弃不歪图():
    t = parse_transcription(RAW)
    plan = choreograph_figure(_choreo_plan(), t)
    overlay = next(o for o in plan["visual_objects"] if o["id"] == "figure_overlay_0")
    names = {p["id"] for p in overlay["params"]["points"]}
    assert names == {"A", "B", "D"}  # X 那条整体被丢，图不会歪
    assert overlay["params"]["polygons"][0] == {"points": ["A", "B", "D"], "shaded": True, "label": "12", "tone": "gold"}
    assert overlay["params"]["segments"][0]["label"] == "辅助线"
    # 该拍首个动作 create overlay（两种字段写法都带）
    first = plan["scenes"][0]["actions"][0]
    assert first["targets"] == ["figure_overlay_0"] and first["target"] == "figure_overlay_0"
    # figure_ops 已消费，不残留给下游
    assert "figure_ops" not in plan["scenes"][0]


def test_编排后底图注入不误删overlay():
    t = parse_transcription(RAW)
    plan = inject_figure_object(choreograph_figure(_choreo_plan(), t), t)
    ids = [o["id"] for o in plan["visual_objects"] if o["primitive"] == "figure"]
    assert "original_figure" in ids and "figure_overlay_0" in ids


# ── 数量表达必须在图上：图外方块阵剥掉；无 figure_ops 的计划要打回 ──

from math_tutor.infrastructure.agent.figure_transcription import figure_ops_violations


def test_图外数量图标被剥掉():
    t = parse_transcription(RAW)
    plan = _choreo_plan()
    plan["visual_objects"].append(
        {"id": "grid16", "primitive": "unit_grid", "params": {"count": 16}, "meaning": "面积16"}
    )
    plan["scenes"][0]["actions"].append({"op": "create", "targets": ["grid16"]})
    out = choreograph_figure(plan, t)
    assert all(o["id"] != "grid16" for o in out["visual_objects"])
    assert all(
        "grid16" not in (a.get("targets") or []) for s in out["scenes"] for a in s["actions"]
    )


def test_没有figure_ops的计划报违规打回():
    plan = {"scenes": [{"actions": []}, {"actions": []}]}
    assert any("figure_ops" in v for v in figure_ops_violations(plan))
    plan["scenes"][0]["figure_ops"] = [{"op": "highlight_region", "points": ["A", "B", "D"]}]
    assert figure_ops_violations(plan) == []


# ── 剥离后的计划必须仍可确定性编译（掏空 → 模型写码 → 满屏乱点线，实机踩过） ──

from math_tutor.infrastructure.agent.tools.compile_video import _fallback_visual_ir
from math_tutor.infrastructure.agent.tools.visual_plan import _ensure_figure_plan_compilable


def test_剥空的计划补齐下限后IR仍可用():
    t = parse_transcription(RAW)
    # 极端情况：模型的对象全是会被剥掉的（自由几何 + 图外方块阵）
    plan = {
        "visual_thesis": "x" * 20,
        "visual_objects": [
            {"id": "tri", "primitive": "polygon", "params": {"vertices": [[0, 0], [1, 0], [0, 1]]}, "meaning": "野图"},
            {"id": "grid", "primitive": "unit_grid", "params": {"count": 16}, "meaning": "方块阵"},
        ],
        "scenes": [
            {"role": "setup", "actions": [{"op": "create", "targets": ["tri"]}], "teaching_line": "看"},
            {"role": "verify", "actions": [{"op": "verify", "targets": ["grid"]}], "teaching_line": "验"},
        ],
    }
    plan = inject_figure_object(choreograph_figure(plan, t), t)
    ctx = _plan_ctx({"solution_answer": "16 平方厘米"})
    _ensure_figure_plan_compilable(ctx, plan)
    # 每拍都有动作、对象 ≥2，确定性 IR 必须提取成功——否则会跌进模型写码
    assert all(s["actions"] for s in plan["scenes"])
    assert len(plan["visual_objects"]) >= 2
    assert _fallback_visual_ir(plan) is not None


# ── actions 消毒：幽灵引用（region_ABE 等未声明 id）不再让整份好计划陪葬 ──

from math_tutor.infrastructure.agent.tools.visual_plan import (
    _sanitize_figure_plan_actions,
    _validate_plan,
)


def test_幽灵目标被清掉_计划过结构校验():
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "E、F 是中点，等底同高使面积逐段传递，28=12+DFC 因此成立",
        "symbol_ledger": ["原图 = 底图", "阴影 = 灰色"],
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["original_figure"]},
                         {"op": "highlight", "targets": ["region_ABE"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
            {"role": "verify", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "验证", "invariant": "面积守恒", "attention_target": "DFC",
             "exit_condition": "得出16", "teaching_line": "28-12=16，DFC 是 16",
             "duration_s": 5,
             "actions": [{"op": "verify", "targets": ["region_DFC", "line_BD"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["B", "C", "D"], "label": "16"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    # 幽灵目标没了；空拍补了高亮底图
    assert [(a["op"], a["targets"]) for a in plan["scenes"][0]["actions"]] == [
        ("create", ["original_figure"])
    ]
    assert plan["scenes"][1]["actions"][0]["targets"] == ["original_figure"]
    # 玩具计划不满足拍数/锚点等其它契约——本测试只关心：幽灵引用类错误清零
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "声明" in e or "引用" in e], errors


def test_模型自declare的region对象被删后动作改指底图_IR仍可用():
    t = parse_transcription(RAW)
    plan = {
        "visual_thesis": "x" * 20,
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
            {"id": "region_ABD", "primitive": "figure", "params": {}, "meaning": "区域"},
        ],
        "scenes": [
            {"role": "setup", "actions": [{"op": "create", "targets": ["region_ABD"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}],
             "teaching_line": "看"},
            {"role": "verify", "actions": [{"op": "verify", "targets": ["region_ABD"]}],
             "figure_ops": [], "teaching_line": "验"},
        ],
    }
    plan = choreograph_figure(inject_figure_object(plan, t), t)
    ids = {o["id"] for o in plan["visual_objects"]}
    assert "region_ABD" not in ids
    # 动作没有留空引用，而是改指底图——IR 提取必须仍然成功
    for s in plan["scenes"]:
        for a in s["actions"]:
            assert "region_ABD" not in (a.get("targets") or [])
            assert a.get("targets"), a
    assert _fallback_visual_ir(plan) is not None


# ── 等量配对：相等的两块同一拍一起亮（同色 + 中缝等号）──


def _pair_plan(ops):
    return {
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "讲义原图"},
            {"id": "note", "primitive": "relation_node", "label": "28-12=16", "meaning": "差额"},
        ],
        "scenes": [
            {"role": "setup", "actions": [{"op": "create", "targets": ["note"]}], "figure_ops": ops},
        ],
    }


def test_compare_equal_两块同色同拍并带等号标注():
    t = parse_transcription(RAW)
    plan = choreograph_figure(
        _pair_plan([{"op": "compare_equal", "regions": [["A", "B", "D"], ["B", "C", "D"]], "label": "12"}]),
        t,
    )
    overlay = next(o for o in plan["visual_objects"] if o["id"] == "figure_overlay_0")
    polys = overlay["params"]["polygons"]
    assert [p["points"] for p in polys] == [["A", "B", "D"], ["B", "C", "D"]]
    assert {p["tone"] for p in polys} == {"gold"} and {p["pair"] for p in polys} == {1}
    assert [p["label"] for p in polys] == ["12", "12"]
    assert overlay["params"]["equal_marks"] == [
        {"a": ["A", "B", "D"], "b": ["B", "C", "D"], "label": "12", "tone": "gold"}
    ]
    assert {p["id"] for p in overlay["params"]["points"]} == {"A", "B", "C", "D"}


def test_compare_equal_只解析出一块退成普通高亮_不出等号():
    t = parse_transcription(RAW)
    plan = choreograph_figure(
        _pair_plan([{"op": "compare_equal", "regions": [["A", "B", "D"], ["B", "C", "Z"]], "label": "12"}]),
        t,
    )
    overlay = next(o for o in plan["visual_objects"] if o["id"] == "figure_overlay_0")
    assert len(overlay["params"]["polygons"]) == 1
    assert "pair" not in overlay["params"]["polygons"][0]
    assert "equal_marks" not in overlay["params"]


def test_compare_equal_两块都指错整条丢弃():
    t = parse_transcription(RAW)
    plan = choreograph_figure(
        _pair_plan([{"op": "compare_equal", "regions": [["A", "B", "Z"], ["Q", "C", "Z"]]}]),
        t,
    )
    assert not any(o["id"].startswith("figure_overlay_") for o in plan["visual_objects"])


def test_模型没在首拍create底图_消毒后补上_不再报出现前执行():
    """实机第 2 轮：导演每拍只写 highlight original_figure，没有 create，
    结构校验以"对象出现前执行"打回整份带图好计划。底图首拍出场是入库硬保证，校验前就补齐。"""
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "E、F 是中点，等底同高使面积逐段传递，28=12+DFC 因此成立",
        "symbol_ledger": ["原图 = 底图"],
        "visual_objects": [],  # 连占位都忘了声明
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "highlight", "targets": ["original_figure"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
            {"role": "verify", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "验证", "invariant": "面积守恒", "attention_target": "DFC",
             "exit_condition": "得出16", "teaching_line": "28-12=16，DFC 是 16",
             "duration_s": 5,
             "actions": [{"op": "highlight", "targets": ["original_figure"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["B", "C", "D"], "label": "16"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    assert plan["visual_objects"][0]["id"] == "original_figure"
    first = plan["scenes"][0]["actions"][0]
    assert (first["op"], first["targets"], first["target"]) == (
        "create", ["original_figure"], "original_figure"
    )
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "出现前" in e], errors


def test_分步表达_下一拍先退上一拍的高亮再出新的():
    t = parse_transcription(RAW)
    plan = choreograph_figure(
        {
            "visual_objects": [
                {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "讲义原图"},
            ],
            "scenes": [
                {"role": "setup", "actions": [], "figure_ops": [
                    {"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
                {"role": "transform", "actions": [], "figure_ops": [
                    {"op": "highlight_region", "points": ["B", "C", "D"], "label": "16"}]},
            ],
        },
        t,
    )
    ops = [(a["op"], a["targets"]) for a in plan["scenes"][1]["actions"]]
    assert ops[:2] == [("remove", ["figure_overlay_0"]), ("create", ["figure_overlay_1"])]
    tones = [
        o["params"]["polygons"][0]["tone"]
        for o in plan["visual_objects"] if o["id"].startswith("figure_overlay_")
    ]
    assert tones == ["gold", "blue"]  # 每拍专属色


def test_自declare的自由几何_漏meaning_长rationale_消毒后都不再打回():
    """实机第 3 轮首稿：region_ABE 是模型自 declare 的 polygon 只 highlight 不 create、
    动作漏 meaning、essence_rationale 超 400 字——三条都不是画面问题，不该让带图计划降级。"""
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "等底同高，" * 120,
        "symbol_ledger": ["原图 = 底图"],
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
            {"id": "region_ABE", "primitive": "polygon", "params": {"vertices": [[0, 0], [1, 0], [0, 1]]}, "meaning": "ABE"},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["original_figure"]},
                         {"op": "highlight", "targets": ["region_ABE"]}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    assert [o["id"] for o in plan["visual_objects"]] == ["original_figure"]
    assert len(plan["essence_rationale"]) <= 400
    assert all(a.get("meaning") for a in plan["scenes"][0]["actions"])
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "出现前" in e or "meaning" in e or "400" in e], errors


def test_关系靠颜色_同拍配对同色_其余各块不同色_算式标签不上图():
    t = parse_transcription(RAW)
    plan = choreograph_figure(
        _pair_plan([
            {"op": "compare_equal", "regions": [["A", "B", "D"], ["B", "C", "D"]], "label": "12"},
            {"op": "highlight_region", "points": ["A", "B", "C"], "label": "28 = 12 + 16"},
            {"op": "highlight_region", "points": ["A", "C", "D"], "label": "16"},
        ]),
        t,
    )
    overlay = next(o for o in plan["visual_objects"] if o["id"] == "figure_overlay_0")
    polys = overlay["params"]["polygons"]
    pair_tones = {p["tone"] for p in polys if p.get("pair") == 1}
    assert len(pair_tones) == 1  # 一对共用一色——颜色就是等号
    others = [p["tone"] for p in polys if not p.get("pair")]
    assert len(set(others)) == 2 and not (set(others) & pair_tones)  # 其余各块各一色
    # 算式是符号，不上图；数值照写
    labels = [p.get("label") for p in polys]
    assert "28 = 12 + 16" not in labels and "16" in labels
    # 配对语义保留给渲染端做同步脉冲，但不再要求画等号
    assert overlay["params"]["equal_marks"][0]["tone"] in pair_tones


def test_模型自declare的region_figure对象_校验前删掉并改指底图():
    """实机第 5 轮：region_abe/region_ebd 被声明成 figure 对象、只 highlight 不 create，
    校验报"对象出现前执行"把好计划打回。入库时 inject 会删它们并改指底图，校验前也照做。"""
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "E、F 是中点，等底同高使面积逐段传递，28=12+DFC 因此成立",
        "symbol_ledger": ["原图 = 底图"],
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
            {"id": "region_abe", "primitive": "figure", "params": {}, "meaning": "ABE"},
            {"id": "note", "primitive": "relation_node", "label": "28-12=16", "meaning": "算式"},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["original_figure", "note"], "meaning": "出场"},
                         {"op": "highlight", "targets": ["region_abe"], "meaning": "看 ABE"}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    assert [o["id"] for o in plan["visual_objects"]] == ["original_figure", "note"]
    assert plan["scenes"][0]["actions"][1]["targets"] == ["original_figure"]
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "出现前" in e], errors


def test_只点名不create的幻影对象_校验前删掉并改指底图():
    """实机第 5 轮：region_abe/line_bd 被声明成 relation_node、全片没有 create，
    只在 highlight/compare 里被点名——画面本来就在 figure_ops 里，幻影不该毁掉计划。"""
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "E、F 是中点，等底同高使面积逐段传递，28=12+DFC 因此成立",
        "symbol_ledger": ["原图 = 底图"],
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
            {"id": "region_abe", "primitive": "relation_node", "label": "ABE", "meaning": "ABE"},
            {"id": "line_bd", "primitive": "relation_node", "label": "BD", "meaning": "辅助线"},
            {"id": "note", "primitive": "relation_node", "label": "28-12=16", "meaning": "算式"},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["original_figure"], "meaning": "出场"},
                         {"op": "highlight", "targets": ["region_abe"], "meaning": "看 ABE"}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
            {"role": "verify", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "验证", "invariant": "面积守恒", "attention_target": "DFC",
             "exit_condition": "得出16", "teaching_line": "28-12=16",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["note"], "meaning": "算式"},
                         {"op": "compare", "targets": ["region_abe", "line_bd"], "meaning": "比较"}],
             "figure_ops": [{"op": "highlight_region", "points": ["B", "C", "D"], "label": "16"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    assert [o["id"] for o in plan["visual_objects"]] == ["original_figure", "note"]
    assert plan["scenes"][0]["actions"][1]["targets"] == ["original_figure"]
    assert plan["scenes"][1]["actions"][1]["targets"] == ["original_figure"]
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "出现前" in e or "声明" in e], errors


def test_verify拍被降级成highlight后仍补一个核对动作():
    """实机第 7 轮：verify 拍只有一个 compare 幻影动作，消毒后成了 highlight，
    契约以"verify 场景必须 compare/measure/verify"打回。核对在图上（figure_ops），动作只是节拍器。"""
    plan = {
        "visual_thesis": "指着图发现等底同高的接力传递关系",
        "essence_rationale": "E、F 是中点，等底同高使面积逐段传递，28=12+DFC 因此成立",
        "symbol_ledger": ["原图 = 底图"],
        "visual_objects": [
            {"id": "original_figure", "primitive": "figure", "params": {}, "meaning": "底图"},
        ],
        "scenes": [
            {"role": "setup", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "看图", "invariant": "面积守恒", "attention_target": "阴影",
             "exit_condition": "看清已知", "teaching_line": "看图：ABE 是 12，阴影是 28",
             "duration_s": 5,
             "actions": [{"op": "create", "targets": ["original_figure"], "meaning": "出场"}],
             "figure_ops": [{"op": "highlight_region", "points": ["A", "B", "D"], "label": "12"}]},
            {"role": "verify", "anchor_zone": "center", "key_objects": "original_figure",
             "action": "核对", "invariant": "面积守恒", "attention_target": "DFC",
             "exit_condition": "得出16", "teaching_line": "所以 DFC 是 16",
             "duration_s": 5,
             "actions": [{"op": "map", "targets": ["region_dfc"], "meaning": "对比"}],
             "figure_ops": [{"op": "highlight_region", "points": ["B", "C", "D"], "label": "16"}]},
        ],
    }
    _sanitize_figure_plan_actions(plan)
    ops = [a["op"] for a in plan["scenes"][1]["actions"]]
    assert "verify" in ops
    errors = _validate_plan(plan, "elementary_upper")
    assert not [e for e in errors if "verify 场景" in e or "出现前" in e], errors
