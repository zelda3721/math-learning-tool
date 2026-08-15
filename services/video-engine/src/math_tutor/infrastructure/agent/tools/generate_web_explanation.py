"""generate_web_explanation — 让模型直接写 Web 讲解页面，由门禁把住真实性。

与 Manim 通道的 model_codegen 同构：模型写码、门禁判定、不过就带着违规清单重写。
差别在于这条路的门禁**更严**——生成物是标记语言，可以直接数元素，
不必像成片审查那样在 JPEG 里做连通域计数。

不重试到天荒地老：每一轮都把违规清单原样喂回去，超过上限就诚实失败。
一份画着假数字的讲解比没有讲解糟糕得多。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from ..figure_transcription import transcribe_figure
from ..prompt_library import PromptLibrary
from ..web_explanation_contract import (
    ATTR_FIGURE,
    FIGURE_ORIGINAL,
    FIGURE_PLACEHOLDER,
    FIGURE_TEACHER,
    TEACHER_PLACEHOLDER,
    GateReport,
    verify_web_explanation,
)

logger = logging.getLogger(__name__)

#: 契约不过时最多重写几次（含首稿共 1 + MAX_REWRITES 次生成）
MAX_REWRITES = 2

# 这个工具写的是全引擎最长的产物：自足 HTML 页（样式 + SVG + 分拍注解 + 脚本），
# 思考型模型（Qwen3.5+）的推理 token 还要从同一份预算里扣 2000-3500。
# 此前没传 max_tokens、掉进 .env 的全局 4096：每一稿都在 </article> 之前被截断，
# extract_html 抠不出完整片段 → 门禁数出 0 拍 → 打回重写又撞同一面墙，
# 一次讲解白烧三稿共 7 分钟。其它重活工具（solve 6144、Manim codegen 5120）
# 都自带预算，这里同理。
WEB_EXPLANATION_MAX_TOKENS = 8192

_FENCE = re.compile(r"```(?:html)?\s*(.*?)```", re.S | re.I)
_ARTICLE = re.compile(r"<article\b.*?</article\s*>", re.S | re.I)


def extract_html(text: str) -> str:
    """从模型回复里取出 HTML 片段。

    本地模型常见三种包法：裸片段、markdown 围栏、片段前后带一段说明。
    一律先找 `<article>…</article>`——契约要求根节点就是它，这比剥围栏更可靠。
    """
    if not text:
        return ""
    article = _ARTICLE.search(text)
    if article:
        return article.group(0).strip()
    fenced = _FENCE.search(text)
    if fenced:
        inner = fenced.group(1).strip()
        nested = _ARTICLE.search(inner)
        return (nested.group(0) if nested else inner).strip()
    return text.strip()


def _steps_text(steps: Any) -> str:
    if isinstance(steps, list):
        lines = [f"{i + 1}. {str(s).strip()}" for i, s in enumerate(steps) if str(s).strip()]
        return "\n".join(lines) if lines else "（无）"
    return str(steps or "（无）")


def _evidence_text(evidence: Any) -> str:
    if not isinstance(evidence, dict):
        return "（无）"
    trimmed = {
        key: evidence.get(key)
        for key in ("operations", "claims", "all_claims_passed")
        if evidence.get(key) is not None
    }
    try:
        return json.dumps(trimmed, ensure_ascii=False, indent=1)[:2500]
    except (TypeError, ValueError):  # pragma: no cover
        return "（无）"


#: 有原图时追加进提示词的那一段。
#:
#: 讲解要与原图一致，靠的不是事后比对两张图"像不像"（没有可靠办法），
#: 而是不给重画的机会：讲义上那张图就是底图，注解叠在它上面。
#: 图的真实内容是几十 KB base64，不让模型经手——它只写占位符，引擎事后替换。
def figure_note(width: int, height: int) -> str:
    """有原图时追加进提示词的那一段。

    讲解要与原图一致，靠的不是事后比对两张图"像不像"（没有可靠办法），
    而是不给重画的机会：讲义上那张图就是底图，注解叠在它上面。
    图的真实内容是几十 KB base64，不让模型经手——它只写占位符，引擎事后替换。

    **坐标系用图的真实像素**。曾让它用 0~100 的百分比配
    `preserveAspectRatio="none"`，结果 svg 把里面的文字和线宽一起拉变形——
    实测标签大到盖住半张图，怎么改措辞都不稳。把真实尺寸告诉它，
    viewBox 与图 1:1 对应，就没有任何拉伸，字号也回到正常语义。
    """
    return f"""
# 这道题有讲义上的原图（已随本次请求发给你，就在下面）

**不许自己重画这个图形。** 原图就是舞台的底，注解叠在它上面；
分拍切换的是**注解层**，不是图——图从头到尾只有一张，一直在那儿：

```
<article data-explain="1">
  <div style="position:relative;display:inline-block;max-width:100%">
    <img {ATTR_FIGURE}="{FIGURE_ORIGINAL}" src="{FIGURE_PLACEHOLDER}" style="display:block;width:100%">
    <svg viewBox="0 0 {width} {height}"
         style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
      <g data-beat="0" data-teach="已知：上底 6、下底 10、面积 48">
        …这一拍的高亮/箭头/辅助线…
        <text data-measure="area=48" x="…" y="…" font-size="{max(10, height // 22)}">48 平方厘米</text>
      </g>
      <g data-beat="1" data-teach="反过来求高：48 × 2 ÷ (6 + 10) = 6">…</g>
    </svg>
  </div>
  <p id="teach"></p>       ← 脚本把当前拍的 data-teach 写进来
  <script> …切换哪一组 g 可见… </script>
</article>
```

- **这张图是 {width} × {height} 像素，viewBox 就照这个写**，坐标直接用图上的像素位置。
  这样 svg 与原图 1:1 重合，不会有任何拉伸变形。字号用 {max(10, height // 22)} 上下。
- `src` 就原样写 `{FIGURE_PLACEHOLDER}` 这几个字，**不要换成别的东西**，
  真正的图由系统在你输出之后填进去。
- **原图只出现一次**。别在每一拍里各放一张——那不是分拍，那是把同一张图铺了好几遍。
- **每一拍必须是一个真的带 `data-beat` 和 `data-teach` 属性的元素**（就像上面那两个 g）。
  用 CSS 类名（`.beat-0`、`.beat-1`）在舞台上切状态**不算分拍**——
  核对是静态读属性的，读不到属性就等于你一拍都没写。
- 你看得见这张图，所以注解要标在对的位置上：哪条边、哪个角、哪块面积，
  坐标对着原图量。高亮一块面积要用 `<polygon>` 贴着图形的边画，别拿个矩形糊上去。
- 几何题的"画出来"是**量**不是个数：边长、面积、高，用 `data-measure="名字=数值"`
  标在注解上，并且让它在画面上真的可比（高亮那条边、给那块面积上色）。
  一个 data-measure 都没有会被判成纯文字。
- 重画一张"差不多"的图是最坏的做法——孩子手上的题目是那张原图，
  两张对不上的时候他会以为自己看错了题。
"""


def build_rewrite_note(report: GateReport, attempt: int) -> str:
    """把门禁的判定原样喂回去——模型改不动它看不见的东西。"""
    lines = [
        f"# 第 {attempt} 稿没有通过契约门禁，请修改后重新输出完整 HTML",
        "",
        "**必须修掉（否则继续打回）**：",
    ]
    lines.extend(f"- {item}" for item in report.errors)
    if report.warnings:
        lines.append("")
        lines.append("**建议一并处理**：")
        lines.extend(f"- {item}" for item in report.warnings)
    lines.extend(
        [
            "",
            "注意：`data-claim=\"名字=数值\"` 的子树里必须真的写出那么多 `data-unit` 元素；",
            "用 CSS 重复、伪元素或「× 35」这样的文字代替，都会被判为没画出来。",
            "只输出 HTML，不要解释。",
        ]
    )
    return "\n".join(lines)


def figure_size(data_url: str) -> tuple[int, int]:
    """读出原图的像素尺寸；读不出就给一个方形缺省（宁可坐标不精确，也不失败）。"""
    try:
        import base64
        import io

        from PIL import Image

        raw = base64.b64decode(data_url.split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as img:
            return int(img.width), int(img.height)
    except Exception:  # noqa: BLE001 — 尺寸只影响注解坐标，不值得让讲解失败
        logger.warning("读不出原图尺寸，注解坐标按 1000×700 估算")
        return 1000, 700


TEACHER_NOTE = f"""
# 讲义里老师画了一张解法图（也随本次请求发给你，是第二张）

这是**真人老师**画的数形结合：割补怎么割、阴影怎么挪、辅助线画在哪。
它比你自己想的可靠，所以：

- **参考它的思路**。老师用哪个关系让答案变得显然，你的动画就讲哪个关系。
- **在最后一拍把它展示出来**，让孩子对得上讲义：
  `<img {ATTR_FIGURE}="{FIGURE_TEACHER}" src="{TEACHER_PLACEHOLDER}" style="max-width:100%">`
  src 同样原样写占位符，真正的图由系统事后填入。
- 前面几拍仍然是你自己的动画（可拨、分步），老师那张图只是最后的"标准画法"。
  不要用它代替讲解——它是一张静态图，讲不出过程。
"""


def figure_redraw_note(transcription: dict[str, Any], width: int, height: int) -> str:
    """有转写时的作图指令：按转写重画 SVG，不贴照片。

    产品定案（2026-08-15）：截图配不上讲解的画风——原图只做**基准**，
    页面用 SVG 原生重画。坐标由转写换算成像素直接给到模型，照抄即可；
    门禁会核对顶点字母一个不少、并拒绝任何贴进来的照片。
    """
    w = max(width, 1)
    h = max(height, 1)
    # 转写坐标是 0~1（左上原点、y 向下）——SVG 同向，直接乘画布尺寸
    coords = "、".join(
        f"{p['id']}({round(p['x'] * w)},{round(p['y'] * h)})" for p in transcription["points"]
    )
    segments = "、".join("-".join(s) for s in transcription["segments"]) or "（无）"
    shaded = "、".join("-".join(s) for s in transcription["shaded"]) or "（无）"
    return f"""
# 这道题有讲义上的原图（已随本次请求发给你，作为重画的基准）

**不要把照片贴进页面**——用 SVG 把这个图形**重画**出来（viewBox 0 0 {w} {h}）。
图形已经替你量好了，坐标照抄，不要自己改：

- 顶点（像素坐标）：{coords}
- 线段：{segments}
- 阴影区域：{shaded}

硬规则：
- 线段用 <line> 或 <path>，阴影区域用 <polygon fill="#888" fill-opacity="0.5">；
- **每个顶点旁边放一个 <text> 写它的字母**——上面列的字母一个都不能少，
  位置放在顶点向图形外侧偏移 12~18px 处，别压在线上；字号 {max(12, h // 28)} 左右；
- 分拍注解（高亮、度量、辅助线）作为 data-beat 的 <g> 层叠加在同一个 SVG 里；
- 台词里点名的字母，以上面这份转写为准。
"""


def _user_message(prompt: str, figure_image: str, teacher_image: str = "") -> ChatMessage:
    """有原图时发多模态消息——模型得看见图，才知道注解该标在哪条边上。"""
    images = [img for img in (figure_image, teacher_image) if img]
    if not images:
        return ChatMessage(role="user", content=prompt)
    return ChatMessage(
        role="user",
        content=[
            {"type": "text", "text": prompt},
            *[{"type": "image_url", "image_url": {"url": img}} for img in images],
        ],
    )


def _inline_figure(markup: str, figure_image: str, teacher_image: str = "") -> str:
    """把占位符换成真正的图。

    没有图却出现了占位符时，把整个 img 去掉——留着就是一张裂图，
    孩子会以为这道题的配图丢了。
    """
    if not markup:
        return markup
    for placeholder, image in ((FIGURE_PLACEHOLDER, figure_image), (TEACHER_PLACEHOLDER, teacher_image)):
        if image:
            markup = markup.replace(placeholder, image)
        else:
            markup = re.sub(rf"<img[^>]*{re.escape(placeholder)}[^>]*>", "", markup, flags=re.I)
    return markup


class GenerateWebExplanationTool(ITool):
    def __init__(self, *, llm: ILLMProvider, prompts: PromptLibrary) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "generate_web_explanation"

    @property
    def description(self) -> str:
        return (
            "让模型直接写一页自足的 Web 动态讲解（HTML+内联 CSS/JS），"
            "由可核查契约门禁把住真实性：宣称的数量必须真的画出来，答案不许画错。"
            "调用前必须已有已验证的 solution_steps / answer。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "extra_directives": {
                    "type": "string",
                    "description": "本次讲解的额外导向（知识点、易错点）",
                },
                "max_rewrites": {
                    "type": "integer",
                    "description": f"契约不过时的重写上限，缺省 {MAX_REWRITES}",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        state = ctx.state
        steps = state.get("solution_steps") or state.get("verified_steps") or []
        answer = state.get("solution_answer") or state.get("answer") or ""
        if not steps and not answer:
            return ToolResult(
                success=False,
                summary="还没有已验证的解，不能写讲解",
                error="missing_verified_solution",
            )

        evidence = state.get("verify_math_evidence") or state.get("solve_math_evidence")
        request = state.get("verify_math_request") or state.get("solve_math_request")

        figure_image = str(state.get("figure_image") or "")
        teacher_image = str(state.get("analysis_image") or "")

        # 原图转写：有图先转写（可能已由视觉导演转过，state 里现成）。
        # 转写成功走重画路线；失败退回"原图当底图"的老路——绝不空手
        transcription = state.get("figure_transcription")
        if not transcription and figure_image.startswith("data:image/"):
            transcription = await transcribe_figure(self._llm, figure_image)
            if transcription:
                state["figure_transcription"] = transcription
        figure_labels = [p["id"] for p in transcription["points"]] if transcription else None

        if figure_image and transcription:
            fig_note = figure_redraw_note(transcription, *figure_size(figure_image))
        elif figure_image:
            fig_note = figure_note(*figure_size(figure_image))
        else:
            fig_note = ""
        base_prompt = self._prompts.render(
            "web_explanation",
            problem=ctx.problem,
            grade=ctx.grade,
            solution_steps=_steps_text(steps),
            answer=str(answer),
            math_evidence=_evidence_text(evidence),
            figure_note=fig_note + (TEACHER_NOTE if teacher_image else ""),
            extra_directives=str(args.get("extra_directives") or ""),
        )

        limit = int(args.get("max_rewrites") or MAX_REWRITES)
        # 把原图一并发过去：模型得看见它，才知道注解该标在哪条边上
        first_message = _user_message(base_prompt, figure_image, teacher_image)
        messages = [first_message]
        artifacts: list[ArtifactSpec] = []
        attempts: list[dict[str, Any]] = []
        best: tuple[str, GateReport] | None = None

        for attempt in range(1, limit + 2):
            reply = await self._llm.chat_complete(
                messages=messages, max_tokens=WEB_EXPLANATION_MAX_TOKENS
            )
            if getattr(reply, "finish_reason", "") == "length":
                # 截断必须留痕：0 拍/缺 article 的真因是"没写完"，
                # 不记这一笔，排查的人只会盯着门禁和提示词打转（实机上就转了一回）
                logger.warning(
                    "web 讲解第 %d 稿被 max_tokens=%d 截断（finish_reason=length）",
                    attempt,
                    WEB_EXPLANATION_MAX_TOKENS,
                )
            markup = extract_html(getattr(reply, "text", "") or "")
            report = verify_web_explanation(
                markup,
                evidence,
                request,
                figure_required=bool(figure_image),
                teacher_figure_available=bool(teacher_image),
                figure_labels=figure_labels,
            )
            attempts.append(
                {
                    "attempt": attempt,
                    "chars": len(markup),
                    "gate": report.as_dict(),
                }
            )
            artifacts.append(
                ArtifactSpec(
                    kind="web_explanation",
                    filename=f"web-explanation-attempt{attempt:02d}.html",
                    content=markup,
                    meta={"attempt": attempt, "gate_ok": report.ok},
                )
            )
            # 留最好的一稿：错误更少者胜，用于诚实降级（绝不交付有错误的那份）
            if best is None or len(report.errors) < len(best[1].errors):
                best = (markup, report)
            if report.ok:
                # 门禁看的是带占位符的那份（小、好读、进语料也干净），
                # 交付前才把真正的图填进去
                markup = _inline_figure(markup, figure_image, teacher_image)
                state["web_explanation_html"] = markup
                state["web_explanation_gate"] = report.as_dict()
                return ToolResult(
                    success=True,
                    summary=(
                        f"Web 讲解已通过契约门禁（第 {attempt} 稿）"
                        + (f"；{len(report.warnings)} 条建议未处理" if report.warnings else "")
                    ),
                    data={
                        "html": markup,
                        "gate": report.as_dict(),
                        "attempts": attempts,
                    },
                    artifacts=artifacts,
                )
            if attempt > limit:
                break
            logger.info(
                "web 讲解第 %d 稿未过门禁，打回重写：%s", attempt, report.errors[:3]
            )
            messages = [
                first_message,
                ChatMessage(role="assistant", content=markup),
                ChatMessage(role="user", content=build_rewrite_note(report, attempt)),
            ]

        markup, report = best if best else ("", GateReport(errors=["未产出任何内容"]))
        markup = _inline_figure(markup, figure_image, teacher_image)
        state["web_explanation_gate"] = report.as_dict()
        return ToolResult(
            success=False,
            summary="Web 讲解连续未通过契约门禁：" + "；".join(report.errors[:3]),
            data={"html": markup, "gate": report.as_dict(), "attempts": attempts},
            artifacts=artifacts,
            error="web_explanation_contract_violation",
        )
