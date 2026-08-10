"""Web 讲解契约门禁：宣称多少就得画出多少，数字不许凭空出现。"""

from __future__ import annotations

from math_tutor.infrastructure.agent.web_explanation_contract import (
    parse_web_explanation,
    verify_web_explanation,
)

# 鸡兔同笼那次真实会话的 Math IR（solve-math-turn01.json）
EVIDENCE = {
    "success": True,
    "all_claims_passed": True,
    "operations": [{"id": "solve_system", "op": "solve", "result": [{"chickens": "23", "rabbits": "12"}]}],
    "claims": [
        {"id": "chickens_value", "left": "23", "right": "23", "passed": True},
        {"id": "rabbits_value", "left": "12", "right": "12", "passed": True},
    ],
}
REQUEST = {
    "operations": [
        {
            "id": "solve_system",
            "op": "solve",
            "expression": ["chickens + rabbits - 35", "2*chickens + 4*rabbits - 94"],
        }
    ]
}


def _doc(body: str) -> str:
    return f'<article data-explain="1">{body}</article>'


def _units(n: int, kind: str = "head") -> str:
    return "".join(f'<span data-unit="{kind}"></span>' for _ in range(n))


def _beat(index: int, teach: str, inner: str) -> str:
    return f'<section data-beat="{index}" data-teach="{teach}">{inner}</section>'


GOOD = _doc(
    _beat(0, "先假设全是鸡：35 个头、每个 2 只脚，共 70 只脚。",
          f'<div data-claim="heads=35">{_units(35)}</div>'
          '<div data-measure="assumed_feet=70"></div>')
    + _beat(1, "实际 94 只脚，差 24；每换一只补 2，要换 12 只。",
            f'<div data-claim="rabbits=12">{_units(12, "rabbit")}</div>'
            '<div data-measure="real_feet=94"></div>')
    + _beat(2, "12 只兔、23 只鸡，头 35 脚 94。",
            f'<div data-claim="chickens=23">{_units(23, "chicken")}</div>')
)


def test_合规的讲解通过门禁():
    report = verify_web_explanation(GOOD, EVIDENCE, REQUEST)
    assert report.ok, report.errors
    assert report.warnings == []


def test_标了35却只画了33个必须被抓出来():
    bad = _doc(
        _beat(0, "先假设全是鸡", f'<div data-claim="heads=35">{_units(33)}</div>')
        + _beat(1, "换 12 只", f'<div data-claim="rabbits=12">{_units(12, "rabbit")}</div>')
    )
    findings = verify_web_explanation(bad, EVIDENCE, REQUEST).errors
    assert any("heads" in f and "33" in f for f in findings), findings


def test_答案画错必须硬拦():
    """验证过的解是 rabbits=12；画面标 17 且真画了 17 个，计数自洽但答案是错的。"""
    bad = _doc(
        _beat(0, "先假设全是鸡", f'<div data-claim="heads=35">{_units(35)}</div>')
        + _beat(1, "换 17 只", f'<div data-claim="rabbits=17">{_units(17, "rabbit")}</div>')
    )
    report = verify_web_explanation(bad, EVIDENCE, REQUEST)
    assert any("答案不许画错" in f for f in report.errors), report


def test_中间量不在Math_IR里也放行():
    """假设法的 70 = 35 × 2、缺口 24 都不在证据里——它们是教学过程，不该被拦。"""
    report = verify_web_explanation(GOOD, EVIDENCE, REQUEST)
    assert report.ok and report.warnings == [], report


def test_答案压根没画出来要提醒():
    doc = _doc(
        _beat(0, "先假设全是鸡", f'<div data-claim="heads=35">{_units(35)}</div>')
        + _beat(1, "再看一遍", f'<div data-claim="heads=35">{_units(35)}</div>')
    )
    report = verify_web_explanation(doc, EVIDENCE, REQUEST)
    assert report.ok, report.errors
    assert any("没有出现验证过的解" in f for f in report.warnings), report


def test_纯文字作文不算图形讲解():
    essay = _doc(
        _beat(0, "首先我们假设全部都是鸡", "<p>那么一共有 70 只脚。</p>")
        + _beat(1, "所以兔子有 12 只", "<p>因此答案是 12 只兔、23 只鸡。</p>")
    )
    findings = verify_web_explanation(essay, EVIDENCE, REQUEST).errors
    assert any("纯文字" in f for f in findings), findings


def test_少于两拍不算过程():
    one = _doc(_beat(0, "答案是 12 只兔", f'<div data-claim="rabbits=12">{_units(12)}</div>'))
    findings = verify_web_explanation(one, EVIDENCE, REQUEST).errors
    assert any("至少要 2 拍" in f for f in findings), findings


def test_没写这一拍在讲什么要被打回():
    doc = _doc(
        f'<section data-beat="0"><div data-claim="heads=35">{_units(35)}</div></section>'
        + _beat(1, "换 12 只", f'<div data-claim="rabbits=12">{_units(12, "rabbit")}</div>')
    )
    findings = verify_web_explanation(doc, EVIDENCE, REQUEST).errors
    assert any("data-teach" in f for f in findings), findings


def test_外链与联网一律拒绝():
    external = _doc(
        _beat(0, "看图", '<img src="https://cdn.example.com/a.png"><span data-unit="x"></span>')
        + _beat(1, "再看", '<span data-unit="x"></span>')
    )
    findings = verify_web_explanation(external, EVIDENCE, REQUEST).errors
    assert any("外部资源" in f for f in findings), findings

    netcall = _doc(
        _beat(0, "看图", '<span data-unit="x"></span><script>fetch("/steal")</script>')
        + _beat(1, "再看", '<span data-unit="x"></span>')
    )
    assert any("网络调用" in f for f in verify_web_explanation(netcall, EVIDENCE, REQUEST).errors)


def test_嵌套计数按子树归属而不是全局():
    """两处宣称各数各的，互不干扰——否则一个 claim 会吃掉整页的个体。"""
    doc = _doc(
        _beat(
            0,
            "两组分开数",
            f'<div data-claim="rabbits=12">{_units(12, "rabbit")}</div>'
            f'<div data-claim="chickens=23">{_units(23, "chicken")}</div>',
        )
        + _beat(1, "合起来 35", f'<div data-claim="heads=35">{_units(35)}</div>')
    )
    assert verify_web_explanation(doc, EVIDENCE, REQUEST).ok
    parsed = parse_web_explanation(doc)
    by_name = {c.name: c.counted for c in parsed.claims}
    assert by_name == {"rabbits": 12, "chickens": 23, "heads": 35}
    assert parsed.units_total == 12 + 23 + 35


def test_外层宣称把内层个体一起算进去():
    """35 = 12 + 23 嵌在一个总组里时，外层数到 35，内层各数各的。"""
    doc = _doc(
        _beat(
            0,
            "总共 35 个个体，其中兔 12",
            '<div data-claim="heads=35">'
            f'<div data-claim="rabbits=12">{_units(12, "rabbit")}</div>'
            f'{_units(23, "chicken")}'
            "</div>",
        )
        + _beat(1, "核对", f'<div data-claim="chickens=23">{_units(23, "chicken")}</div>')
    )
    assert verify_web_explanation(doc, EVIDENCE, REQUEST).ok


def test_没有证据时只校验自洽不校验数值来源():
    """引擎没给证据（例如纯几何题）时不能误报"凭空"，但计数仍要自洽。"""
    doc = _doc(
        _beat(0, "七个", f'<div data-claim="things=7">{_units(7)}</div>')
        + _beat(1, "再看", f'<div data-claim="things=7">{_units(7)}</div>')
    )
    assert verify_web_explanation(doc).ok
    bad = _doc(
        _beat(0, "七个", f'<div data-claim="things=7">{_units(5)}</div>')
        + _beat(1, "再看", f'<div data-claim="things=7">{_units(7)}</div>')
    )
    assert any("只有 5 个" in f for f in verify_web_explanation(bad).errors)


def test_参考实现能通过门禁_契约必须是写得出来的():
    """一份按契约手写的完整讲解（鸡兔同笼三拍）必须通过。

    门禁只会越收越紧，收到「谁都写不出来」就没意义了。这份参考实现同时是
    「合规长什么样」的样板：35 个圆圈各垂 2 根线、12 个换成方头 4 条腿、
    两根可比长短的条 + 缺口带、逐拍导航、自足无外链。
    """
    import pathlib

    reference = (
        pathlib.Path(__file__).parents[2] / "fixtures" / "web_explanation_reference.html"
    ).read_text(encoding="utf-8")
    report = verify_web_explanation(reference, EVIDENCE, REQUEST)
    assert report.ok, report.errors
    assert report.warnings == []

    parsed = parse_web_explanation(reference)
    # 个体是字面写出来的，不是脚本造的——静态门禁才数得到
    assert parsed.units_total == 35 + 35 + 12 + 23
    assert [b["index"] for b in parsed.beats] == [0, 1, 2]
    assert all(b["teach"] for b in parsed.beats)
    by_name = {}
    for claim in parsed.claims:
        by_name.setdefault(claim.name, []).append((int(claim.value), claim.counted))
    assert by_name["heads"] == [(35, 35), (35, 35)]
    assert by_name["rabbits"] == [(12, 12)]
    assert by_name["chickens"] == [(23, 23)]
