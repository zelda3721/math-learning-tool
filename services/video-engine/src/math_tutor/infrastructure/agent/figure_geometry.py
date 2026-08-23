"""像素几何：让**像素**决定图形结构，模型只负责认字。

为什么需要它（2026-08-17，用户实拍"三个小三角形面积 5/7/8"）：本地视觉模型能读出
字母和数字，但量不准坐标（整体偏 5~8%）、说不准一个数写在哪个三角形里（同一张图两次
转写归属都不一样）。而这两件事恰恰是**像素能确定地回答**的：线在哪、交点在哪、
哪个数字落在哪个由真线围成的区域里。所以分工改成：

  模型：字母/数字的**身份**和**大致位置**（认字）
  像素：线段、交点、端点、区域（量图）
  这里：把身份吸附到像素几何上（字母 → 最近的交点/角，数字 → 包含它的最小区域）

通用、不认题型：任何"直线 + 字母 + 数字"的几何图都是同一套算法。做不到的地方
（吸不到、含糊）一律**保持模型原判**，不引入新的猜测。

依赖只有 numpy + PIL（都是 manim 带进来的）。全部函数纯计算、可测。
"""
from __future__ import annotations

import itertools
import logging
import math
import re
from typing import Any

logger = logging.getLogger(__name__)

Point = tuple[float, float]


# ────────────────────────────── 墨迹与直线 ──────────────────────────────


def ink_mask(gray: Any, contrast: float | None = None) -> Any:
    """比局部背景暗得多的像素 = 墨迹（阴影只是"偏暗"，不算）。"""
    import numpy as np
    from PIL import Image, ImageFilter

    img = Image.fromarray(gray)
    bg = np.asarray(img.filter(ImageFilter.MedianFilter(size=31)), dtype=np.float32)
    g = gray.astype(np.float32)
    if contrast is None:
        paper = float(np.median(gray))
        darkest = float(np.percentile(gray, 1))
        contrast = max(25.0, 0.3 * (paper - darkest))
    return (bg - g) >= contrast


def detect_lines(ink: Any, max_lines: int = 24) -> list[dict[str, Any]]:
    """霍夫变换找直线，并沿每条直线量出**有墨迹的最长区间**（线段端点）。

    返回 [{"a": (x,y), "b": (x,y), "votes": n, "theta": rad, "rho": r}]，坐标为像素。
    """
    import numpy as np

    h, w = ink.shape
    ys, xs = np.nonzero(ink)
    if len(xs) < 50:
        return []
    thetas = np.deg2rad(np.arange(0.0, 180.0, 0.5))
    cos, sin = np.cos(thetas), np.sin(thetas)
    diag = int(math.hypot(w, h)) + 2
    acc = np.zeros((2 * diag, len(thetas)), dtype=np.int32)
    # 逐点累加（墨迹像素通常几千到几万个，够快）
    idx = np.arange(len(thetas))
    for x, y in zip(xs, ys):
        r = (x * cos + y * sin).astype(int) + diag
        acc[r, idx] += 1
    lines: list[dict[str, Any]] = []
    a = acc.copy()
    a_max = int(a.max())
    floor = max(40, int(0.10 * a_max))
    # 抑制窗随分辨率走：线粗几个像素、稍有倾斜，同一条线会在 rho 上散出好几个峰；
    # 窗太窄时前 20 个峰全是长边的重影，短线（A–E、D–E）根本轮不到（实机踩过）
    rho_win = max(12, int(0.02 * min(w, h)))
    theta_win = 8
    for _ in range(max_lines * 6):
        if len(lines) >= max_lines:
            break
        flat = int(np.argmax(a))
        r, ti = divmod(flat, a.shape[1])
        votes = int(a[r, ti])
        if votes < floor:
            break
        rho, theta = r - diag, float(thetas[ti])
        # 抑制邻近峰（同一条线的邻近参数）
        a[max(0, r - rho_win) : r + rho_win + 1, max(0, ti - theta_win) : ti + theta_win + 1] = 0
        if ti < theta_win:  # 角度是环的：0° 与 180° 相邻
            a[max(0, r - rho_win) : r + rho_win + 1, len(thetas) - (theta_win - ti) :] = 0
        seg = _inked_extent(ink, rho, theta)
        if seg is None:
            continue
        (x0, y0), (x1, y1) = seg
        # 太短的"线"多半是字母笔画（实机：E、7 的笔画凑出 70~80px 的假线，把真三角形"切开"）；
        # 又短又弱的（不到 1/4 短边、票数不到最强线的 35%）同样是笔画/阴影边，不是几何线
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 0.12 * min(w, h):
            continue
        if length < 0.25 * min(w, h) and votes < 0.35 * a_max:
            continue
        # 与已有线段几乎重合（同一条线的第二个峰）就并掉
        if any(_same_segment(seg, (ln["a"], ln["b"]), tol=0.02 * min(w, h)) for ln in lines):
            continue
        lines.append({"a": (x0, y0), "b": (x1, y1), "votes": votes, "theta": theta, "rho": rho})
    return lines


def _inked_extent(
    ink: Any,
    rho: float,
    theta: float,
    bridge_boxes: list[tuple[int, int, int, int]] | None = None,
) -> tuple[Point, Point] | None:
    """沿直线取样，找允许小缺口的最长墨迹区间。

    bridge_boxes：文字块包围盒——写在线上的字母/数字会把墨迹区间截断
    （实机：对角线在 E/5/F 文字簇处断开，近角一段被整个丢弃，A-F 边失踪、
    标注归属失败）。盖住取样点的文字块视为有墨，但只做**桥**：两端最后会
    收缩回真实墨迹，纯文字撑不出线。
    """
    import numpy as np

    h, w = ink.shape
    c, s = math.cos(theta), math.sin(theta)
    diag = int(math.hypot(w, h)) + 2
    ts = np.arange(-diag, diag, 1.5)
    px = rho * c - ts * s
    py = rho * s + ts * c
    inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
    ink_hits = np.zeros(len(ts), dtype=bool)
    # 默认 ±2px；认边重测（bridge_boxes 路径）加宽到 ±4px：实拍纸面透视/弯曲
    # 让角部墨迹偏离霍夫拟合线几个像素，±2 在角上够不着（实机：对角线近角一截
    # 被判无墨，A-F 边失踪）。检测路径保持 ±2——全局加宽会把邻线墨迹并进来
    # （实测 8/7 的归属反而炸了）
    offsets = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (-2, 0), (0, 2), (0, -2)]
    if bridge_boxes:
        offsets += [(3, 0), (-3, 0), (0, 3), (0, -3), (4, 0), (-4, 0), (0, 4), (0, -4)]
    for dx, dy in offsets:
        xi = np.clip(px + dx, 0, w - 1).astype(int)
        yi = np.clip(py + dy, 0, h - 1).astype(int)
        ink_hits |= ink[yi, xi] & inside
    hits = ink_hits
    if bridge_boxes:
        hits = ink_hits.copy()
        for x0, y0, x1, y1 in bridge_boxes:
            hits |= (
                (px >= x0 - 4) & (px <= x1 + 4) & (py >= y0 - 4) & (py <= y1 + 4) & inside
            )
    best = (0, 0, 0)
    start = None
    end = 0
    gap = 0
    for i, hit in enumerate(hits):
        if hit:
            if start is None:
                start = i
            end = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > 10:
                if end - start > best[0]:
                    best = (end - start, start, end)
                start = None
    if start is not None and end - start > best[0]:
        best = (end - start, start, end)
    length, s0, e0 = best
    if length < 12:
        return None
    if bridge_boxes:
        # 两端收缩到真实墨迹：文字块只能当区间内部的桥，不能当端点
        import numpy as np

        real = np.nonzero(ink_hits[s0 : e0 + 1])[0]
        if len(real) < 12:
            return None
        s0, e0 = s0 + int(real[0]), s0 + int(real[-1])
    return (float(px[s0]), float(py[s0])), (float(px[e0]), float(py[e0]))


def _same_segment(s1: tuple[Point, Point], s2: tuple[Point, Point], tol: float) -> bool:
    (a, b), (c, d) = s1, s2
    return (
        _point_line_distance(a, c, d) < tol
        and _point_line_distance(b, c, d) < tol
        and _overlap_1d(a, b, c, d) > 0.5
    )


def _overlap_1d(a: Point, b: Point, c: Point, d: Point) -> float:
    """两条近似共线线段沿方向的重叠比例（相对较短者）。"""
    ux, uy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(ux, uy) or 1.0
    ux, uy = ux / n, uy / n
    t = sorted([(p[0] - a[0]) * ux + (p[1] - a[1]) * uy for p in (a, b, c, d)])
    la = n
    lb = abs((d[0] - c[0]) * ux + (d[1] - c[1]) * uy)
    inter = max(0.0, min(n, max((c[0] - a[0]) * ux + (c[1] - a[1]) * uy, (d[0] - a[0]) * ux + (d[1] - a[1]) * uy)) - max(0.0, min((c[0] - a[0]) * ux + (c[1] - a[1]) * uy, (d[0] - a[0]) * ux + (d[1] - a[1]) * uy)))
    del t
    return inter / max(1e-6, min(la, lb))


def _point_line_distance(p: Point, a: Point, b: Point) -> float:
    ux, uy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(ux, uy)
    if n < 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) / n


def _on_segment(p: Point, a: Point, b: Point, tol: float, along_tol: float | None = None) -> bool:
    """p 是否落在线段 ab 上：垂直方向容差 tol；沿线方向允许超出端点 along_tol
    （霍夫量出的墨迹区间常在角上/字母处短一截，默认与 tol 相同）。"""
    if _point_line_distance(p, a, b) > tol:
        return False
    ux, uy = b[0] - a[0], b[1] - a[1]
    n2 = ux * ux + uy * uy or 1e-9
    n = math.sqrt(n2)
    t = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / n2
    slack = (along_tol if along_tol is not None else tol) / n
    return -slack <= t <= 1 + slack


def _intersection(a: Point, b: Point, c: Point, d: Point) -> Point | None:
    den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
    if abs(den) < 1e-9:
        return None
    t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


# ────────────────────────────── 锚点与吸附 ──────────────────────────────


def anchor_points(lines: list[dict[str, Any]], size: tuple[int, int]) -> list[Point]:
    """图上"有名字资格"的位置：线段端点 + 线段两两交点（交点要落在两条线段的范围内附近）。"""
    w, h = size
    tol = 0.03 * min(w, h)
    # 沿线方向放宽：墨迹区间在角上常短一截（角上是字母、笔画没接上），角点是两条边
    # 延长一点点才相交（实机：底边区间离 D 角还差 43px，D 角就不是锚点，D 吸到了旁边的接头）
    along = 0.06 * min(w, h)
    anchors: list[tuple[Point, float]] = []  # (位置, 权重=线的票数：强线的交点更可信)
    # 线段端点只有落在别的线上（T 形接头、角）才算锚点：孤零零的端点多半是线段
    # 延伸进字母/阴影的假端头（实机：底边一直量到 D 字母里，把 D 吸歪了）
    for ln in lines:
        for end in (ln["a"], ln["b"]):
            others = [o for o in lines if o is not ln and _on_segment(end, o["a"], o["b"], tol, along)]
            if others:
                anchors.append((end, float(min(ln["votes"], max(o["votes"] for o in others)))))
    for l1, l2 in itertools.combinations(lines, 2):
        p = _intersection(l1["a"], l1["b"], l2["a"], l2["b"])
        if p is None:
            continue
        if _on_segment(p, l1["a"], l1["b"], tol, along) and _on_segment(p, l2["a"], l2["b"], tol, along):
            anchors.append((p, float(min(l1["votes"], l2["votes"]))))
    # 合并靠得近的锚点（单链接聚类）：几条线在同一点相交，霍夫角度差一点就会散成
    # 一小簇交点（实机：E 附近 6 个交点散在 40px 里），簇心才是那个点。
    # 簇心按票数加权：字母笔画凑出的弱线的交点，别把真角点拽偏
    radius = 0.06 * min(w, h)
    clusters: list[list[tuple[Point, float]]] = []
    for item in anchors:
        p = item[0]
        hit = [c for c in clusters if any(math.hypot(p[0] - q[0][0], p[1] - q[0][1]) < radius for q in c)]
        if not hit:
            clusters.append([item])
        else:
            base = hit[0]
            base.append(item)
            for other in hit[1:]:
                base.extend(other)
                clusters.remove(other)
    out: list[Point] = []
    for c in clusters:
        total = sum(wt for _, wt in c) or 1.0
        out.append((sum(q[0] * wt for q, wt in c) / total, sum(q[1] * wt for q, wt in c) / total))
    return out


def is_point_letter_label(text: Any, point_ids: set[str] | None = None) -> bool:
    """顶点字母写成的"标注"（E、M、N…）：不是条件——不参与归属、不下传重画。

    实机：字母标注的 at 就是它自己的像素位置，恒能击穿"at 比命名点更近"的
    比较判定，字母块混进候选后被归属成区域标签，成片里顶点字母画了两遍。
    """
    s = str(text or "").strip()
    if not s:
        return False
    if point_ids and s in point_ids:
        return True
    return bool(re.fullmatch(r"[A-Z]", s))


def align_named_points(
    named: dict[str, Point], anchors: list[Point], size: tuple[int, int]
) -> tuple[dict[str, Point], dict[str, float]]:
    """把模型量的字母位置吸附到像素锚点上。

    先用一小片全局仿射（缩放 0.8~1.2、平移 ±12%）对齐——模型坐标常整体偏；
    再逐点取最近锚点，要求：距离 < 6% 且比第二近的近得多（不含糊）。
    返回 (吸附后的坐标, 每个点的吸附距离)；吸不到的保持对齐后的模型坐标。
    """
    import numpy as np

    w, h = size
    if not named or not anchors:
        return dict(named), {}
    names = list(named)
    P = np.array([named[n] for n in names], dtype=float)
    A = np.array(anchors, dtype=float)

    inlier_tol = 0.04 * min(w, h)

    def score(sx: float, sy: float, dx: float, dy: float) -> tuple[float, Any]:
        Q = np.stack([P[:, 0] * sx + dx * w, P[:, 1] * sy + dy * h], axis=1)
        d = np.sqrt(((Q[:, None, :] - A[None, :, :]) ** 2).sum(-1))
        nearest = d.min(axis=1)
        # 先比"有几个点吸得上"（内点数），再比距离：字母笔画凑出的假锚点只能拉偏
        # 距离和，拉不动内点数——RANSAC 的思路（实机：C 被两个假交点拽偏了 40px）
        inliers = int((nearest <= inlier_tol).sum())
        dist_sum = float(np.minimum(nearest, 0.08 * min(w, h)).sum())
        # 距离和为主、内点数为辅（每多一个内点抵 1% 的距离）：纯内点数会在两个
        # 都"全吸上"的变换之间随机挑，把点吸到邻近的假交点上
        return dist_sum - inliers * 0.01 * min(w, h), Q

    best = (score(1, 1, 0, 0)[0], (1.0, 1.0, 0.0, 0.0))
    for sx in (0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15):
        for sy in (0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15):
            for dx in np.arange(-0.12, 0.121, 0.02):
                for dy in np.arange(-0.12, 0.121, 0.02):
                    sc, _ = score(sx, sy, float(dx), float(dy))
                    if sc < best[0] - 1e-9:
                        best = (sc, (sx, sy, float(dx), float(dy)))
    _, Q = score(*best[1])
    tol = 0.08 * min(w, h)
    # 用已经吸得上的点做最小二乘精修（x、y 各自 scale+shift），再吸一次——
    # 网格步长 5%/2% 太粗，精修一两轮就能把整体偏差压到几个像素
    for _ in range(2):
        d = np.sqrt(((Q[:, None, :] - A[None, :, :]) ** 2).sum(-1))
        nearest_idx = d.argmin(axis=1)
        ok = d.min(axis=1) <= tol
        if ok.sum() < 3:
            break
        Pm, Am = P[ok], A[nearest_idx[ok]]
        Qn = Q.copy()
        for axis in (0, 1):
            x, y = Pm[:, axis], Am[:, axis]
            if float(np.ptp(x)) < 1e-6:
                continue
            k, b = np.polyfit(x, y, 1)
            if 0.7 <= k <= 1.3:
                Qn[:, axis] = P[:, axis] * k + b
        Q = Qn
    snapped: dict[str, Point] = {}
    dist: dict[str, float] = {}
    for i, n in enumerate(names):
        d = np.sqrt(((A - Q[i]) ** 2).sum(-1))
        order = np.argsort(d)
        d0 = float(d[order[0]])
        d1 = float(d[order[1]]) if len(order) > 1 else float("inf")
        if d0 <= tol and d0 * 1.25 <= d1 + 1e-9:
            snapped[n] = (float(A[order[0]][0]), float(A[order[0]][1]))
            dist[n] = d0
        else:
            snapped[n] = (float(Q[i][0]), float(Q[i][1]))
    return snapped, dist


def drawn_edges(
    points: dict[str, Point],
    lines: list[dict[str, Any]],
    size: tuple[int, int],
    anchored: set[str] | None = None,
) -> set[frozenset[str]]:
    """两个命名点之间是否有一条**画出来的**直线段：都落在同一条检测线段上（含内部）。

    anchored：吸附到像素交点/角上的点。线段的墨迹区间常在角上短一截（角上是字母、
    笔画没接上），一条线明明指着角、区间却差几十像素——对已确认在别的线上的点，
    沿线方向放得更宽（15% 线长）；普通点只放 10%。
    """
    w, h = size
    tol = 0.03 * min(w, h)  # 角点是几条线交点的加权簇心，离每条线都可能差十来个像素
    anchored = anchored or set()
    edges: set[frozenset[str]] = set()
    for a, b in itertools.combinations(points, 2):
        pa, pb = points[a], points[b]
        for ln in lines:
            length = math.hypot(ln["b"][0] - ln["a"][0], ln["b"][1] - ln["a"][1])
            along_a = max(0.06 * min(w, h), (0.15 if a in anchored else 0.1) * length)
            along_b = max(0.06 * min(w, h), (0.15 if b in anchored else 0.1) * length)
            if _on_segment(pa, ln["a"], ln["b"], tol, along_a) and _on_segment(pb, ln["a"], ln["b"], tol, along_b):
                edges.add(frozenset((a, b)))
                break
    return edges


# ────────────────────────────── 文字块与区域 ──────────────────────────────


def text_blobs(ink: Any, lines: list[dict[str, Any]], size: tuple[int, int]) -> list[dict[str, Any]]:
    """去掉线上的墨迹后剩下的连通块 = 字母/数字。返回 [{"center":(x,y),"box":(x0,y0,x1,y1),"area":n}]。"""
    import numpy as np

    w, h = size
    mask = ink.copy()
    # 抹掉线段附近 3px 的墨迹
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return []
    keep = np.ones(len(xs), dtype=bool)
    for ln in lines:
        (ax, ay), (bx, by) = ln["a"], ln["b"]
        ux, uy = bx - ax, by - ay
        n = math.hypot(ux, uy) or 1.0
        d = np.abs((xs - ax) * uy - (ys - ay) * ux) / n
        t = ((xs - ax) * ux + (ys - ay) * uy) / (n * n)
        keep &= ~((d <= 3.0) & (t >= -0.01) & (t <= 1.01))
    xs, ys = xs[keep], ys[keep]
    if len(xs) == 0:
        return []
    # 连通块：在稀疏点集上做并查集（8 邻域）
    coord_to_idx = {(int(x), int(y)): i for i, (x, y) in enumerate(zip(xs, ys))}
    parent = list(range(len(xs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (x, y) in enumerate(zip(xs, ys)):
        for dx, dy in ((1, 0), (0, 1), (1, 1), (-1, 1)):
            j = coord_to_idx.get((int(x) + dx, int(y) + dy))
            if j is not None:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri
    groups: dict[int, list[int]] = {}
    for i in range(len(xs)):
        groups.setdefault(find(i), []).append(i)
    blobs: list[dict[str, Any]] = []
    min_area = max(6, int(0.0002 * w * h))
    for members in groups.values():
        if len(members) < min_area:
            continue
        bx, by = xs[members], ys[members]
        x0, x1, y0, y1 = int(bx.min()), int(bx.max()), int(by.min()), int(by.max())
        if max(x1 - x0, y1 - y0) > 0.12 * min(w, h):
            continue  # 太大的不是字（残留的线段/阴影）
        blobs.append({"center": (float(bx.mean()), float(by.mean())), "box": (x0, y0, x1, y1), "area": len(members)})
    # 相邻的小块合成一个字（"cm"、"12"）
    merged: list[dict[str, Any]] = []
    for b in sorted(blobs, key=lambda b: b["box"][0]):
        for m in merged:
            gap = 0.6 * max(m["box"][3] - m["box"][1], b["box"][3] - b["box"][1], 4)
            if (
                b["box"][0] - m["box"][2] <= gap
                and abs((b["box"][1] + b["box"][3]) - (m["box"][1] + m["box"][3])) / 2 <= gap
            ):
                x0, y0 = min(m["box"][0], b["box"][0]), min(m["box"][1], b["box"][1])
                x1, y1 = max(m["box"][2], b["box"][2]), max(m["box"][3], b["box"][3])
                m["box"] = (x0, y0, x1, y1)
                m["center"] = ((x0 + x1) / 2, (y0 + y1) / 2)
                m["area"] += b["area"]
                break
        else:
            merged.append(dict(b))
    return merged


def _polygon_area(poly: list[Point]) -> float:
    s = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def _point_in_polygon(p: Point, poly: list[Point]) -> bool:
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            xin = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
            if x < xin:
                inside = not inside
    return inside


def _line_crosses_interior(a: Point, b: Point, poly: list[Point], tol: float) -> bool:
    """线段 ab 是否穿过多边形内部（只擦过顶点/沿边走不算）。"""
    n = len(poly)
    # 采样 ab 上的点，看是否有严格在内部且离所有边都不近的点
    for k in range(1, 40):
        t = k / 40
        p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        if not _point_in_polygon(p, poly):
            continue
        if all(_point_line_distance(p, poly[i], poly[(i + 1) % n]) > tol for i in range(n)):
            return True
    return False


def resolve_region(
    label_at: Point,
    points: dict[str, Point],
    edges: set[frozenset[str]],
    lines: list[dict[str, Any]],
    size: tuple[int, int],
    allowed_sizes: set[int] | None = None,
) -> list[str] | None:
    """一个标注位置落在哪个"由真线围成、内部没被别的线切开"的最小区域里（三角形/四边形）。

    allowed_sizes：题干给的约束（"三个小三角形的面积已在图中标出" → 只认三角形）。
    图和题要合起来读：像素说它在某个四边形里，题干说标的是三角形，那就是像素这边
    少认了一条线——宁可不下结论，也不把一个四边形当条件。
    """
    w, h = size
    tol = 0.015 * min(w, h)
    names = list(points)
    candidates: list[tuple[float, list[str]]] = []
    for k in sorted(allowed_sizes) if allowed_sizes else (3, 4):
        if k not in (3, 4):
            continue
        for combo in itertools.combinations(names, k):
            # 找一个环，使得相邻两点都是画出来的边
            for perm in itertools.permutations(combo[1:]):
                cycle = (combo[0],) + perm
                if all(frozenset((cycle[i], cycle[(i + 1) % k])) in edges for i in range(k)):
                    poly = [points[c] for c in cycle]
                    if k == 4 and _self_intersecting(poly):
                        continue
                    if _has_flat_corner(poly, tol):
                        continue  # 三点共线的"四边形"其实是三角形，别冒充
                    if not _point_in_polygon(label_at, poly):
                        continue
                    # 内部不许有别的命名点、不许被别的线切开
                    if any(
                        n not in cycle and _point_in_polygon(points[n], poly)
                        and all(_point_line_distance(points[n], poly[i], poly[(i + 1) % k]) > tol for i in range(k))
                        for n in names
                    ):
                        continue
                    if any(_line_crosses_interior(ln["a"], ln["b"], poly, tol) for ln in lines):
                        continue
                    candidates.append((_polygon_area(poly), list(cycle)))
                    break
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    return candidates[0][1]


def _has_flat_corner(poly: list[Point], tol: float) -> bool:
    n = len(poly)
    for i in range(n):
        p, q, r = poly[i - 1], poly[i], poly[(i + 1) % n]
        if _point_line_distance(q, p, r) <= tol:
            return True
    return False


def _self_intersecting(poly: list[Point]) -> bool:
    """非相邻两边严格相交 → 蝴蝶结（不是简单多边形）。用方向数判，不吃浮点误差。"""

    def orient(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    n = len(poly)
    for i in range(n):
        for j in range(i + 1, n):
            if abs(i - j) in (1, n - 1):
                continue
            a, b = poly[i], poly[(i + 1) % n]
            c, d = poly[j], poly[(j + 1) % n]
            o1, o2 = orient(a, b, c), orient(a, b, d)
            o3, o4 = orient(c, d, a), orient(c, d, b)
            if o1 * o2 < 0 and o3 * o4 < 0:
                return True
    return False


_UNIT_LABEL_RE = __import__("re").compile(r"(cm|mm|km|dm|厘米|毫米|米|千米|分米|°|度)", __import__("re").I)


def _segment_distance(p: Point, a: Point, b: Point) -> float:
    ux, uy = b[0] - a[0], b[1] - a[1]
    n2 = ux * ux + uy * uy
    if n2 < 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / n2))
    return math.hypot(p[0] - (a[0] + t * ux), p[1] - (a[1] + t * uy))


# ────────────────────────────── 总装 ──────────────────────────────


def ground_transcription(
    t: dict[str, Any],
    gray: Any,
    protected: set[frozenset[str]] | None = None,
    region_sizes: set[int] | None = None,
) -> dict[str, Any]:
    """用像素几何校准一份转写：点吸附到交点/端点、线段按真线判、标注按包含关系归属。

    只在有把握时改动，改动都记进 t["reconciled"]。任何环节失败都原样返回。
    """
    import numpy as np

    try:
        h, w = gray.shape
        if min(w, h) < 60:
            return t
        # 统一工作分辨率：短边 600~800。小图放大（线细、字小），大图缩回来——前端可能
        # 已经把裁图放大到几千像素，线粗成十几像素只会让霍夫峰散开、字块被当成线
        scale = 1.0
        if min(w, h) < 600 or min(w, h) > 900:
            from PIL import Image

            scale = (600 if min(w, h) < 600 else 800) / min(w, h)
            img = Image.fromarray(gray).resize((round(w * scale), round(h * scale)), Image.LANCZOS)
            gray = np.asarray(img, dtype=np.uint8)
            h, w = gray.shape
        ink = ink_mask(gray)
        lines = detect_lines(ink)
        if len(lines) < 3:
            return t
        size = (w, h)
        anchors = anchor_points(lines, size)
        named = {p["id"]: (float(p["x"]) * (w - 1), float(p["y"]) * (h - 1)) for p in t.get("points") or []}
        snapped, dist = align_named_points(named, anchors, size)
        notes: list[str] = []
        # 未吸附点回收：真交点常就在锚点表里，只是模型初判偏得超出常规吸附半径。
        # 实机：F 偏 10.9% 图高、在转写线段里度数为 0，带着错坐标画图——合并弦
        # A-M 绕过它、"7"区域无边界、面积标签丢失。未被占用的锚点在放宽半径内
        # 唯一匹配才收；含糊保持原判
        used_anchors = {(round(p[0], 3), round(p[1], 3)) for p in snapped.values()}
        wide = 0.15 * min(w, h)
        for n in list(named):
            if n in dist:
                continue
            q = snapped[n]
            free = [
                a for a in anchors
                if (round(a[0], 3), round(a[1], 3)) not in used_anchors
            ]
            free.sort(key=lambda a: math.hypot(a[0] - q[0], a[1] - q[1]))
            if not free:
                continue
            d0 = math.hypot(free[0][0] - q[0], free[0][1] - q[1])
            d1 = (
                math.hypot(free[1][0] - q[0], free[1][1] - q[1])
                if len(free) > 1 else float("inf")
            )
            if d0 <= wide and d1 >= 1.3 * d0:
                snapped[n] = (float(free[0][0]), float(free[0][1]))
                dist[n] = d0
                used_anchors.add((round(free[0][0], 3), round(free[0][1], 3)))
                notes.append(f"点 {n} 按放宽半径回收到未占用交点")
        t["snap_matched"], t["snap_total"] = len(dist), len(named)
        if len(dist) >= max(3, len(named) // 2):
            # 吸附成功的点够多才相信这套几何；写回坐标（归一化）
            for p in t.get("points") or []:
                sx, sy = snapped[p["id"]]
                p["x"], p["y"] = round(sx / (w - 1), 4), round(sy / (h - 1), 4)
            notes.append(f"点按像素交点校准 {len(dist)}/{len(named)}")
        else:
            return t
        # 文字遮挡不算断线：先取文字块，把被文字截断的线段区间重新量一遍再认边。
        # 实机：对角线在 E/5/F 文字簇处断开，A 端缺口超出容差 → A-F/A-M 边失踪 →
        # 标注「5」的归属区域建不起来，错误初判静默流入题面。
        # 桥接结果只用于认边（欠延伸有害）；resolve_region 的"线穿内部"守卫继续用
        # 原始区间（过延伸有害——实机：桥接把线尾接到了邻线墨迹上，延长段切进
        # AEF 内部，反把正确区域误杀）
        blobs = text_blobs(ink, lines, size)
        blob_boxes = [b["box"] for b in blobs]
        edge_lines = lines
        if blob_boxes:
            edge_lines = []
            for ln in lines:
                bridged = _inked_extent(ink, ln["rho"], ln["theta"], bridge_boxes=blob_boxes)
                edge_lines.append({**ln, "a": bridged[0], "b": bridged[1]} if bridged else ln)
        edges = drawn_edges(snapped, edge_lines, size, anchored=set(dist))
        # 线段：模型说有但像素说没有 → 去；像素说有但模型没说 → 补（有名字的两端、真线相连）
        claimed = {frozenset(s) for s in t.get("segments") or [] if len(s) == 2}
        protected = protected or set()
        kept = [
            s for s in t.get("segments") or []
            if len(s) == 2 and (frozenset(s) in edges or frozenset(s) in protected)
        ]
        edges |= {frozenset(s) for s in kept}
        added = [sorted(e) for e in edges - claimed]
        removed = [s for s in claimed - edges]
        # 补线只补"不是同一条直线上跨过其它点"的那种（A-B-C 共线时不补 A-C）
        added = [
            e for e in added
            if not any(
                n not in e and _on_segment(snapped[n], snapped[e[0]], snapped[e[1]], 0.02 * min(w, h))
                for n in snapped
            )
        ]
        if removed or added:
            notes.append(
                "线段按像素校正："
                + ("去 " + "、".join("-".join(sorted(s)) for s in removed) if removed else "")
                + (" 补 " + "、".join("-".join(e) for e in added) if added else "")
            )
        # 合并弦拆分：线段经过另一**已校准**命名点的邻域时在该点拆开
        # （A-M → A-F + F-M）。只在像素确认过的点上拆——错位点上拆弦是固化错误
        split_tol = 0.02 * min(w, h)
        segs = [list(s) for s in kept + added]
        changed = True
        while changed:
            changed = False
            out_segs: list[list[str]] = []
            seen_pairs: set[frozenset[str]] = set()
            for s in segs:
                u, v = s[0], s[1]
                mid = next(
                    (
                        n for n in dist
                        if n not in (u, v)
                        and _on_segment(snapped[n], snapped[u], snapped[v], split_tol)
                    ),
                    None,
                )
                pieces = [[u, mid], [mid, v]] if mid else [[u, v]]
                if mid:
                    changed = True
                    notes.append(f"线段 {u}-{v} 在 {mid} 处拆分")
                for piece in pieces:
                    key = frozenset(piece)
                    if len(key) == 2 and key not in seen_pairs:
                        seen_pairs.add(key)
                        out_segs.append(piece)
            segs = out_segs
        t["segments"] = segs
        # 标注归属：数字块 → 最小包含区域（blobs 已在线段桥接前取好）
        # 字母块（贴着命名点的文字块）先排除：剩下的块才是数值/文字标注。
        # 比较判定而不是半径一刀切：某个标注自己声明的位置（at）比最近命名点
        # 离这个块更近，它就是标注不是字母——实机：数字 5 距交点 E 34px 落进
        # 36px 排除半径被当字母吞掉，归属静默失败（bench 裁图 36.4px 恰好幸存）
        letter_radius = 0.06 * min(w, h)
        point_ids = set(named)
        declared_ats = [
            (float(a[0]) * (w - 1), float(a[1]) * (h - 1))
            for label in t.get("labels") or []
            if not is_point_letter_label(label.get("text"), point_ids)
            and isinstance((a := label.get("at")), (list, tuple)) and len(a) == 2
        ]
        label_blobs = []
        for b in blobs:
            point_d = min(
                (math.hypot(b["center"][0] - q[0], b["center"][1] - q[1]) for q in snapped.values()),
                default=float("inf"),
            )
            at_d = min(
                (math.hypot(b["center"][0] - q[0], b["center"][1] - q[1]) for q in declared_ats),
                default=float("inf"),
            )
            if point_d > letter_radius or at_d <= point_d:
                label_blobs.append(b)
        # 每个标注：候选 = 附近的文字块（≤10%）。最近的块明显更近就用它；几个块差不多近时，
        # 用模型自己说的字母（on）当裁判——哪个块所在的区域和 on 重合最多就选哪个，
        # 仍分不出就不下结论（宁可退回"附近"线索，也不断错归属）
        reach = 0.10 * min(w, h)
        unresolved: list[str] = []
        for label in t.get("labels") or []:
            text = str(label.get("text") or "")
            if is_point_letter_label(text, point_ids):
                continue  # 顶点字母不是条件：不归属、不盖 resolved 章
            at = label.get("at")
            if isinstance(at, (list, tuple)) and len(at) == 2:
                rx, ry = float(at[0]) * (w - 1), float(at[1]) * (h - 1)
            else:
                on0 = [n for n in (label.get("on") or []) if n in snapped]
                if not on0:
                    continue
                rx = sum(snapped[n][0] for n in on0) / len(on0)
                ry = sum(snapped[n][1] for n in on0) / len(on0)
            cands = sorted(
                (b for b in label_blobs if math.hypot(b["center"][0] - rx, b["center"][1] - ry) <= reach),
                key=lambda b: math.hypot(b["center"][0] - rx, b["center"][1] - ry),
            )
            if not cands:
                unresolved.append(f"「{text}」附近无文字块")
                continue
            # 一个标注可能碎成几个块（"6" 和 "cm"、"12" 的两位数）：挨在一起的块算同一个词，
            # 不构成"两个候选"的歧义
            head = cands[0]
            cands = [head] + [
                b for b in cands[1:]
                if math.hypot(b["center"][0] - head["center"][0], b["center"][1] - head["center"][1]) > 0.08 * min(w, h)
            ]
            d0 = math.hypot(cands[0]["center"][0] - rx, cands[0]["center"][1] - ry)
            unit_label = bool(_UNIT_LABEL_RE.search(text))
            chosen: Point | None = None
            if len(cands) == 1 or d0 <= 0.02 * min(w, h) or math.hypot(cands[1]["center"][0] - rx, cands[1]["center"][1] - ry) >= 1.4 * d0:
                chosen = cands[0]["center"]
            elif not unit_label:
                on_set = set(label.get("on") or [])
                scored = []
                for b in cands[:4]:
                    face = resolve_region(b["center"], snapped, edges, lines, size, allowed_sizes=region_sizes)
                    scored.append((len(on_set & set(face)) if face else -1, b))
                scored.sort(key=lambda x: -x[0])
                if scored and scored[0][0] >= 1 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
                    chosen = scored[0][1]["center"]
            if chosen is None:
                unresolved.append(f"「{text}」候选块歧义未裁决")
                continue
            lx, ly = chosen
            if unit_label:
                # 带单位的量（8cm、30°）标在边上/角上：吸到最近的画出来的边
                best_edge, best_d = None, float("inf")
                for e in edges:
                    a, b = tuple(e)
                    d = _segment_distance((lx, ly), snapped[a], snapped[b])
                    if d < best_d:
                        best_edge, best_d = e, d
                if best_edge is not None and best_d <= 0.12 * min(w, h):
                    on = sorted(best_edge)
                    if list(label.get("on") or []) != on:
                        notes.append(f"标注「{text}」按位置贴在边 {''.join(on)}（原判 {''.join(label.get('on') or [])}）")
                    label["on"] = on
                    label["resolved"] = "geometry"
                continue
            region = resolve_region((lx, ly), snapped, edges, lines, size, allowed_sizes=region_sizes)
            if region:
                if list(label.get("on") or []) != region:
                    notes.append(f"标注「{text}」按位置落在 {''.join(region)}（原判 {''.join(label.get('on') or [])}）")
                label["on"] = region
                label["resolved"] = "geometry"
            else:
                unresolved.append(f"「{text}」找到块但区域解析失败")
        if unresolved:
            # 静默失败曾让错误初判以"已像素校准"的姿态流入题面（实机「5」两次）
            logger.info("figure geometry: 标注未按像素归属：%s", "；".join(unresolved))
        # 阴影核对：模型说的阴影环，内部像素得真的比纸暗（阴影是"偏暗的一片"，不是墨迹）
        paper = float(np.median(gray))
        confirmed: list[list[str]] = []
        for cycle in t.get("shaded") or []:
            names_c = [str(n) for n in cycle]
            if len(names_c) < 3 or any(n not in snapped for n in names_c):
                continue
            poly = [snapped[n] for n in names_c]
            cx = sum(p[0] for p in poly) / len(poly)
            cy = sum(p[1] for p in poly) / len(poly)
            samples = []
            for fx, fy in ((0.5, 0.5), (0.35, 0.35), (0.65, 0.35), (0.35, 0.65), (0.65, 0.65)):
                # 重心与顶点之间的插值点，都在多边形里
                for v in poly:
                    px_, py_ = cx + (v[0] - cx) * (fx - 0.5), cy + (v[1] - cy) * (fy - 0.5)
                    if _point_in_polygon((px_, py_), poly):
                        samples.append(gray[int(min(h - 1, max(0, py_))), int(min(w - 1, max(0, px_)))])
            if samples and paper - float(np.median(samples)) >= 25:
                confirmed.append(names_c)
            else:
                notes.append(f"阴影 {''.join(names_c)} 内部像素不比纸暗，不认")
        if confirmed or (t.get("shaded") and not confirmed):
            t["shaded"] = confirmed
            if confirmed:
                t["shaded_resolved"] = "geometry"
        if notes:
            t.setdefault("reconciled", []).extend(notes)
            logger.info("figure geometry grounding: %s", "；".join(notes))
        return t
    except Exception:  # noqa: BLE001 — 几何校准是加分项，失败不拦路
        logger.exception("figure geometry grounding failed")
        return t
