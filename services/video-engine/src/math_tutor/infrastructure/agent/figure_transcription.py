"""原图转写：把讲义照片上的几何图量成结构化描述，供各形式**重画**。

产品决定（2026-08-15）：有原图的题，讲解不把照片贴进产物（截图配不上
动画的画风），而是**按各自的形式重画**——SceneSpec 画 SceneSpec 的、
Manim 画 Manim 的、HTML 画 SVG 的。

重画的真实性靠两条腿：
① 转写是**测量**，不是理解——只记录图上看得见的：顶点字母、归一化坐标、
   连边、阴影。不推理、不补全、不引入题干知识；
② 图形对象由**引擎代码**按转写确定性构造并注入画面计划，模型只做注解，
   坐标不经它的手——一致性是构造出来的，不是核对出来的
   （与 web 讲解"原图当底图"同一哲学，只是底图换成了转写）。

坐标约定：转写用**图像坐标**（左上原点、y 向下、0~1 归一化）；
转成绘图规格时统一翻转为数学坐标（y 向上），下游渲染器都认后者。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ...application.interfaces import ChatMessage

logger = logging.getLogger(__name__)

TRANSCRIBE_SYSTEM = "你在把几何图转写成结构数据。只输出一个 JSON 对象，不要解释。"

TRANSCRIBE_PROMPT = """这张图里有一个几何图形。把它**转写**成结构数据——只记录看得见的，\
不要推理、不要补全、不要引入图上没有的信息。

输出一个 JSON 对象（不要围栏）：
{"points":[{"id":"A","x":0.36,"y":0.23}, ...],
 "segments":[["A","B"],["B","C"], ...],
 "shaded":[["E","D","F","B"]]}

规则：
- points：每个**标了字母**的点。x、y 是该字母所指的点在图中的位置，
  取值 0~1（左上角是 0,0，x 向右、y 向下）。位置尽量量准——下游照它重画；
- segments：图中实际画出的线段（含对角线、辅助线），端点用字母；
- shaded：阴影/深色区域，按顶点顺序列出字母环；没有阴影就给空数组 []；
- 没标字母的点不要编造字母；看不清的部分宁可省略。"""

#: 转写里合法的点名：一两个字符（字母，可带撇号/下标数字）
_ID_RE = re.compile(r"^[A-Za-z]['′]?\d?$")


def parse_transcription(raw: str) -> dict[str, Any] | None:
    """解析并逐项校验转写。垃圾进来宁可返回 None——画错图比不画更糟。"""
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None

    points: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in obj.get("points") or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip()
        try:
            x, y = float(p.get("x")), float(p.get("y"))
        except (TypeError, ValueError):
            continue
        # 越界坐标是幻觉的标志；重复字母则两处必有一错——都整点丢弃
        if not _ID_RE.match(pid) or pid in seen or not (0 <= x <= 1 and 0 <= y <= 1):
            continue
        seen.add(pid)
        points.append({"id": pid, "x": round(x, 4), "y": round(y, 4)})
    if len(points) < 3:
        return None  # 两个点不成图形；转写不出三个点就当没转出来

    def known_cycle(cycle: Any, at_least: int) -> list[str] | None:
        if not isinstance(cycle, (list, tuple)) or len(cycle) < at_least:
            return None
        ids = [str(c).strip() for c in cycle]
        return ids if all(i in seen for i in ids) else None

    segments = [c for c in (known_cycle(s, 2) for s in obj.get("segments") or []) if c]
    shaded = [c for c in (known_cycle(s, 3) for s in obj.get("shaded") or []) if c]
    return {"points": points, "segments": segments, "shaded": shaded}


def transcription_summary(t: dict[str, Any]) -> str:
    """给提示词看的紧凑摘要（人也读得懂，进日志/语料都干净）。"""
    pts = "、".join(f"{p['id']}({p['x']:.2f},{p['y']:.2f})" for p in t["points"])
    segs = "、".join("-".join(s) for s in t["segments"]) or "（无）"
    shade = "、".join("-".join(s) for s in t["shaded"]) or "（无）"
    return f"顶点（图像坐标，y 向下）：{pts}；线段：{segs}；阴影区域：{shade}"


def to_figure_params(t: dict[str, Any]) -> dict[str, Any]:
    """转写 → 绘图规格参数（FigureSpec 形状：锚点坐标 + 线段 + 阴影多边形）。

    在这里统一把图像坐标翻成数学坐标（y 向上）；下游渲染器只认数学坐标。
    """
    return {
        "points": [{"id": p["id"], "at": [p["x"], round(1 - p["y"], 4)]} for p in t["points"]],
        "segments": [{"from": s[0], "to": s[1]} for s in t["segments"] if len(s) == 2],
        "polygons": [{"points": list(cycle), "shaded": True} for cycle in t["shaded"]],
    }


def figure_object(t: dict[str, Any]) -> dict[str, Any]:
    """按转写构造 SceneSpec 的图形对象。**由引擎注入，不让模型写**。"""
    return {
        "id": "original_figure",
        "primitive": "figure",
        "params": to_figure_params(t),
        "meaning": "讲义原图（按转写重画）",
    }


#: 有转写时**禁止**模型自由画几何——这些图元一律剥掉。
#: 实机教训：导演给注解三角形编了自己的坐标，叠在真图上互相打架（"乱做题"）。
#: 注解必须用 figure_ops 指着字母说话，坐标由转写解析，模型无权持有坐标。
_FREE_GEOMETRY = {"polygon", "line", "arrow", "dot"}

#: 有图的题里同样要剥掉的"图外数量图标"。实机教训：面积 12/16 被画成
#: 两堆小方块摆在图旁边——面积属于图上的区域，数值该写在区域重心里；
#: 一堆方块既不是那块面积，也让孩子的视线离开真正要看的图。
_OFF_FIGURE_QUANTITY = {"unit_grid", "quantity_bar"}


def _centroid(names: list[str], pts: dict[str, list[float]]) -> list[float]:
    xs = [pts[n][0] for n in names]
    ys = [pts[n][1] for n in names]
    return [round(sum(xs) / len(xs), 4), round(sum(ys) / len(ys), 4)]


def figure_ops_violations(plan: dict[str, Any]) -> list[str]:
    """有原图的计划必须在图上表达——一条 figure_ops 都没有就打回。

    这是给结构契约重试用的判据：模型的数量本能（方块阵、数量条）会把
    面积搬到图外去，这里逼它回到图上。剥图元是兜底，教会模型才是目的。
    """
    scenes = [s for s in plan.get("scenes") or [] if isinstance(s, dict)]
    if not scenes:
        return []
    if not any(s.get("figure_ops") for s in scenes):
        return [
            "有原图的题必须用 figure_ops 在图上表达：面积/长度这类属于图上区域的数量，"
            "用 highlight_region 把数值写进区域重心——不要在图外摆方块阵，面积不是一堆小方块"
        ]
    return []


def filter_figure_plan_errors(errors: list[str], plan: dict[str, Any]) -> list[str]:
    """带图计划的契约语境：部分通用规则不适用，逐条豁免并写明理由。

    - 「至少 2 个对象」：只声明底图是合规形态，结论算式框入库时自动补齐；
    - 「transform 场景必须有结构化动作」：带图计划的状态变化就是 figure_ops
      （高亮/辅助线），actions 只是节拍器——transform 拍带 ops 即视为有变化。
    """
    out = [e for e in errors if "至少需要 2 个" not in e]
    transforms = [
        s
        for s in plan.get("scenes") or []
        if isinstance(s, dict) and str(s.get("role")) == "transform"
    ]
    if transforms and all(s.get("figure_ops") for s in transforms):
        out = [e for e in out if "transform 场景" not in e]
    return out


def choreograph_figure(plan: dict[str, Any], t: dict[str, Any]) -> dict[str, Any]:
    """把导演的「指字母」编排解析成确定坐标的画面对象。

    导演在每拍写 figure_ops（只有字母，没有坐标）：
      {"op":"highlight_region","points":["E","B","D"],"label":"12"}
      {"op":"draw_segment","from":"B","to":"D","label":"辅助线"}
    这里逐条解析：字母 → 转写坐标 → 该拍的 overlay figure 对象 + create 动作。
    指了不存在的字母就丢那一条并留痕——图不会歪，只会少一个注解。
    同时**剥掉**模型自由画的几何图元：坐标只此一家。
    """
    pts = {p["id"]: [p["x"], round(1 - p["y"], 4)] for p in t["points"]}

    banned = _FREE_GEOMETRY | _OFF_FIGURE_QUANTITY
    stripped = [
        str(o.get("id"))
        for o in plan.get("visual_objects") or []
        if isinstance(o, dict) and o.get("primitive") in banned
    ]
    if stripped:
        logger.info("figure choreography: 剥掉模型自由画的几何对象 %s", stripped)
        plan["visual_objects"] = [
            o
            for o in plan.get("visual_objects") or []
            if not (isinstance(o, dict) and o.get("primitive") in banned)
        ]
        # 引用被剥对象的动作一并清掉，别让空指针传到渲染端
        gone = set(stripped)
        for scene in plan.get("scenes") or []:
            if isinstance(scene, dict):
                scene["actions"] = [
                    a
                    for a in scene.get("actions") or []
                    if not (
                        isinstance(a, dict)
                        and (
                            a.get("target") in gone
                            or set(a.get("targets") or []) & gone
                        )
                    )
                ]

    dropped_ops: list[str] = []
    previous_overlay: str | None = None
    for index, scene in enumerate(plan.get("scenes") or []):
        if not isinstance(scene, dict):
            continue
        ops = scene.pop("figure_ops", None) or []
        overlay_points: dict[str, list[float]] = {}
        segments: list[dict[str, Any]] = []
        polygons: list[dict[str, Any]] = []
        for op in ops:
            if not isinstance(op, dict):
                continue
            kind = str(op.get("op") or "")
            if kind == "highlight_region":
                names = [str(n) for n in op.get("points") or []]
                if len(names) >= 3 and all(n in pts for n in names):
                    poly: dict[str, Any] = {"points": names, "shaded": True}
                    label = str(op.get("label") or "").strip()
                    if label:
                        poly["label"] = label
                    polygons.append(poly)
                    for n in names:
                        overlay_points[n] = pts[n]
                else:
                    dropped_ops.append(f"beat{index}:{kind}:{','.join(names)}")
            elif kind == "draw_segment":
                a, b = str(op.get("from") or ""), str(op.get("to") or "")
                if a in pts and b in pts:
                    seg: dict[str, Any] = {"from": a, "to": b}
                    label = str(op.get("label") or "").strip()
                    if label:
                        seg["label"] = label
                    segments.append(seg)
                    overlay_points[a] = pts[a]
                    overlay_points[b] = pts[b]
                else:
                    dropped_ops.append(f"beat{index}:{kind}:{a}-{b}")
            else:
                dropped_ops.append(f"beat{index}:{kind or '?'}")
        if not overlay_points:
            continue
        overlay_id = f"figure_overlay_{index}"
        # 每拍一个专属色：孩子能看出"现在讲的是哪一块"；同色叠加只会糊成一片
        tone = ["gold", "blue", "orange", "green", "purple"][index % 5]
        for poly in polygons:
            poly["tone"] = tone
        plan.setdefault("visual_objects", []).append(
            {
                "id": overlay_id,
                "primitive": "figure",
                "params": {
                    "points": [{"id": n, "at": at} for n, at in overlay_points.items()],
                    "segments": segments,
                    "polygons": polygons,
                },
                "meaning": f"第{index}拍的图上注解",
            }
        )
        actions = scene.setdefault("actions", [])
        if isinstance(actions, list):
            # 新拍高亮出场时，上一拍的高亮退场——按步骤表达，当前拍才是焦点。
            # 只退 overlay，底图永远在场
            if previous_overlay is not None:
                actions.insert(
                    0,
                    {"op": "remove", "targets": [previous_overlay], "target": previous_overlay},
                )
            actions.insert(0, {"op": "create", "targets": [overlay_id], "target": overlay_id})
        previous_overlay = overlay_id
    if dropped_ops:
        logger.warning("figure choreography: 指了不存在的字母，丢弃 %s", dropped_ops[:6])
    return plan


def inject_figure_object(plan: dict[str, Any], t: dict[str, Any]) -> dict[str, Any]:
    """把按转写构造的图形对象**确定性**写进画面计划。

    模型被告知声明一个空参数的占位对象；这里用真实坐标覆盖它——
    坐标从不经模型的手。模型忘了声明也没关系：补插对象 + 第一拍 create，
    图一定在场。模型多画的 figure 对象一律删掉，孩子不该看到两张图。
    """
    injected = figure_object(t)
    objects = [o for o in plan.get("visual_objects") or [] if isinstance(o, dict)]
    kept: list[dict[str, Any]] = []
    replaced = False
    removed: set[str] = set()
    for obj in objects:
        # 编排产生的 overlay 是合法的第二类 figure 对象，不参与"只留一张底图"的去重
        if str(obj.get("id") or "").startswith("figure_overlay_"):
            kept.append(obj)
            continue
        is_figure = obj.get("primitive") == "figure" or obj.get("id") == "original_figure"
        if not is_figure:
            kept.append(obj)
        elif not replaced:
            kept.append({**obj, **injected})
            replaced = True
        else:
            # 第二个及以后的 figure 对象（模型自declare的 region_* 之类）：丢弃并记名
            removed.add(str(obj.get("id")))
    if not replaced:
        kept.insert(0, injected)
    plan["visual_objects"] = kept

    # 引用被删对象的动作改指底图——留着空引用，编译时拍子会被整个丢掉，
    # IR 判不可用后整段编排退成静态保底（实机：质检因此判 bad）
    if removed:
        for scene in plan.get("scenes") or []:
            if not isinstance(scene, dict):
                continue
            for action in scene.get("actions") or []:
                if not isinstance(action, dict):
                    continue
                targets = [str(t) for t in (action.get("targets") or [])]
                if set(targets) & removed:
                    fixed = [t for t in targets if t not in removed]
                    if "original_figure" not in fixed:
                        fixed.append("original_figure")
                    action["targets"] = fixed
                if str(action.get("target")) in removed:
                    action["target"] = "original_figure"

    scenes = [s for s in plan.get("scenes") or [] if isinstance(s, dict)]
    shown = any(
        a.get("target") == "original_figure" or "original_figure" in (a.get("targets") or [])
        for s in scenes
        for a in (s.get("actions") or [])
        if isinstance(a, dict)
    )
    if scenes and not shown:
        first = scenes[0].setdefault("actions", [])
        if isinstance(first, list):
            # targets（复数）是导演/编译器的正式字段，target 单数是播放器的宽容写法。
            # 两个都带：Manim 确定性编译器**只认 targets**，少了它注入的图会被静默丢掉
            first.insert(
                0,
                {"op": "create", "targets": ["original_figure"], "target": "original_figure"},
            )
    return plan


async def transcribe_figure(llm: Any, figure_image: str) -> dict[str, Any] | None:
    """跑一趟视觉转写；任何失败返回 None（调用方按'没有转写'继续，绝不拦路）。"""
    if not figure_image.startswith("data:image/"):
        return None
    # provider 只认 ChatMessage 对象（裸 dict 会在 _to_openai_messages 炸掉——实机踩过）
    messages = [
        ChatMessage(role="system", content=TRANSCRIBE_SYSTEM),
        ChatMessage(
            role="user",
            content=[
                {"type": "text", "text": TRANSCRIBE_PROMPT},
                {"type": "image_url", "image_url": {"url": figure_image}},
            ],
        ),
    ]
    try:
        done = await llm.chat_complete(messages=messages, max_tokens=1024)
    except Exception:  # noqa: BLE001 — 转写失败只降级，不中断讲解
        logger.exception("figure transcription failed")
        return None
    parsed = parse_transcription(getattr(done, "text", "") or "")
    if parsed is None:
        logger.warning("figure transcription unparsable: %s", (getattr(done, "text", "") or "")[:120])
    else:
        logger.info("figure transcription: %s", transcription_summary(parsed))
    return parsed
