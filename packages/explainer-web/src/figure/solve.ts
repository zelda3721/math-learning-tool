/**
 * 把「点线角 + 约束」解成坐标，然后**逐条回代验证**。
 *
 * 顺序很重要：先解，再验，验不过就不给坐标。几何题最坏的失败不是画得丑，
 * 而是图上量出来的边长与题干说的不一致——孩子照着图数，得到的结论是错的。
 * 所以这里宁可拒绝出图，也不交付一张"看着像那么回事"的图。
 *
 * 解法是最小二乘：每条约束给一个残差，用高斯-牛顿迭代把总残差压下去。
 * 不用尺规构造那种按序作图，是因为约束的给法千变万化（先给两边再给夹角、
 * 或先给角再给边），按序构造要枚举一堆情形，而最小二乘对给法不敏感。
 *
 * 规范固定（去掉平移/旋转/翻转的自由度）：第一个点钉在原点，第二个点钉在 x 轴正向。
 * 否则同一个图有无穷多组坐标，解出来的结果每次都不一样，没法比对也没法缓存。
 */
import type { FigureConstraint, FigureSpec } from "@mathtutor/schema";

export type Point = { x: number; y: number };
export type Coords = Record<string, Point>;

export interface SolveResult {
  ok: boolean;
  coords: Coords;
  /** 未被满足的约束（人话描述），ok=false 时非空 */
  violations: string[];
  /** 最大残差，用于诊断 */
  residual: number;
}

/** 允许的误差：边长按相对误差，角度按度。比这更松就会看出图文不符 */
const LEN_TOL = 1e-3;
const DEG_TOL = 0.5;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function angleAt(o: Point, a: Point, b: Point): number {
  const v1x = a.x - o.x, v1y = a.y - o.y;
  const v2x = b.x - o.x, v2y = b.y - o.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-9 || n2 < 1e-9) return Number.NaN;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 单条约束的残差（0 表示恰好满足）。量纲统一到「长度」量级，便于一起最小化。 */
function residual(c: FigureConstraint, p: Coords, scale: number): number {
  const get = (id: string): Point | undefined => p[id];
  switch (c.kind) {
    case "length": {
      const a = get(c.from), b = get(c.to);
      return a && b ? dist(a, b) - c.value : 0;
    }
    case "equal-length": {
      const [a1, a2] = c.a.map(get);
      const [b1, b2] = c.b.map(get);
      return a1 && a2 && b1 && b2 ? dist(a1, a2) - dist(b1, b2) : 0;
    }
    case "angle":
    case "right-angle": {
      const o = get(c.at), a = get(c.from), b = get(c.to);
      if (!o || !a || !b) return 0;
      const want = c.kind === "right-angle" ? 90 : c.degrees;
      const got = angleAt(o, a, b);
      if (!Number.isFinite(got)) return 0;
      // 角度换算成长度量级：1° 约等于 scale/60，量纲一致才好一起收敛
      return ((got - want) / 60) * scale;
    }
    case "parallel":
    case "perpendicular": {
      const [a1, a2] = c.a.map(get);
      const [b1, b2] = c.b.map(get);
      if (!a1 || !a2 || !b1 || !b2) return 0;
      const ux = a2.x - a1.x, uy = a2.y - a1.y;
      const vx = b2.x - b1.x, vy = b2.y - b1.y;
      const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
      if (nu < 1e-9 || nv < 1e-9) return 0;
      // 平行 → 叉积为 0；垂直 → 点积为 0。都除以模长，变成无量纲再乘 scale
      const val = c.kind === "parallel" ? (ux * vy - uy * vx) : (ux * vx + uy * vy);
      return (val / (nu * nv)) * scale;
    }
    case "on-segment": {
      const q = get(c.point), a = get(c.from), b = get(c.to);
      if (!q || !a || !b) return 0;
      const ux = b.x - a.x, uy = b.y - a.y;
      const nu = Math.hypot(ux, uy);
      if (nu < 1e-9) return 0;
      if (c.ratio !== undefined) {
        const tx = a.x + ux * c.ratio, ty = a.y + uy * c.ratio;
        return Math.hypot(q.x - tx, q.y - ty);
      }
      // 只要求共线：点到直线的距离
      return ((q.x - a.x) * uy - (q.y - a.y) * ux) / nu;
    }
  }
}

function totalCost(spec: FigureSpec, p: Coords, scale: number): number {
  let sum = 0;
  for (const c of spec.constraints) {
    const r = residual(c, p, scale);
    sum += r * r;
  }
  return sum;
}

/** 人话描述一条没满足的约束——报错要能直接看懂哪里对不上 */
function describe(c: FigureConstraint, p: Coords): string {
  switch (c.kind) {
    case "length": {
      const a = p[c.from], b = p[c.to];
      const got = a && b ? dist(a, b) : Number.NaN;
      return `${c.from}${c.to} 要求长 ${c.value}，解出来是 ${got.toFixed(2)}`;
    }
    case "equal-length":
      return `${c.a.join("")} 与 ${c.b.join("")} 要求等长，解出来不等`;
    case "angle": {
      const got = angleAt(p[c.at]!, p[c.from]!, p[c.to]!);
      return `∠${c.from}${c.at}${c.to} 要求 ${c.degrees}°，解出来是 ${got.toFixed(1)}°`;
    }
    case "right-angle": {
      const got = angleAt(p[c.at]!, p[c.from]!, p[c.to]!);
      return `∠${c.from}${c.at}${c.to} 要求直角，解出来是 ${got.toFixed(1)}°`;
    }
    case "parallel":
      return `${c.a.join("")} 与 ${c.b.join("")} 要求平行，解出来不平行`;
    case "perpendicular":
      return `${c.a.join("")} 与 ${c.b.join("")} 要求垂直，解出来不垂直`;
    case "on-segment":
      return `${c.point} 要求在 ${c.from}${c.to} 上，解出来不在`;
  }
}

/** 逐条回代：这是"图不许和题干对不上"的最后一道关 */
export function checkConstraints(spec: FigureSpec, p: Coords): string[] {
  const out: string[] = [];
  for (const c of spec.constraints) {
    let bad = false;
    switch (c.kind) {
      case "length": {
        const a = p[c.from], b = p[c.to];
        bad = !a || !b || Math.abs(dist(a, b) - c.value) > Math.max(LEN_TOL, c.value * LEN_TOL);
        break;
      }
      case "equal-length": {
        const [a1, a2] = c.a.map((id) => p[id]);
        const [b1, b2] = c.b.map((id) => p[id]);
        bad = !a1 || !a2 || !b1 || !b2 ||
          Math.abs(dist(a1, a2) - dist(b1, b2)) > Math.max(LEN_TOL, dist(a1, a2) * LEN_TOL);
        break;
      }
      case "angle":
      case "right-angle": {
        const o = p[c.at], a = p[c.from], b = p[c.to];
        const want = c.kind === "right-angle" ? 90 : c.degrees;
        const got = o && a && b ? angleAt(o, a, b) : Number.NaN;
        bad = !Number.isFinite(got) || Math.abs(got - want) > DEG_TOL;
        break;
      }
      default: {
        const scale = 1;
        bad = Math.abs(residual(c, p, scale)) > 1e-2;
      }
    }
    if (bad) out.push(describe(c, p));
  }
  return out;
}

/**
 * 解算坐标。多次随机重启，取代价最低的一组——最小二乘会掉进局部极小，
 * 尤其是三角形被解成翻转的那一支。
 */
export function solveFigure(spec: FigureSpec, seed = 1): SolveResult {
  const ids = spec.points.map((p) => p.id);
  if (ids.length < 2) {
    return { ok: false, coords: {}, violations: ["至少要有两个点"], residual: Infinity };
  }
  // 尺度：取声明的最长边，没有就用 10。它决定初值范围与角度残差的量纲换算
  const lengths = spec.constraints.flatMap((c) => (c.kind === "length" ? [c.value] : []));
  const scale = lengths.length ? Math.max(...lengths) : 10;

  let rng = seed >>> 0 || 1;
  const rand = () => {
    // xorshift：不用 Math.random，同一份 spec 每次解出同一张图（可缓存、可比对）
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >> 17;
    rng ^= rng << 5; rng >>>= 0;
    return rng / 0xffffffff;
  };

  let best: { coords: Coords; cost: number } | null = null;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const p: Coords = {};
    spec.points.forEach((pt, i) => {
      if (pt.at) p[pt.id] = { x: pt.at[0], y: pt.at[1] };
      else if (attempt === 0) {
        // 第一次用规则初值（正多边形），多数图形一次就收敛
        const t = (i / ids.length) * Math.PI * 2;
        p[pt.id] = { x: Math.cos(t) * scale * 0.6, y: Math.sin(t) * scale * 0.6 };
      } else {
        p[pt.id] = { x: (rand() - 0.5) * 2 * scale, y: (rand() - 0.5) * 2 * scale };
      }
    });

    // 数值梯度下降（带动量），对小规模图足够；解析梯度收益不抵复杂度
    let step = scale * 0.05;
    let cost = totalCost(spec, p, scale);
    for (let iter = 0; iter < 900 && cost > 1e-12; iter += 1) {
      const eps = scale * 1e-6;
      let moved = false;
      for (const id of ids) {
        const anchored = spec.points.find((q) => q.id === id)?.at;
        if (anchored) continue; // 显式给了坐标的点不动
        for (const axis of ["x", "y"] as const) {
          const base = p[id]![axis];
          p[id]![axis] = base + eps;
          const up = totalCost(spec, p, scale);
          p[id]![axis] = base - eps;
          const down = totalCost(spec, p, scale);
          p[id]![axis] = base;
          const grad = (up - down) / (2 * eps);
          if (!Number.isFinite(grad)) continue;
          const next = base - grad * step;
          if (Number.isFinite(next)) { p[id]![axis] = next; moved = true; }
        }
      }
      const nextCost = totalCost(spec, p, scale);
      if (!moved) break;
      // 代价没下降就收缩步长；下降就略微放大，避免在窄谷里爬不动
      step = nextCost < cost ? step * 1.05 : step * 0.5;
      cost = nextCost;
      if (step < scale * 1e-9) break;
    }

    if (!best || cost < best.cost) best = { coords: JSON.parse(JSON.stringify(p)), cost };
    if (best.cost < 1e-10) break;
  }

  const coords = normalizeGauge(best!.coords, ids);
  const violations = checkConstraints(spec, coords);
  return {
    ok: violations.length === 0,
    coords,
    violations,
    residual: Math.sqrt(best!.cost),
  };
}

/**
 * 固定平移/旋转/翻转：第一个点移到原点，第二个点转到 x 轴正向，
 * 并让整体重心在 y 轴上方（避免同一个图一会儿正一会儿倒）。
 * 不做这一步，同一份 spec 每次解出的坐标都不同，缓存与比对都无从谈起。
 */
function normalizeGauge(p: Coords, ids: string[]): Coords {
  const a = p[ids[0]!]!;
  const b = p[ids[1]!]!;
  const dx = b.x - a.x, dy = b.y - a.y;
  const theta = Math.atan2(dy, dx);
  const cos = Math.cos(-theta), sin = Math.sin(-theta);
  const out: Coords = {};
  for (const id of ids) {
    const q = p[id]!;
    const x = q.x - a.x, y = q.y - a.y;
    out[id] = { x: x * cos - y * sin, y: x * sin + y * cos };
  }
  const meanY = ids.reduce((s, id) => s + out[id]!.y, 0) / ids.length;
  if (meanY < 0) for (const id of ids) out[id]!.y = -out[id]!.y + 0;
  for (const id of ids) {
    // +0 归一：-0 会让 toEqual 与缓存键都不稳定
    out[id]!.x = Math.round(out[id]!.x * 1e6) / 1e6 + 0;
    out[id]!.y = Math.round(out[id]!.y * 1e6) / 1e6 + 0;
  }
  return out;
}
