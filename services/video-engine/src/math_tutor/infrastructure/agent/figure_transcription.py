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
- segments：图中**实际画出**（有墨迹）的线段，端点用字母。只记录看得见的线：
  题目要"连接"的辅助线、你觉得"应该有"的对角线，图上没画就**不要写**；
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
