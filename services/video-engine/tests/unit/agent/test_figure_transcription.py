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
    assert first_actions[0] == {"op": "create", "target": "original_figure"}


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
    assert stored["scenes"][0]["actions"][0] == {"op": "create", "target": "original_figure"}


def test_store_visual_plan_没有转写时不动计划():
    state = {}
    plan = {
        "visual_thesis": "x",
        "visual_objects": [{"id": "a", "primitive": "quantity_bar", "params": {}, "meaning": "a"}],
        "scenes": [{"actions": []}],
    }
    store_visual_plan(_plan_ctx(state), plan)
    assert all(o.get("primitive") != "figure" for o in state["visual_plan"]["visual_objects"])
