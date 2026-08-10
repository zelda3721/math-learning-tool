"""Web 讲解（LLM 写码）的可核查契约与门禁——纯静态，不需要浏览器。

模型直接写 HTML 抬高了表达上限，但拆掉了下限：SceneSpec 那条路上，播放器
**画不出假话**（数量从校验过的单位展开，算不出的曲线宁可报错也不画）；
换成模型写码，就没有任何结构性的东西阻止它画 33 个点然后标 35。

Manim 那条敢让模型写码，是因为成片审查会在像素上做连通域计数
（inspect_video._count_units_in_image）。Web 这条更容易查——生成物是标记语言，
不用在 JPEG 里数色块，直接数元素。前提是**生成物必须自述**：

    <article data-explain="1">
      <section data-beat="0" data-teach="先假设全是鸡：35 × 2 = 70">
        <div data-claim="heads=35">
          <span data-unit="head"></span> × 35
        </div>
        <div data-measure="assumed_feet=70"></div>
      </section>
    </article>

门禁只做一件事：**把画面上宣称的每个数，跟独立验证过的 Math IR 对账**。
- `data-claim="x=n"` 的子树里必须真有 n 个 `data-unit`；差一个都不行。
  个体写一个样板加 `data-repeat="n"` 即可，由播放端的可信运行时克隆出 n 个——
  模型不经手实际绘制，数错在构造上不可能发生。仍然禁止用脚本造元素：
  门禁是静态解析，脚本造出来的它看不见，允许脚本生成等于把这条规则整个让掉。
- 验证过的解出现在画面上时，值必须一致——答案不许画错。
- 没有任何 unit/measure = 纯文字，直接拒（与 meaningless_visual_candidate 同口径）。
- 外部资源一律拒：内网部署 + 沙箱 iframe，拉不到也不该拉。

失败不是「扣分」而是「打回重写」，和 Manim 通道的契约重试同一个语义。
"""

from __future__ import annotations

import html.parser
import math
import re
from dataclasses import dataclass, field
from typing import Any

#: 一个可数个体
ATTR_UNIT = "data-unit"
#: 「这个个体重复 N 遍」。写在 data-unit 元素上，由播放端的可信运行时展开。
#:
#: 为什么要有它：一开始要求把 N 个个体逐个字面写出来，实测三次生成全部被输出
#: 长度上限截断（8192 token ≈ 12k 字符，35 个个体加样式就到顶了），还出现过
#: 「宣称 35、写了 45」的数错。改成声明重复数之后，个体由可信运行时按这个数
#: 克隆——数错在构造上不可能发生，输出也小了几倍。
#: 真实性没有让步：门禁核对 data-repeat 与 data-claim 是否一致，
#: 运行时保证画出来的个数严格等于 data-repeat，两头都不经过模型的手。
ATTR_REPEAT = "data-repeat"
#: 一处数量宣称：`名字=数值`，子树内的 data-unit 数必须等于它
ATTR_CLAIM = "data-claim"
#: 一处量的宣称（长度/大小类，不可数）：`名字=数值`
ATTR_MEASURE = "data-measure"
#: 一拍
ATTR_BEAT = "data-beat"
#: 这一拍讲的那句话
ATTR_TEACH = "data-teach"
#: 根节点标记
ATTR_ROOT = "data-explain"

_NAME_VALUE = re.compile(r"^\s*([A-Za-z_][\w\-]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*$")
#: 允许的内联资源协议（data: 用于内嵌小图；其余外链一律拒）
_EXTERNAL = re.compile(r"""\b(?:src|href)\s*=\s*["']?\s*(?!#|data:)([a-zA-Z]+:)?//""", re.I)
_SCRIPT_NET = re.compile(r"\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(", re.I)
#: 用脚本造 DOM。门禁是静态解析，脚本造出来的个体它看不见——
#: 于是「宣称多少就得画出多少」这条会被整个绕过。计数元素必须字面写在标记里。
_SCRIPT_BUILD = re.compile(
    r"\b(?:createElement|innerHTML|insertAdjacentHTML|outerHTML|cloneNode)\b", re.I
)


@dataclass
class ClaimNode:
    """一处宣称，以及它子树里实际数出来的个体数。"""

    name: str
    value: float
    counted: int = 0
    beat: int | None = None


@dataclass
class GateReport:
    """分级判定：能确证的假话是错误，说不清来路的只是警告。

    二元判定在这里是有害的——门禁太松放走假画面，太严则掐掉推理本身
    （假设法里的 70 = 35 × 2 是必须画出来的中间量，它并不在 Math IR 里）。
    分级同时也是更好的训练信号：将来要拿这些记录训模型，需要的是梯度不是开关。
    """

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: 已验证证据里出现过的数值（不参与判定，落进数据集供日后分析/训练）
    known_numbers: list[float] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "known_numbers": list(self.known_numbers),
        }


@dataclass
class ParsedExplanation:
    beats: list[dict[str, Any]] = field(default_factory=list)
    claims: list[ClaimNode] = field(default_factory=list)
    measures: list[tuple[str, float, int | None]] = field(default_factory=list)
    units_total: int = 0
    has_root: bool = False


class _Parser(html.parser.HTMLParser):
    """按标签嵌套统计：一个 data-unit 归属于所有把它包住的 data-claim。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out = ParsedExplanation()
        # 栈里放 (tag, 本元素开启的 claim 序号列表, 本元素的 beat)
        self._stack: list[tuple[str, list[int], int | None]] = []
        self._void = {
            "area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "source", "track", "wbr",
        }

    def _current_beat(self) -> int | None:
        for _, _, beat in reversed(self._stack):
            if beat is not None:
                return beat
        return None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        opened: list[int] = []
        beat: int | None = None

        if ATTR_ROOT in a:
            self.out.has_root = True

        if ATTR_BEAT in a:
            try:
                beat = int(str(a[ATTR_BEAT]).strip())
            except ValueError:
                beat = None
            if beat is not None:
                self.out.beats.append({"index": beat, "teach": a.get(ATTR_TEACH, "").strip()})

        if ATTR_CLAIM in a:
            parsed = _NAME_VALUE.match(a[ATTR_CLAIM])
            if parsed:
                self.out.claims.append(
                    ClaimNode(
                        name=parsed.group(1),
                        value=float(parsed.group(2)),
                        beat=beat if beat is not None else self._current_beat(),
                    )
                )
                opened.append(len(self.out.claims) - 1)

        if ATTR_MEASURE in a:
            parsed = _NAME_VALUE.match(a[ATTR_MEASURE])
            if parsed:
                self.out.measures.append(
                    (
                        parsed.group(1),
                        float(parsed.group(2)),
                        beat if beat is not None else self._current_beat(),
                    )
                )

        if ATTR_UNIT in a:
            # 声明了重复数就按重复数计；没声明就是它自己一个
            repeat = 1
            if ATTR_REPEAT in a:
                try:
                    repeat = int(float(str(a[ATTR_REPEAT]).strip()))
                except ValueError:
                    repeat = 1
                repeat = max(0, repeat)
            self.out.units_total += repeat
            # 归属给所有祖先 claim（含本元素自己开的，允许 claim 与 unit 同元素）
            for _, claim_ids, _ in self._stack:
                for cid in claim_ids:
                    self.out.claims[cid].counted += repeat
            for cid in opened:
                self.out.claims[cid].counted += repeat

        if tag not in self._void:
            self._stack.append((tag, opened, beat))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        # 自闭合标签不进栈，handle_starttag 里已按 void 处理

    def handle_endtag(self, tag: str) -> None:
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                del self._stack[i:]
                return


def parse_web_explanation(markup: str) -> ParsedExplanation:
    parser = _Parser()
    parser.feed(markup or "")
    parser.close()
    return parser.out


def _verified_numbers(evidence: Any, request: Any) -> set[float]:
    """已验证证据里出现过的数值：画面上的数只能从这里来。

    取 claims 的两端与 operations 的结果——它们都是 SymPy 真算过的。
    题面里的已知量经由 solve 的 expression 进入 request，一并收进来。
    """
    found: set[float] = set()

    def absorb(value: Any) -> None:
        if isinstance(value, bool):
            return
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            found.add(float(value))
            return
        if isinstance(value, str):
            for token in re.findall(r"-?\d+(?:\.\d+)?", value):
                try:
                    found.add(float(token))
                except ValueError:
                    continue
            return
        if isinstance(value, dict):
            for item in value.values():
                absorb(item)
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                absorb(item)

    if isinstance(evidence, dict):
        absorb(evidence.get("claims"))
        absorb(evidence.get("operations"))
    if isinstance(request, dict):
        absorb(request.get("operations"))
        absorb(request.get("claims"))
    return found


def solved_values(evidence: Any) -> dict[str, float]:
    """已验证解里每个符号的值：{"chickens": 23.0, "rabbits": 12.0}。

    这是画面唯一必须逐字对上的东西。中间量（假设法的 70、缺口 24）是教学过程，
    它们不在 Math IR 里也理应不在——曾经想用"四则闭包能不能推出来"兜底，
    实测两步组合几乎能凑出任何小整数，那种检查看着在把关、实际什么也没拦住。
    与其留一条假门禁，不如只守住真正致命的那条：**答案不许画错**。
    """
    out: dict[str, float] = {}

    def absorb(mapping: Any) -> None:
        if not isinstance(mapping, dict):
            return
        for key, value in mapping.items():
            if not isinstance(key, str):
                continue
            try:
                out.setdefault(key, float(str(value)))
            except (TypeError, ValueError):
                continue

    if isinstance(evidence, dict):
        for operation in evidence.get("operations") or []:
            if not isinstance(operation, dict):
                continue
            result = operation.get("result")
            if isinstance(result, dict):
                absorb(result)
            elif isinstance(result, list):
                for item in result:
                    absorb(item)
    return out


def verify_web_explanation(
    markup: str,
    evidence: Any = None,
    request: Any = None,
    *,
    min_beats: int = 2,
) -> GateReport:
    """把画面上宣称的每个数跟已验证的数学对账。"""
    report = GateReport()
    findings = report.errors
    text = markup or ""

    if not text.strip():
        report.errors.append("生成物为空")
        return report

    # ── 自足性：内网部署 + 沙箱，外链既拉不到也不该拉 ──
    if _EXTERNAL.search(text):
        findings.append("引用了外部资源（src/href 指向外站）：讲解必须自足")
    if _SCRIPT_NET.search(text):
        findings.append("脚本里出现网络调用（fetch/XHR/WebSocket）：讲解不得联网")

    parsed = parse_web_explanation(text)

    if not parsed.has_root:
        findings.append(f"缺少根标记 {ATTR_ROOT}")
    # 截断是硬伤：残缺的 HTML 渲染出来是半张图，而且此前有一次恰好断在
    # 单位画完之后、门禁还判它通过——放走一个残缺页面比判错更糟。
    if "<article" in text.lower() and "</article" not in text.lower():
        findings.append("输出被截断（缺少 </article> 收尾）：请把页面写短些再输出完整")

    # ── 必须真的有图形，不能是一篇作文 ──
    if parsed.units_total == 0 and not parsed.measures:
        findings.append("没有任何可数个体或量：这是纯文字，不是图形讲解")

    # ── 分拍与教学句 ──
    if len(parsed.beats) < min_beats:
        findings.append(f"只有 {len(parsed.beats)} 拍，至少要 {min_beats} 拍（过程必须分步可见）")
    for beat in parsed.beats:
        if not beat["teach"]:
            findings.append(f"第 {beat['index']} 拍没有 {ATTR_TEACH}：这一拍在讲什么必须说清")

    # ── 核心：宣称多少，就得真的画出多少 ──
    for claim in parsed.claims:
        expected = claim.value
        if abs(expected - round(expected)) > 1e-9:
            findings.append(f"{claim.name} 宣称 {expected}：可数的个体数必须是整数")
            continue
        if int(round(expected)) != claim.counted:
            hint = ""
            if claim.counted == 0 and _SCRIPT_BUILD.search(text):
                # 最常见的写法错误：用脚本批量造元素。静态门禁看不见它们，
                # 于是这条最要紧的规则被整个绕过——必须字面写出来。
                hint = "；个体不能用脚本生成，必须逐个字面写在标记里"
            findings.append(
                f"{claim.name} 标着 {int(round(expected))}，画面上只有 {claim.counted} 个"
                f"（{ATTR_CLAIM} 的子树里必须真有那么多 {ATTR_UNIT}{hint}）"
            )

    # ── 答案不许画错：验证过的解里有这个符号，画面上标的值就必须等于它 ──
    solved = solved_values(evidence)
    if solved:
        shown = {c.name: c.value for c in parsed.claims}
        shown.update({m[0]: m[1] for m in parsed.measures})
        for name, truth in solved.items():
            if name in shown and abs(shown[name] - truth) > 1e-6:
                findings.append(
                    f"{name} 画成了 {shown[name]:g}，验证过的解是 {truth:g}：答案不许画错"
                )
        if not any(name in shown for name in solved):
            report.warnings.append(
                "画面上没有出现验证过的解（"
                + "、".join(f"{k}={v:g}" for k, v in solved.items())
                + "）：讲解应当把答案画出来，而不只是叙述"
            )

    # 题面里出现过的量（供数据集分析用，不参与判定）
    report.known_numbers = sorted(_verified_numbers(evidence, request))
    return report
