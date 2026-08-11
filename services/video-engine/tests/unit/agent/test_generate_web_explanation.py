"""模型写 Web 讲解：门禁不过就带着违规清单打回重写，重写不成诚实失败。"""

from __future__ import annotations

import pytest

from math_tutor.application.interfaces import StreamDone, ToolContext
from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
from math_tutor.infrastructure.agent.tools.generate_web_explanation import (
    GenerateWebExplanationTool,
    build_rewrite_note,
    extract_html,
)
from math_tutor.infrastructure.agent.web_explanation_contract import GateReport

EVIDENCE = {
    "success": True,
    "all_claims_passed": True,
    "operations": [{"id": "s", "op": "solve", "result": [{"chickens": "23", "rabbits": "12"}]}],
    "claims": [{"id": "c", "left": "23", "right": "23", "passed": True}],
}


def _units(n: int, kind: str = "head") -> str:
    return "".join(f'<span data-unit="{kind}"></span>' for _ in range(n))


def _doc(rabbits: int) -> str:
    return (
        '<article data-explain="1">'
        f'<section data-beat="0" data-teach="先假设全是鸡：35 × 2 = 70">'
        f'<div data-claim="heads=35">{_units(35)}</div></section>'
        f'<section data-beat="1" data-teach="差 24，换 12 只">'
        f'<div data-claim="rabbits={rabbits}">{_units(rabbits, "rabbit")}</div></section>'
        "</article>"
    )


GOOD = _doc(12)
BAD = _doc(17)  # 计数自洽，但答案与验证过的解不符


class FakeLLM:
    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.calls: list[list] = []

    async def chat_complete(self, messages, tools=None, **kwargs):
        self.calls.append(messages)
        return StreamDone(finish_reason="stop", text=self.replies.pop(0))


def _ctx() -> ToolContext:
    return ToolContext(
        session_id="s1",
        turn_index=0,
        grade="elementary_upper",
        problem="鸡兔同笼，头35，脚94",
        state={
            "solution_steps": ["假设全是鸡", "12 只兔 23 只鸡"],
            "solution_answer": "兔 12 只，鸡 23 只",
            "verify_math_evidence": EVIDENCE,
        },
    )


def _tool(replies: list[str]) -> tuple[GenerateWebExplanationTool, FakeLLM]:
    llm = FakeLLM(replies)
    return GenerateWebExplanationTool(llm=llm, prompts=PromptLibrary()), llm


def test_从围栏和废话里也能取出HTML():
    assert extract_html("好的：\n```html\n" + GOOD + "\n```\n希望有帮助") == GOOD
    assert extract_html("我来写：" + GOOD + " 以上。") == GOOD
    assert extract_html("") == ""


@pytest.mark.asyncio
async def test_首稿合规就直接交付():
    tool, llm = _tool([GOOD])
    ctx = _ctx()
    result = await tool.execute({}, ctx)
    assert result.success, result.summary
    assert result.data["gate"]["ok"] is True
    assert ctx.state["web_explanation_html"] == GOOD
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_答案画错会被打回并把违规清单喂回去():
    tool, llm = _tool([BAD, GOOD])
    result = await tool.execute({}, _ctx())
    assert result.success, result.summary
    assert len(llm.calls) == 2
    # 第二轮必须带上首稿和具体违规，模型才改得动
    second = llm.calls[1]
    assert second[1].role == "assistant" and "rabbits=17" in second[1].content
    assert "答案不许画错" in second[2].content
    # 每一稿都留了产物，供数据集与排查
    assert [a.meta["gate_ok"] for a in result.artifacts] == [False, True]


@pytest.mark.asyncio
async def test_连续不过则诚实失败而不是交付假画面():
    tool, llm = _tool([BAD, BAD, BAD])
    result = await tool.execute({"max_rewrites": 2}, _ctx())
    assert result.success is False
    assert result.error == "web_explanation_contract_violation"
    assert "答案不许画错" in result.summary
    assert len(llm.calls) == 3
    assert len(result.artifacts) == 3


@pytest.mark.asyncio
async def test_没有已验证的解就不动手():
    tool, _ = _tool([GOOD])
    ctx = _ctx()
    ctx.state.pop("solution_steps")
    ctx.state.pop("solution_answer")
    result = await tool.execute({}, ctx)
    assert result.success is False and result.error == "missing_verified_solution"


def test_重写提示把错误和建议分开列():
    note = build_rewrite_note(GateReport(errors=["答案不许画错"], warnings=["没有出现验证过的解"]), 1)
    assert "必须修掉" in note and "答案不许画错" in note
    assert "建议一并处理" in note and "没有出现验证过的解" in note
    assert "只输出 HTML" in note


def test_内部工具可按名取用但不进对外契约():
    """控制器该看到的是五个阶段，不是每一颗螺丝——否则它会在出视频的中途拐去写网页。"""
    from math_tutor.infrastructure.agent.tool_registry import ToolRegistry

    registry = ToolRegistry()
    tool, _ = _tool([GOOD])
    registry.register_internal(tool)
    assert registry.get("generate_web_explanation") is tool
    assert "generate_web_explanation" in registry
    # 不公开：控制器的工具清单与对外契约都不含它
    assert registry.names() == []
    assert registry.list_definitions() == []
    assert len(registry) == 0
    with pytest.raises(ValueError):
        registry.register_internal(tool)


# ── 有原图的题：模型要看得见图，交付前把占位符换成真图 ──

TINY = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

GEOMETRY = (
    '<article data-explain="1">'
    '<section data-beat="0" data-teach="梯形面积公式">'
    '<img data-figure="original" src="__ORIGINAL_FIGURE__">'
    '<div data-measure="area=48"></div></section>'
    '<section data-beat="1" data-teach="反过来求高">'
    '<div data-measure="height=6"></div></section>'
    "</article>"
)


def _figure_ctx() -> ToolContext:
    ctx = _ctx()
    ctx.state["figure_image"] = TINY
    return ctx


@pytest.mark.asyncio
async def test_原图随提示词一起发给模型():
    """模型得看见图，才知道注解该标在哪条边上。"""
    tool, llm = _tool([GEOMETRY])
    await tool.execute({}, _figure_ctx())
    content = llm.calls[0][0].content
    assert isinstance(content, list)
    assert [part["type"] for part in content] == ["text", "image_url"]
    assert content[1]["image_url"]["url"] == TINY
    # 提示词里要讲清楚"不许重画"
    assert "不许自己重画" in content[0]["text"]


@pytest.mark.asyncio
async def test_交付前把占位符换成真正的图():
    tool, _ = _tool([GEOMETRY])
    ctx = _figure_ctx()
    result = await tool.execute({}, ctx)
    assert result.success, result.summary
    assert "__ORIGINAL_FIGURE__" not in result.data["html"]
    assert TINY in result.data["html"]


@pytest.mark.asyncio
async def test_自己重画不放原图会被打回重写():
    redrawn = GEOMETRY.replace(
        '<img data-figure="original" src="__ORIGINAL_FIGURE__">',
        '<svg viewBox="0 0 10 10"><polygon points="1,1 6,1 9,9 1,9"/></svg>',
    )
    tool, llm = _tool([redrawn, GEOMETRY])
    result = await tool.execute({}, _figure_ctx())
    assert result.success, result.summary
    assert len(llm.calls) == 2
    # 打回时第一条消息仍要带着图，否则模型改第二稿时就成了瞎写
    assert isinstance(llm.calls[1][0].content, list)
    assert "没有把原题的图放进来" in llm.calls[1][2].content


@pytest.mark.asyncio
async def test_没有原图时不要求也不残留占位符():
    """题目没有配图，模型却写了占位符——去掉那个 img，别留一张裂图。"""
    tool, llm = _tool([GEOMETRY])
    result = await tool.execute({}, _ctx())
    assert result.success, result.summary
    assert "__ORIGINAL_FIGURE__" not in result.data["html"]
    assert isinstance(llm.calls[0][0].content, str)
