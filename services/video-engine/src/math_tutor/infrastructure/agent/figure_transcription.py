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
import math
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
 "shaded":[["E","D","F","B"]],
 "labels":[{"text":"8cm","x":0.30,"y":0.52,"on":["A","B"]},{"text":"30°","x":0.71,"y":0.80,"on":["B"]},
           {"text":"S=12","x":0.45,"y":0.40,"on":["A","B","E"]}]}

规则：
- points：每个**标了字母**的点。x、y 是该字母所指的点在图中的位置，
  取值 0~1（左上角是 0,0，x 向右、y 向下）。位置尽量量准——下游照它重画；
- segments：图中**实际画出**（有墨迹）的线段，端点用字母。只记录看得见的线：
  题目要"连接"的辅助线、你觉得"应该有"的对角线，图上没画就**不要写**；
- shaded：阴影/深色区域，按顶点顺序列出字母环；没有阴影就给空数组 []；
- labels：图上**写着的**文字标注（边长、角度、面积、比例、"阴影"等），原文照抄到 text；
  x、y 是这段文字本身在图中的位置（同上，0~1）；on 写它标在谁上：一条边写两个字母，
  一个角/顶点写一个字母，一块区域写它的字母环（拿不准就按最像的写，系统会按位置复核）。
  只抄图上印着的字，不要量、不要算；没有就给空数组 []；
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
    labels: list[dict[str, Any]] = []
    for item in obj.get("labels") or []:
        if not isinstance(item, dict):
            continue
        text = " ".join(str(item.get("text") or "").split())[:24]
        on = known_cycle(item.get("on"), 1)
        # 标注必须有字、必须挂在转写出来的字母上；挂错字母的整条丢（不歪图）
        if text and on and len(on) <= 8:
            label: dict[str, Any] = {"text": text, "on": on}
            try:
                lx, ly = float(item.get("x")), float(item.get("y"))
                if 0 <= lx <= 1 and 0 <= ly <= 1:
                    label["at"] = [round(lx, 4), round(ly, 4)]
            except (TypeError, ValueError):
                pass
            labels.append(label)
    return {"points": points, "segments": segments, "shaded": shaded, "labels": labels[:16]}


def transcription_summary(t: dict[str, Any]) -> str:
    """给提示词看的紧凑摘要（人也读得懂，进日志/语料都干净）。"""
    pts = "、".join(f"{p['id']}({p['x']:.2f},{p['y']:.2f})" for p in t["points"])
    segs = "、".join("-".join(s) for s in t["segments"]) or "（无）"
    shade = "、".join("-".join(s) for s in t["shaded"]) or "（无）"
    labels = "、".join(f"{''.join(l['on'])}:{l['text']}" for l in t.get("labels") or []) or "（无）"
    return f"顶点（图像坐标，y 向下）：{pts}；线段：{segs}；阴影区域：{shade}；图上标注：{labels}"


def figure_structure_text(t: dict[str, Any] | None) -> str:
    """几何校准过的转写 → 一句"图形结构"事实（给解题模型）：画了哪些线、谁和谁共线。

    实机：解题模型看图总把 A–F–M、B–F–E 这类线当成对角线 AC、BD，整套推理建在不存在的
    线上。把像素量出的结构明说出来，它就不必猜。只在像素几何校准过（labels 有
    resolved=geometry 或 reconciled 里有校准记录）时输出——没校准的转写不配当事实。
    """
    if not t:
        return ""
    grounded = any(l.get("resolved") == "geometry" for l in t.get("labels") or []) or any(
        "像素" in str(n) for n in t.get("reconciled") or []
    )
    if not grounded:
        return ""
    pts = {p["id"]: (float(p["x"]), float(p["y"])) for p in t.get("points") or []}
    segs = [tuple(sg) for sg in t.get("segments") or [] if len(sg) == 2 and sg[0] in pts and sg[1] in pts]
    if not segs:
        return ""
    edges = {frozenset(sg) for sg in segs}
    # 共线组：三点两两之间的连线都是画出来的、且几乎共线 → 一条直线上的点
    groups: list[set[str]] = []
    names = sorted(pts)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            if frozenset((a, b)) not in edges:
                continue
            for c in names:
                if c in (a, b):
                    continue
                if frozenset((a, c)) not in edges and frozenset((b, c)) not in edges:
                    continue
                (ax, ay), (bx, by), (cx, cy) = pts[a], pts[b], pts[c]
                cross = abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
                span = max(abs(bx - ax), abs(by - ay), 1e-6)
                if cross / span < 0.02:
                    trio = {a, b, c}
                    for g in groups:
                        if len(g & trio) >= 2:
                            g |= trio
                            break
                    else:
                        groups.append(trio)
    def order(g: set[str]) -> str:
        xs = sorted(g, key=lambda n: (pts[n][0], pts[n][1]))
        return "、".join(xs)
    parts = ["画出的线段有 " + "、".join(f"{a}{b}" for a, b in segs)]
    if groups:
        parts.append("共线：" + "；".join(order(g) + " 在同一直线上" for g in groups))
        # 明说"不共线"：模型爱把一条折线看成对角线（实机：把 D–E 和 E–F–B 接成 DB）。
        # 对每条共线链的两端，凡有别的点与端点相连却不在链上，就点名它不共线
        # 只点名"看着像一条直线"的折线（转角小于 35°）：D→E 接 E→B 差 26°，模型就当成对角线 DB
        warnings: list[str] = []
        for g in groups:
            chain = sorted(g, key=lambda n: (pts[n][0], pts[n][1]))
            for end, far in ((chain[0], chain[-1]), (chain[-1], chain[0])):
                for x in names:
                    if x in g or frozenset((x, end)) not in edges:
                        continue
                    (ax, ay), (bx, by), (cx, cy) = pts[x], pts[end], pts[far]
                    ux, uy, vx, vy = bx - ax, by - ay, cx - bx, cy - by
                    nu, nv = math.hypot(ux, uy), math.hypot(vx, vy)
                    if nu < 1e-6 or nv < 1e-6:
                        continue
                    cos_turn = (ux * vx + uy * vy) / (nu * nv)
                    if cos_turn > math.cos(math.radians(35)):
                        warnings.append(f"{x}、{end}、{far} 不共线（{x}{end} 与 {end}{far} 不是同一条直线，没有 {x}{far} 这条线）")
        if warnings:
            parts.append("；".join(dict.fromkeys(warnings)))
    parts.append("以上之外的连线（例如没列出的对角线）图上**没有**画，不要假设它存在")
    return "；".join(parts)


def problem_with_figure_conditions(
    problem: str, t: dict[str, Any] | None, include_structure: bool = True
) -> str:
    """题干 + 图上标注条件（一句"图中标注：…"），给解题/验证/导演**同一份**题面。

    只写在图上的条件（边长、角度、面积）不进题面，解题看不见、验证也看不见——
    实机：解题按图上的 6cm/8cm 算对了，验证却因为题干里没有这两个数判它"无据"，
    整条链路在这里停掉。三处都用这一份，谁也不会比谁多知道或少知道。
    """
    conditions = transcription_conditions(t)
    if not conditions:
        return problem
    marker = "图中标注："
    grounded = any(l.get("resolved") == "geometry" for l in (t or {}).get("labels") or [])
    if marker in (problem or ""):
        if not grounded:
            return problem  # 抽取层已经把标注抄进题干（同一格式），不重复
        # 像素几何定下来的归属胜过抽取器的猜测：把抽取器那句换掉
        problem = re.sub(r"[（(]?图中标注：[^。．)）\n]*[。．)）]?", "", problem).rstrip()
    if grounded and t.get("shaded_resolved") == "geometry":
        for cycle in t.get("shaded") or []:
            shape = {3: "三角形", 4: "四边形"}.get(len(cycle), "多边形")
            conditions.append(f"阴影部分为{shape}{''.join(cycle)}")
    tail = "。以上按原图像素几何核对" if grounded else "。以上是读图所得，以图为准"
    structure = figure_structure_text(t) if grounded and include_structure else ""
    structure_line = f"\n（图形结构：{structure}）" if structure else ""
    return f"{problem.rstrip()}\n（{marker}{'；'.join(conditions)}{tail}）{structure_line}"


#: 带单位的量（长度/角度/面积单位）——这类标注贴着一条边或一个角写，模型挂对的把握大
_UNIT_RE = re.compile(r"(cm|mm|m|km|厘米|毫米|米|千米|分米|dm|°|度|平方|²|㎡)", re.I)


def transcription_conditions(t: dict[str, Any] | None) -> list[str]:
    """图上标注 → 给解题/验证/导演的文字。

    实机教训（2026-08-17 用户实拍）：本地视觉模型能读出图上的数（5、7、8），但
    **说不准它写在哪个三角形里**——同一张图两次转写一次说"AE:5"、一次说"E:5"，
    抽取器又猜成"S△AEF=5"。区域归属靠文字转述不可靠，所以这里分两档：
    - 带单位、挂在两个字母上的（"边AB 6cm"）：当条件说；
    - 其余（区域里的面积数、角上的数）：只说"图上写着「5」，在 E、F 附近"——
      位置是量出来的、归属不下结论，交给**看着图**解题的模型自己核对。
    """
    out: list[str] = []
    for label in (t or {}).get("labels") or []:
        on = list(label.get("on") or [])
        text = str(label.get("text") or "").strip()
        if not text or not on:
            continue
        resolved = label.get("resolved") == "geometry"
        if len(on) == 2 and (_UNIT_RE.search(text) or resolved):
            out.append(f"边{on[0]}{on[1]}标注「{text}」")
        elif resolved and len(on) >= 3:
            shape = {3: "三角形", 4: "四边形", 5: "五边形", 6: "六边形"}.get(len(on), "多边形")
            out.append(f"{shape}{''.join(on)}内标注「{text}」")
        else:
            out.append(f"「{text}」写在 {'、'.join(on)} 附近")
    return out


def to_figure_params(t: dict[str, Any]) -> dict[str, Any]:
    """转写 → 绘图规格参数（FigureSpec 形状：锚点坐标 + 线段 + 阴影多边形）。

    在这里统一把图像坐标翻成数学坐标（y 向上）；下游渲染器只认数学坐标。
    """
    seg_labels: dict[frozenset[str], str] = {}
    poly_labels: dict[tuple[str, ...], str] = {}
    for label in t.get("labels") or []:
        on = list(label.get("on") or [])
        text = str(label.get("text") or "").strip()
        if not text:
            continue
        if len(on) == 2:
            seg_labels[frozenset(on)] = text
        elif len(on) >= 3:
            poly_labels[tuple(sorted(on))] = text
    segments = []
    for s in t["segments"]:
        if len(s) != 2:
            continue
        seg = {"from": s[0], "to": s[1]}
        text = seg_labels.get(frozenset(s))
        if text:
            seg["label"] = text  # 原题写在边上的量，重画时照样写回去
        segments.append(seg)
    polygons = []
    for cycle in t["shaded"]:
        poly = {"points": list(cycle), "shaded": True}
        text = poly_labels.pop(tuple(sorted(cycle)), None)
        if text:
            poly["label"] = text
        polygons.append(poly)
    # 原图写在（非阴影）区域里的数（面积 5、角度…）也要画回去：不填色，只在重心写字
    for label in t.get("labels") or []:
        on = list(label.get("on") or [])
        text = str(label.get("text") or "").strip()
        if len(on) >= 3 and text and tuple(sorted(on)) in poly_labels:
            polygons.append({"points": on, "shaded": False, "label": text})
            poly_labels.pop(tuple(sorted(on)), None)
    return {
        "points": [{"id": p["id"], "at": [p["x"], round(1 - p["y"], 4)]} for p in t["points"]],
        "segments": segments,
        "polygons": polygons,
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


#: 分步/分组着色的色名表（Manim 与 Web 各自映射到具体颜色）
_TONES = ["gold", "blue", "orange", "green", "purple"]

#: 图上的区域标签只许写"量"（数字/问号/带单位的短文本）。算式是符号，不上图——
#: 关系靠色块表达，算式放 relation_node 沉底。带这些字符的标签整条丢弃并留痕
_FORMULA_CHARS = set("=+×÷*/≠≈<>")


def _figure_label(raw: Any, dropped: list[str], index: int) -> str:
    label = str(raw or "").strip()
    if not label:
        return ""
    if any(ch in _FORMULA_CHARS for ch in label):
        dropped.append(f"beat{index}:label 是算式不上图:{label[:20]}")
        return ""
    return label


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
      {"op":"compare_equal","regions":[["A","B","E"],["E","B","D"]],"label":"12"}
      {"op":"draw_segment","from":"B","to":"D","label":"辅助线"}
    这里逐条解析：字母 → 转写坐标 → 该拍的 overlay figure 对象 + create 动作。
    compare_equal 解析成同拍两块**同色**区域 + params.equal_marks（配对语义，渲染端
    用来同步脉冲，不画等号——相等靠颜色说，图上不写符号）。
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
        equal_marks: list[dict[str, Any]] = []
        for op in ops:
            if not isinstance(op, dict):
                continue
            kind = str(op.get("op") or "")
            if kind == "highlight_region":
                names = [str(n) for n in op.get("points") or []]
                if len(names) >= 3 and all(n in pts for n in names):
                    poly: dict[str, Any] = {"points": names, "shaded": True}
                    label = _figure_label(op.get("label"), dropped_ops, index)
                    if label:
                        poly["label"] = label
                    polygons.append(poly)
                    for n in names:
                        overlay_points[n] = pts[n]
                else:
                    dropped_ops.append(f"beat{index}:{kind}:{','.join(names)}")
            elif kind == "compare_equal":
                # 等量配对：同一拍把相等的两块**一起**亮出来，用同一种颜色——
                # 颜色本身就是等号，图上不写符号（用户定案 2026-08-17：相等/有关系
                # 一律靠色块，不靠 = + 这类符号）。"看见相等"是这类题的灵魂。
                # 两块都要能解析；只解析出一块就退成普通高亮，配对语义丢弃并留痕
                regions = [
                    [str(n) for n in r]
                    for r in (op.get("regions") or [])
                    if isinstance(r, (list, tuple))
                ]
                valid = [
                    r for r in regions if len(r) >= 3 and all(n in pts for n in r)
                ]
                label = _figure_label(op.get("label"), dropped_ops, index)
                if len(valid) >= 2:
                    a, b = valid[0], valid[1]
                    pair_id = len(equal_marks) + 1
                    for names in (a, b):
                        poly = {"points": names, "shaded": True, "pair": pair_id}
                        if label:
                            poly["label"] = label
                        polygons.append(poly)
                        for n in names:
                            overlay_points[n] = pts[n]
                    equal_marks.append({"a": a, "b": b, "label": label})
                    if len(valid) > 2:
                        dropped_ops.append(f"beat{index}:{kind}:多于两块只取前两块")
                elif len(valid) == 1:
                    poly = {"points": valid[0], "shaded": True}
                    if label:
                        poly["label"] = label
                    polygons.append(poly)
                    for n in valid[0]:
                        overlay_points[n] = pts[n]
                    dropped_ops.append(f"beat{index}:{kind}:只解析出一块，退成高亮")
                else:
                    dropped_ops.append(f"beat{index}:{kind}:{regions}")
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
        # 颜色就是关系：同一拍里"一对相等的块"共用一色，其余每块各一色——
        # 孩子看颜色就知道谁和谁一样大、整体由哪几块拼成，图上不出现符号。
        # 起始色随拍号轮转，相邻两拍不会撞同一种颜色
        groups: dict[int, int] = {}
        next_group = 0
        for poly in polygons:
            pair_id = poly.get("pair")
            if pair_id is not None and pair_id in groups:
                slot = groups[pair_id]
            else:
                slot = next_group
                next_group += 1
                if pair_id is not None:
                    groups[pair_id] = slot
            poly["tone"] = _TONES[(index + slot) % len(_TONES)]
        for mark in equal_marks:
            pair_polys = [p for p in polygons if p.get("pair") == equal_marks.index(mark) + 1]
            if pair_polys:
                mark["tone"] = pair_polys[0]["tone"]
        overlay_params: dict[str, Any] = {
            "points": [{"id": n, "at": at} for n, at in overlay_points.items()],
            "segments": segments,
            "polygons": polygons,
        }
        if equal_marks:
            overlay_params["equal_marks"] = equal_marks
        plan.setdefault("visual_objects", []).append(
            {
                "id": overlay_id,
                "primitive": "figure",
                "params": overlay_params,
                "meaning": f"第{index}拍的图上注解",
            }
        )
        actions = scene.setdefault("actions", [])
        if isinstance(actions, list):
            # 新拍高亮出场时，上一拍的高亮退场——按步骤表达，当前拍才是焦点。
            # 只退 overlay，底图永远在场
            actions.insert(0, {"op": "create", "targets": [overlay_id], "target": overlay_id})
            if previous_overlay is not None:
                # 先退旧再出新：两拍的数值同屏哪怕半秒也会读成一堆数
                actions.insert(
                    0,
                    {"op": "remove", "targets": [previous_overlay], "target": previous_overlay},
                )
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


#: 解答里"作辅助线"的说法：连接/连结/作/画/引/添加 + 两个字母（可夹 $、空格、"对角线"、"线段"）
_CONSTRUCT_RE = re.compile(
    r"(?:连接|连结|作|画出|画|引|添加|添|构造|补)\s*(?:对角线|线段|辅助线|一条)?[\s$\\overline{}]*"
    r"([A-Za-z])\s*['′]?\s*([A-Za-z])['′]?(?![A-Za-z])"
)
_AUX_RE = re.compile(r"辅助线\s*[$\\overline{}\s]*([A-Za-z])\s*([A-Za-z])(?![A-Za-z])")
#: 题干里点名的阴影区域："阴影四边形EDFB""阴影部分（三角形ABE）"
_SHADED_RE = re.compile(
    r"阴影(?:部分|区域)?[^A-Za-z]{0,12}?(?:三角形|四边形|五边形|六边形|梯形|平行四边形|△)?"
    r"[\s$\\]*([A-Za-z]{3,6})(?![A-Za-z])"
)


def _solution_text(solution: Any, steps: Any) -> str:
    parts: list[str] = []
    if isinstance(solution, dict):
        for key in ("approach", "summary", "brief", "method", "idea", "explanation"):
            if solution.get(key):
                parts.append(str(solution[key]))
        for step in solution.get("steps") or []:
            if isinstance(step, dict):
                parts.extend(str(v) for v in step.values() if isinstance(v, str))
            elif isinstance(step, str):
                parts.append(step)
    for step in steps or []:
        if isinstance(step, dict):
            parts.extend(str(v) for v in step.values() if isinstance(v, str))
        elif isinstance(step, str):
            parts.append(step)
    return "\n".join(parts)


def reconcile_transcription(
    t: dict[str, Any], problem: str, solution: Any = None, steps: Any = None
) -> dict[str, Any]:
    """用题干和已验证解答给转写纠偏——视觉模型会**多量出线**。

    实机（2026-08-17，用户实拍）：转写把解答里才要"连接"的对角线 BD 量成了原图
    自带的线段，还把阴影从四边形 EDFB 认成了三角形 BDF。结果第一拍就画着 BD，
    "连 BD"这一步的揭示感没了，孩子看到的也不是题目的图。

    两条确定性规则（只删不补，不引入题干知识画新东西）：
    ① 解答里"连接/作 XY"的线是**辅助线**，原图上不该有——从转写线段里去掉，
       由导演在对应的拍用 draw_segment 画出来；
    ② 题干点名的阴影区域（"阴影四边形 EDFB"）以题干为准：阴影环替换成它，
       并去掉那个多边形的对角线（一块被点名为"四边形"的阴影，内部不该有对角线）。
    改动都留痕（t["reconciled"]），方便回看。
    """
    ids = {p["id"] for p in t.get("points") or []}
    notes: list[str] = []
    text = _solution_text(solution, steps)
    constructed: set[frozenset[str]] = set()
    for a, b in _CONSTRUCT_RE.findall(text) + _AUX_RE.findall(text):
        if a in ids and b in ids and a != b:
            constructed.add(frozenset((a, b)))

    segments = [list(sg) for sg in (t.get("segments") or []) if len(sg) == 2]
    if constructed:
        kept = []
        for sg in segments:
            if frozenset(sg) in constructed:
                notes.append(f"去掉辅助线 {sg[0]}-{sg[1]}（解答里才连接，原图没有）")
            else:
                kept.append(sg)
        segments = kept

    m = _SHADED_RE.search(problem or "")
    if m:
        cycle = list(m.group(1))
        if len(set(cycle)) == len(cycle) and all(c in ids for c in cycle):
            if [list(c) for c in (t.get("shaded") or [])] != [cycle]:
                notes.append(f"阴影以题干为准：{''.join(cycle)}")
                t["shaded"] = [cycle]
            n = len(cycle)
            adjacent = {frozenset((cycle[i], cycle[(i + 1) % n])) for i in range(n)}
            kept = []
            for sg in segments:
                pair = frozenset(sg)
                if pair <= set(cycle) and pair not in adjacent:
                    notes.append(f"去掉阴影{''.join(cycle)}的内部对角线 {sg[0]}-{sg[1]}")
                else:
                    kept.append(sg)
            segments = kept

    t["segments"] = segments
    if notes:
        t["reconciled"] = notes
        logger.info("figure transcription reconciled: %s", "；".join(notes))
    return t


def _decode_gray(figure_image: str) -> Any:
    """data URL → 灰度像素矩阵（numpy）。解不出来返回 None（校验就跳过）。"""
    try:
        import base64
        import io

        import numpy as np
        from PIL import Image

        head, _, payload = figure_image.partition(",")
        if not head.startswith("data:image/") or not payload:
            return None
        img = Image.open(io.BytesIO(base64.b64decode(payload))).convert("L")
        return np.asarray(img, dtype=np.uint8)
    except Exception:  # noqa: BLE001 — 校验是加分项，解码失败不拦路
        return None


def _ink_cells(gray: Any, cell: int, contrast: float, band_cells: int) -> Any:
    """墨迹格网：把图切成 cell×cell 的格，格里有"比局部背景暗 contrast 以上"的像素就算墨迹，
    再按 band_cells 膨胀（容忍转写坐标误差）。返回 bool 矩阵 [rows, cols]。"""
    import numpy as np
    from PIL import Image, ImageFilter

    h, w = gray.shape
    rows, cols = h // cell, w // cell
    if rows < 4 or cols < 4:
        return None
    cropped = gray[: rows * cell, : cols * cell].astype(np.float32)
    blocks = cropped.reshape(rows, cell, cols, cell)
    block_min = blocks.min(axis=(1, 3))
    block_mean = blocks.mean(axis=(1, 3))
    # 局部背景：小图上的中值滤波（约 9 格 ≈ 十来个线宽），阴影算背景、线条不算
    bg_img = Image.fromarray(np.clip(block_mean, 0, 255).astype(np.uint8), mode="L")
    background = np.asarray(bg_img.filter(ImageFilter.MedianFilter(size=9)), dtype=np.float32)
    ink = (background - block_min) >= contrast
    if band_cells > 0:
        ink_img = Image.fromarray((ink * 255).astype(np.uint8), mode="L")
        ink = np.asarray(ink_img.filter(ImageFilter.MaxFilter(size=2 * band_cells + 1))) > 0
    return ink


#: 题干里点名的多边形/线段："四边形ABCD""三角形ABE""△DFC""边AB""线段EF""AB边"
_NAMED_POLY_RE = re.compile(
    r"(?:三角形|四边形|五边形|六边形|梯形|平行四边形|矩形|长方形|正方形|菱形|△)"
    r"[\s$\\]*([A-Za-z]{3,6})(?![A-Za-z])"
)
_NAMED_EDGE_RE = re.compile(
    r"(?:边|线段|底边|斜边|高)[\s$\\overline{}]*([A-Za-z])\s*([A-Za-z])(?![A-Za-z])"
    r"|(?<![A-Za-z])([A-Za-z])\s*([A-Za-z])[\s$]*边"
)


def named_edges_in_problem(problem: str, ids: set[str]) -> set[frozenset[str]]:
    """题干自己断言存在的线：点名多边形的各条边、"边 XY/线段 XY"。

    这些线是题目的一部分，像素核对**不许**把它们删掉（照片再糊也不删）——
    通用规则：题干说有的边就有；不认题型、不认字母。
    """
    edges: set[frozenset[str]] = set()
    text = problem or ""
    for name in _NAMED_POLY_RE.findall(text):
        cycle = list(name)
        if len(set(cycle)) != len(cycle) or not all(c in ids for c in cycle):
            continue
        n = len(cycle)
        for i in range(n):
            edges.add(frozenset((cycle[i], cycle[(i + 1) % n])))
    for a, b, c, d in _NAMED_EDGE_RE.findall(text):
        x, y = (a, b) if a else (c, d)
        if x in ids and y in ids and x != y:
            edges.add(frozenset((x, y)))
    return edges


def verify_segments_by_ink(
    t: dict[str, Any],
    figure_image: str,
    protected: set[frozenset[str]] | None = None,
) -> dict[str, Any]:
    """按**像素墨迹**核对转写线段——只为抓"图上根本没有、模型脑补出来"的线。

    实机（2026-08-17，用户实拍）：E-F 根本没画，模型照样量了出来；一条多余的
    干扰线足以让孩子看错图。转写是测量，那就真的量一下。但**删掉一条真边比留下
    一条假线更糟**，所以整套规则偏保守，只在证据很硬时才删：
    ① 先对齐坐标系——本地视觉模型量出的坐标常整体偏 5%~7%（缩放/平移），
       在一小片全局仿射里找让"所有线段落在墨迹上"最多的那组；明显更贴合时
       顺手把点坐标校准过去（同样只按像素改，不引入题干知识）；
    ② 逐条看覆盖率：沿线取样，样点落在（膨胀过的）墨迹格上算命中。
       覆盖率 <45% 才算"没墨迹"；边缘线还给一次更宽容差的复核机会（照片有透视，
       远离中心的边局部偏得更多）；题干点名的边（protected）一律不删；
    ③ 其余线段整体覆盖率不到 70%（对齐/阈值对这张照片不可信）或一半以上都判
       没墨迹时，全部保留——宁可多一条假线，不把真图删秃。
    """
    gray = _decode_gray(figure_image)
    if gray is None or not t.get("segments"):
        return t
    import numpy as np

    h, w = gray.shape
    if h < 40 or w < 40:
        return t
    paper = float(np.median(gray))
    darkest = float(np.percentile(gray, 1))
    contrast = 0.3 * (paper - darkest)
    if contrast < 12:
        return t  # 几乎没有反差的图，量不出东西
    cell = max(2, int(round(0.012 * min(w, h))))
    protected = protected or set()

    ids = [p["id"] for p in t.get("points") or []]
    base = {p["id"]: (float(p["x"]), float(p["y"])) for p in t.get("points") or []}
    segs = [list(sg) for sg in t["segments"] if len(sg) == 2 and sg[0] in base and sg[1] in base]
    if not segs:
        return t
    fs = np.linspace(0.08, 0.92, 32)  # 掐掉两端 8%：字母和端点误差都在那儿
    all_xy = np.stack([
        np.stack([base[a][0] + (base[b][0] - base[a][0]) * fs,
                  base[a][1] + (base[b][1] - base[a][1]) * fs], axis=1)
        for a, b in segs
    ])  # (N, S, 2)

    ink_tight = _ink_cells(gray, cell, contrast, band_cells=2)   # ≈ ±2.5% 容差
    if ink_tight is None:
        return t
    rows, cols = ink_tight.shape

    def coverage(ink: Any, sx: float, sy: float, dx: float, dy: float) -> Any:
        xs = np.clip(((all_xy[..., 0] * sx + dx) * (w - 1) / cell).astype(int), 0, cols - 1)
        ys = np.clip(((all_xy[..., 1] * sy + dy) * (h - 1) / cell).astype(int), 0, rows - 1)
        return ink[ys, xs].mean(axis=1)  # (N,)

    identity = coverage(ink_tight, 1.0, 1.0, 0.0, 0.0)
    best = (float(identity.mean()), (1.0, 1.0, 0.0, 0.0))
    scales = (0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15)
    for sx in scales:
        for sy in scales:
            for dx in np.arange(-0.10, 0.101, 0.02):
                for dy in np.arange(-0.10, 0.101, 0.02):
                    score = float(coverage(ink_tight, sx, sy, float(dx), float(dy)).mean())
                    if score > best[0] + 1e-9:
                        best = (score, (sx, sy, float(dx), float(dy)))
    notes: list[str] = []
    score, (sx, sy, dx, dy) = best
    transform = (1.0, 1.0, 0.0, 0.0)
    if (sx, sy, dx, dy) != transform and score - float(identity.mean()) >= 0.15 and score >= 0.7:
        transform = (sx, sy, dx, dy)
        for p in t.get("points") or []:
            p["x"] = round(min(1.0, max(0.0, float(p["x"]) * sx + dx)), 4)
            p["y"] = round(min(1.0, max(0.0, float(p["y"]) * sy + dy)), 4)
        notes.append(
            f"坐标按墨迹校准（缩放 {sx:.2f}/{sy:.2f}，平移 {dx:+.2f}/{dy:+.2f}，"
            f"覆盖 {float(identity.mean()):.0%}→{score:.0%}）"
        )
    tight = coverage(ink_tight, *transform)

    # 校验必须"说得出不"：在图形包围盒里随机抽几十条弦当诱饵，看它们是否也大多"有墨迹"。
    # 线很密的图（对角线 + 多条中线，用户实拍就是）里，±2 格容差下任何一条弦都撞墨迹——
    # 这时候覆盖率分不出真假，删线只会误杀，整段核对直接放弃。诱饵用固定种子，结果可复现
    rng = np.random.default_rng(0)
    bx = [p[0] for p in base.values()]
    by = [p[1] for p in base.values()]
    x0b, x1b, y0b, y1b = min(bx), max(bx), min(by), max(by)
    if x1b - x0b > 0.05 and y1b - y0b > 0.05:
        starts = np.stack([rng.uniform(x0b, x1b, 40), rng.uniform(y0b, y1b, 40)], axis=1)
        ends = np.stack([rng.uniform(x0b, x1b, 40), rng.uniform(y0b, y1b, 40)], axis=1)
        decoy_xy = starts[:, None, :] + (ends - starts)[:, None, :] * fs[None, :, None]
        sx_, sy_, dx_, dy_ = transform
        xs = np.clip(((decoy_xy[..., 0] * sx_ + dx_) * (w - 1) / cell).astype(int), 0, cols - 1)
        ys = np.clip(((decoy_xy[..., 1] * sy_ + dy_) * (h - 1) / cell).astype(int), 0, rows - 1)
        decoy_cov = ink_tight[ys, xs].mean(axis=1)
        if float(np.median(decoy_cov)) >= 0.5:
            logger.info(
                "figure transcription ink check not discriminative (decoy median %.0f%%), keeping all",
                float(np.median(decoy_cov)) * 100,
            )
            if notes:
                t.setdefault("reconciled", []).extend(notes)
            return t

    ink_narrow = _ink_cells(gray, cell, contrast, band_cells=1)

    def relocated_coverage(i: int) -> float:
        """复核：整条线沿**法向**平移（±6%），能不能整齐地落到一条**窄**墨迹带上。
        真边只是画偏了：平移到位后整条都贴着墨迹；假线旁边就算有一条不平行的真线，
        也只在交叉处碰到墨迹，随着平移量变化"碰到"的位置会滑走，凑不出整条覆盖。
        （粗容差 + 二维乱挪会让贴着真线的假对角线蒙混过关——实测踩过）"""
        a, b = segs[i]
        (x0, y0), (x1, y1) = base[a], base[b]
        sx_, sy_, dx_, dy_ = transform
        x0, y0 = x0 * sx_ + dx_, y0 * sy_ + dy_
        x1, y1 = x1 * sx_ + dx_, y1 * sy_ + dy_
        px0, py0, px1, py1 = x0 * (w - 1), y0 * (h - 1), x1 * (w - 1), y1 * (h - 1)
        length = ((px1 - px0) ** 2 + (py1 - py0) ** 2) ** 0.5
        if length < 1e-6:
            return 0.0
        nx, ny = -(py1 - py0) / length, (px1 - px0) / length
        reach = 0.06 * min(w, h)
        best_cov = 0.0
        for off in np.arange(-reach, reach + 1e-6, cell):
            xs = np.clip(((px0 + (px1 - px0) * fs + nx * off) / cell).astype(int), 0, cols - 1)
            ys = np.clip(((py0 + (py1 - py0) * fs + ny * off) / cell).astype(int), 0, rows - 1)
            best_cov = max(best_cov, float(ink_narrow[ys, xs].mean()))
        return best_cov

    suspects: list[int] = []
    for i, sg in enumerate(segs):
        if frozenset(sg) in protected:
            continue  # 题干说有的边，不删
        if float(tight[i]) >= 0.45:
            continue
        if relocated_coverage(i) >= 0.7:
            continue  # 沿法向平移就整条贴合：是画偏了的真边，不是假线
        suspects.append(i)
    others = [float(tight[i]) for i in range(len(segs)) if i not in suspects]
    if not suspects:
        if notes:
            t.setdefault("reconciled", []).extend(notes)
        return t
    if len(suspects) * 2 > len(segs) or (others and sum(others) / len(others) < 0.7):
        # 校验对这张照片不可信：全留
        logger.warning(
            "figure transcription ink check unreliable, keeping all: %s",
            [f"{segs[i][0]}-{segs[i][1]}({float(tight[i]):.0%})" for i in suspects],
        )
        if notes:
            t.setdefault("reconciled", []).extend(notes)
        return t
    dropped = [f"{segs[i][0]}-{segs[i][1]}({float(tight[i]):.0%})" for i in suspects]
    drop_pairs = {frozenset(segs[i]) for i in suspects}
    t["segments"] = [
        list(sg) for sg in t["segments"]
        if not (len(sg) == 2 and frozenset(sg) in drop_pairs)
    ]
    notes.append("像素核对去掉没有墨迹的线段：" + "、".join(dropped))
    logger.info("figure transcription ink check dropped %s", dropped)
    t.setdefault("reconciled", []).extend(notes)
    return t


def refine_transcription(
    t: dict[str, Any],
    figure_image: str,
    problem: str,
    solution: Any = None,
    steps: Any = None,
) -> dict[str, Any]:
    """转写后的两道校核，按固定顺序：先按题干/解答纠偏，再按像素核对。

    题干点名的边受保护（像素核对不删）；解答里才连的辅助线不受保护（本来就该删）。
    三个转写入口（视频导演 / Web 讲解 / 计划器）都走这里，规则只此一份。
    """
    reconcile_transcription(t, problem, solution, steps)
    ids = {p["id"] for p in t.get("points") or []}
    protected = named_edges_in_problem(problem, ids)
    constructed: set[frozenset[str]] = set()
    for a, b in _CONSTRUCT_RE.findall(_solution_text(solution, steps)) + _AUX_RE.findall(
        _solution_text(solution, steps)
    ):
        if a in ids and b in ids and a != b:
            constructed.add(frozenset((a, b)))
    # 像素几何：点吸附到真实交点、线段按真线判、数字按包含关系归属（做得到就以它为准）。
    # 题干点名的边照样受保护（拍糊了也不删）；解答里才连的辅助线不受保护
    gray = _decode_gray(figure_image)
    grounded = False
    if gray is not None:
        from .figure_geometry import ground_transcription

        before = list(t.get("reconciled") or [])
        ground_transcription(t, gray, protected=protected - constructed)
        grounded = len(t.get("reconciled") or []) > len(before)
        if grounded:
            # 几何校准后再按解答纠一次辅助线（几何只认墨迹，辅助线本来就没画，通常无事）
            reconcile_transcription(t, problem, solution, steps)
    if not grounded:
        verify_segments_by_ink(t, figure_image, protected=protected - constructed)
    return t


#: 送视觉模型前的最小短边：截图/裁图太小时模型量不准、字母都认不清；放大不改内容
_MIN_SHORT_SIDE = 800


def upscale_for_vision(figure_image: str, min_short_side: int = _MIN_SHORT_SIDE) -> str:
    """短边不足就等比放大（LANCZOS）后重新编码；不需要放大或解不出来时原样返回。

    通用规则：所有进视觉模型的配图都先过这一步——小图是"看不清"的第一原因，
    放大不引入任何新信息，只是让模型（和像素核对）有足够的像素可看。
    """
    try:
        import base64
        import io

        from PIL import Image

        head, _, payload = figure_image.partition(",")
        if not head.startswith("data:image/") or not payload:
            return figure_image
        img = Image.open(io.BytesIO(base64.b64decode(payload)))
        w, h = img.size
        short = min(w, h)
        if short <= 0 or short >= min_short_side:
            return figure_image
        factor = min(4.0, min_short_side / short)
        img = img.convert("RGB").resize((round(w * factor), round(h * factor)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        logger.info("figure image upscaled ×%.1f for vision (%dx%d → %dx%d)", factor, w, h, *img.size)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # noqa: BLE001 — 放大失败就用原图，不拦路
        return figure_image


async def transcribe_figure(llm: Any, figure_image: str) -> dict[str, Any] | None:
    """跑一趟视觉转写；任何失败返回 None（调用方按'没有转写'继续，绝不拦路）。"""
    if not figure_image.startswith("data:image/"):
        return None
    figure_image = upscale_for_vision(figure_image)
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
