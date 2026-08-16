/**
 * 把解出来的坐标画成 SVG。纯字符串输出，不碰 DOM——
 * 这样服务端、测试、前端都能用同一份实现，画出来的东西必然一致。
 *
 * 只画「已经验证过」的图：solveFigure 说 ok=false 时这里直接返回 null，
 * 由调用方退回纯文字。一张边长与题干对不上的图，比没有图坏得多。
 */
import type { FigureSpec } from "@mathtutor/schema";
import { solveFigure, type Coords } from "./solve.js";

export interface RenderOptions {
  width?: number;
  /** 画布内边距（要留出标签的位置） */
  padding?: number;
  /** 与讲解画面同源的配色 */
  stroke?: string;
  shade?: string;
}

export interface FigureRender {
  svg: string;
  width: number;
  height: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 把数学坐标（y 向上）映射到屏幕坐标（y 向下），并等比缩放到画布内 */
function project(coords: Coords, width: number, padding: number) {
  const pts = Object.values(coords);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const inner = width - padding * 2;
  const scale = inner / w;
  const height = Math.round(h * scale + padding * 2);
  return {
    height,
    to: (p: { x: number; y: number }) => ({
      x: padding + (p.x - minX) * scale,
      // y 翻转：数学里 y 向上，屏幕上 y 向下
      y: height - padding - (p.y - minY) * scale,
    }),
    scale,
  };
}

export function renderFigure(spec: FigureSpec, options: RenderOptions = {}): FigureRender | null {
  const solved = solveFigure(spec);
  if (!solved.ok) return null;
  return renderSolved(spec, solved.coords, options);
}

/** 已有坐标时直接画（讲解侧可能已经解过一次，不必重解） */
export function renderSolved(
  spec: FigureSpec,
  coords: Coords,
  options: RenderOptions = {},
): FigureRender {
  const width = options.width ?? 320;
  const padding = options.padding ?? 34;
  const stroke = options.stroke ?? "#16203a";
  const shade = options.shade ?? "rgba(43,92,230,.14)";
  const { height, to, scale } = project(coords, width, padding);
  const parts: string[] = [];
  // 图形重心（屏幕坐标）：标注一律往背离重心的方向推，否则会压在图里
  const screenPts = spec.points.map((pt) => coords[pt.id]).filter(Boolean).map((q) => to(q!));
  const centroid = {
    x: screenPts.reduce((s2, p2) => s2 + p2.x, 0) / Math.max(1, screenPts.length),
    y: screenPts.reduce((s2, p2) => s2 + p2.y, 0) / Math.max(1, screenPts.length),
  };
  /** 把点限制在画布内，留出文字自身的宽度——顶点名跑到画布外就等于没画 */
  const clamp = (x: number, y: number) => ({
    x: Math.min(width - 10, Math.max(10, x)),
    y: Math.min(height - 8, Math.max(10, y)),
  });

  // 阴影多边形先画，压在线下面
  for (const poly of spec.polygons) {
    const pts = poly.points.map((id) => coords[id]).filter(Boolean).map((p) => to(p!));
    if (pts.length < 3) continue;
    parts.push(
      `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" ` +
        `fill="${poly.shaded ? shade : "none"}" stroke="${stroke}" stroke-width="1.5"/>`,
    );
    // 区域标签写在重心：面积数值属于那块区域，不该漂在图外
    if (poly.label) {
      const cx = pts.reduce((s2, p2) => s2 + p2.x, 0) / pts.length;
      const cy = pts.reduce((s2, p2) => s2 + p2.y, 0) / pts.length;
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="15" font-weight="600" ` +
          `fill="${stroke}" text-anchor="middle" dominant-baseline="middle">${esc(poly.label)}</text>`,
      );
    }
  }

  for (const c of spec.circles) {
    const o = coords[c.center];
    if (!o) continue;
    const r =
      c.radius !== undefined
        ? c.radius * scale
        : c.through && coords[c.through]
          ? Math.hypot(coords[c.through]!.x - o.x, coords[c.through]!.y - o.y) * scale
          : 0;
    if (r <= 0) continue;
    const p = to(o);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
  }

  for (const seg of spec.segments) {
    const a = coords[seg.from], b = coords[seg.to];
    if (!a || !b) continue;
    const pa = to(a), pb = to(b);
    parts.push(
      `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" ` +
        `stroke="${stroke}" stroke-width="1.5"${seg.style === "dashed" ? ' stroke-dasharray="5 4"' : ""}/>`,
    );
    if (seg.label) {
      // 标注放在边的中点、垂直向外偏一点，避免压在线上
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const n = Math.hypot(dx, dy) || 1;
      // 垂直方向有两个，选背离重心的那个：另一个会把标注推进图形内部压住线
      let ox = (-dy / n) * 13, oy = (dx / n) * 13;
      if ((mx + ox - centroid.x) ** 2 + (my + oy - centroid.y) ** 2 <
          (mx - ox - centroid.x) ** 2 + (my - oy - centroid.y) ** 2) {
        ox = -ox; oy = -oy;
      }
      const lp = clamp(mx + ox, my + oy);
      parts.push(
        `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" font-size="12" fill="${stroke}" ` +
          `text-anchor="middle" dominant-baseline="middle">${esc(seg.label)}</text>`,
      );
    }
  }

  // 角标记：直角画小方块，其余画弧
  for (const ang of spec.angles) {
    const o = coords[ang.at], a = coords[ang.from], b = coords[ang.to];
    if (!o || !a || !b) continue;
    const po = to(o), pa = to(a), pb = to(b);
    const u = norm(pa.x - po.x, pa.y - po.y);
    const v = norm(pb.x - po.x, pb.y - po.y);
    const r = 16;
    if (ang.right) {
      const c1 = { x: po.x + u.x * r, y: po.y + u.y * r };
      const c2 = { x: po.x + u.x * r + v.x * r, y: po.y + u.y * r + v.y * r };
      const c3 = { x: po.x + v.x * r, y: po.y + v.y * r };
      parts.push(
        `<polyline points="${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${c3.x.toFixed(1)},${c3.y.toFixed(1)}" ` +
          `fill="none" stroke="${stroke}" stroke-width="1.2"/>`,
      );
    } else {
      const s = { x: po.x + u.x * r, y: po.y + u.y * r };
      const e = { x: po.x + v.x * r, y: po.y + v.y * r };
      const cross = u.x * v.y - u.y * v.x;
      parts.push(
        `<path d="M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 0 ${cross > 0 ? 1 : 0} ${e.x.toFixed(1)} ${e.y.toFixed(1)}" ` +
          `fill="none" stroke="${stroke}" stroke-width="1.2"/>`,
      );
    }
    if (ang.label) {
      const m = norm(u.x + v.x, u.y + v.y);
      parts.push(
        `<text x="${(po.x + m.x * (r + 12)).toFixed(1)}" y="${(po.y + m.y * (r + 12)).toFixed(1)}" ` +
          `font-size="12" fill="${stroke}" text-anchor="middle" dominant-baseline="middle">${esc(ang.label)}</text>`,
      );
    }
  }

  // 顶点与名字最后画，压在最上层
  for (const pt of spec.points) {
    const q = coords[pt.id];
    if (!q) continue;
    const p = to(q);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${stroke}"/>`);
    const name = pt.label ?? pt.id;
    // 顶点名往背离重心的方向推；只有一个点时没有方向可言，往左上放
    const away = screenPts.length > 1 ? norm(p.x - centroid.x, p.y - centroid.y) : { x: -1, y: -1 };
    const np = clamp(p.x + away.x * 15, p.y + away.y * 15);
    parts.push(
      `<text x="${np.x.toFixed(1)}" y="${np.y.toFixed(1)}" font-size="13" ` +
        `font-weight="600" fill="${stroke}" text-anchor="middle" dominant-baseline="middle">${esc(name)}</text>`,
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${esc(spec.note ?? "题目配图")}">${parts.join("")}</svg>`;
  return { svg, width, height };
}

function norm(x: number, y: number) {
  const n = Math.hypot(x, y) || 1;
  return { x: x / n, y: y / n };
}
