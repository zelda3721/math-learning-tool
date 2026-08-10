/**
 * 场景解算：把一拍的 BeatState 变成「可画的几何」——纯数据层，不碰 DOM。
 *
 * 两条不可让步的规则（宪法第 5 条在 Web 侧的落点）：
 * 1. 全场景共享**一个**坐标系。曲线、根、辅助线、切线、矩形必须落在同一套数据坐标上，
 *    否则「根在曲线与 x 轴交点」这种最基本的数学关系画面上就是错位的。
 * 2. 算不出来就不画。函数编译/采样失败一律产出 issue，绝不退化成装饰性曲线。
 */
import type { BeatState, GroupState } from "../fold.js";
import { compileExpression } from "../math/expr.js";
import { sampleFunction } from "../math/sample.js";
import { buildCoordSystem, unionExtents, type CoordSystem, type Extents } from "../math/coords.js";

export interface SceneIssue {
  kind: "uncomputable-curve" | "unknown-primitive" | "inconsistent-count";
  detail: string;
  objectId?: string;
}

/** 一段折线（已在数据坐标下） */
export type Polyline = [number, number][];

export interface CurveShape {
  kind: "curve";
  id: string;
  label?: string;
  /** 采样得到的分段折线；渐近线处断开 */
  segments: Polyline[];
  /** 逐段描出用：总长度占比，让"曲线怎么长出来"可见 */
  role: "primary" | "support";
}

export interface SegmentShape {
  kind: "segment";
  id: string;
  label?: string;
  from: [number, number];
  to: [number, number];
  /** tangent=切线（结论） / secant=割线（过程） / guide=辅助线 */
  role: "tangent" | "secant" | "guide" | "arrow";
  /** 割线/切线的斜率，用于标注 */
  slope?: number;
}

export interface PointShape {
  kind: "point";
  id: string;
  label?: string;
  at: [number, number];
  /** open=空心（不含该点，如极限的去心邻域） */
  open?: boolean;
  role: "root" | "sample" | "limit" | "plain";
}

export interface RectsShape {
  kind: "rects";
  id: string;
  label?: string;
  /** [左, 右, 高]，数据坐标 */
  rects: [number, number, number][];
  approxArea?: number;
}

export interface AxesShape {
  kind: "axes";
  id: string;
}

/** 数量单位：可数的记号（守恒的可视载体） */
export interface UnitsShape {
  kind: "units";
  id: string;
  label?: string;
  units: { id: string; weight: number; swapped?: boolean; swappedTo?: string; kind?: string; side?: string }[];
  ghost?: boolean;
  emphasis?: boolean;
  note?: string;
  unitScale?: number;
  /** spec 声明的语义色名；布局层映射到配色盘 */
  color?: string;
  /** 每个单位排几列（spec 的 columns），布局层据此分块 */
  columns?: number;
  /** 天平：左右盘 */
  side?: "left" | "right";
}

/**
 * 量：连续的大小，画成长度正比于数值的条。
 * 与 UnitsShape 是两种东西——集要能一个个数出来，量要能一眼比出长短。
 */
export interface MagnitudeShape {
  kind: "magnitude";
  id: string;
  label?: string;
  value: number;
  color?: string;
  emphasis?: boolean;
  note?: string;
}

/** 声明了宽高的几何矩形（题卡、缺口条…）：按声明的长宽比画出来，不降级成一行字 */
export interface ExtentShape {
  kind: "extent";
  id: string;
  label?: string;
  /** 声明的宽高（相对单位，布局层按可用空间等比缩放） */
  w: number;
  h: number;
  color?: string;
  emphasis?: boolean;
}

export interface LabelShape {
  kind: "label";
  id: string;
  text: string;
  /** 未知构件的中性占位（绝不画装饰图形） */
  placeholder?: boolean;
}

export type Shape =
  | CurveShape
  | SegmentShape
  | PointShape
  | RectsShape
  | AxesShape
  | UnitsShape
  | MagnitudeShape
  | ExtentShape
  | LabelShape;

export interface Scene {
  /** 需要坐标系的图元（数学图） */
  plotted: Shape[];
  /** 不需要坐标系的图元（数量记号、标签） */
  flowed: Shape[];
  coords: CoordSystem | null;
  issues: SceneIssue[];
  teachingLine?: string;
  counts: BeatState["counts"];
  conservation?: BeatState["conservation"];
  equality?: BeatState["equality"];
  /** 全体声明色（含未登场的组）：布局层解析"换成了哪一类"时要用 */
  declaredColors: Record<string, string>;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number"
    ? [v[0], v[1]]
    : null;

const range = (v: unknown): [number, number] | null => pair(v);

/** 数量型（展开成单位记号）还是几何型（进坐标系） */
const PLOTTED_PRIMITIVES = new Set([
  "function_curve", "axes", "number_line", "dot", "line", "arrow", "polygon",
  "tangent_line", "secant_line", "riemann_rects", "limit_approach", "composition_chain",
]);

/**
 * 解算一拍。samples 控制曲线采样密度（按画布宽度自适应）。
 */
export function solveScene(beat: BeatState, width: number, height: number, samples = 600): Scene {
  const issues: SceneIssue[] = [];
  const plotted: Shape[] = [];
  const flowed: Shape[] = [];
  const extentParts: Partial<Extents>[] = [];

  for (const g of beat.groups) {
    if (!PLOTTED_PRIMITIVES.has(g.primitive)) {
      // 数量型：展开成可数记号
      if (g.units.length > 0 || g.quantity !== undefined) {
        flowed.push(unitsShape(g));
      } else if (g.magnitude !== undefined) {
        // 量：画成条，长短即大小
        flowed.push({
          kind: "magnitude",
          id: g.id,
          value: g.magnitude,
          ...(g.label !== undefined ? { label: g.label } : {}),
          ...(g.color !== undefined ? { color: g.color } : {}),
          ...(g.emphasis ? { emphasis: true as const } : {}),
          ...(g.note !== undefined ? { note: g.note } : {}),
        });
      } else if (extentOf(g) !== null) {
        // 声明了宽高的矩形：按长宽比画出来
        const e = extentOf(g)!;
        flowed.push({
          kind: "extent",
          id: g.id,
          w: e[0],
          h: e[1],
          ...(g.label !== undefined ? { label: g.label } : {}),
          ...(g.color !== undefined ? { color: g.color } : {}),
          ...(g.emphasis ? { emphasis: true as const } : {}),
        });
      } else if (g.primitive === "relation_node" || g.label) {
        flowed.push({ kind: "label", id: g.id, text: g.label ?? g.meaning ?? g.id });
      } else {
        issues.push({
          kind: "unknown-primitive",
          detail: `未知图元 ${g.primitive}`,
          objectId: g.id,
        });
        flowed.push({ kind: "label", id: g.id, text: g.label ?? g.primitive, placeholder: true });
      }
      continue;
    }
    solvePlotted(g, samples, plotted, extentParts, issues);
  }

  // 天平也当作数量记号处理（左右盘）
  const extents = unionExtents(extentParts);
  const coords = extents ? buildCoordSystem(extents, { w: width, h: height }) : null;

  for (const c of beat.counts) {
    if (c.claimed !== c.actual) {
      issues.push({
        kind: "inconsistent-count",
        detail: `${c.groupId}：宣称 ${c.claimed} 个，实际 ${c.actual} 个`,
        objectId: c.groupId,
      });
    }
  }

  return {
    plotted,
    flowed,
    coords,
    issues,
    teachingLine: beat.teachingLine,
    counts: beat.counts,
    conservation: beat.conservation,
    equality: beat.equality,
    declaredColors: beat.declaredColors ?? {},
  };
}

/** 声明了正的宽高才算几何矩形；缺一个就不是（不猜） */
function extentOf(g: GroupState): [number, number] | null {
  const w = num(g.params?.width, Number.NaN);
  const h = num(g.params?.height, Number.NaN);
  return w > 0 && h > 0 ? [w, h] : null;
}

function unitsShape(g: GroupState): UnitsShape {
  return {
    kind: "units",
    id: g.id,
    label: g.label ?? g.meaning,
    color: g.color,
    units: g.units.map((u) => ({
      id: u.id,
      weight: u.weight ?? 1,
      swapped: u.swapped,
      swappedTo: u.swappedTo,
      kind: u.kind,
      side: u.side,
    })),
    ghost: g.ghost,
    emphasis: g.emphasis,
    note: g.note,
    unitScale: g.unitScale,
    columns: (() => {
      const c = num(g.params?.columns, Number.NaN);
      return Number.isFinite(c) && c >= 1 ? Math.floor(c) : undefined;
    })(),
    side: g.units[0]?.side,
  };
}

/** 采样一条表达式曲线；失败返回 null 并记 issue（绝不返回假曲线） */
function sampleExpression(
  id: string,
  p: Record<string, unknown>,
  samples: number,
  issues: SceneIssue[],
  exprKey = "expression",
  varKey = "variable",
  rangeKey = "x_range",
): { segments: Polyline[]; yMin: number; yMax: number; xMin: number; xMax: number } | null {
  const expr = typeof p[exprKey] === "string" ? (p[exprKey] as string) : null;
  const variable = typeof p[varKey] === "string" ? (p[varKey] as string) : "x";
  const xr = range(p[rangeKey]) ?? [-5, 5];
  if (!expr) {
    issues.push({ kind: "uncomputable-curve", detail: "缺少表达式", objectId: id });
    return null;
  }
  const compiled = compileExpression(expr, variable);
  if (!compiled.ok) {
    issues.push({
      kind: "uncomputable-curve",
      detail: `${expr}：${compiled.error}`,
      objectId: id,
    });
    return null;
  }
  const curve = sampleFunction(compiled.fn, xr[0], xr[1], samples);
  if (curve.segments.length === 0) {
    issues.push({
      kind: "uncomputable-curve",
      detail: `${expr} 在 [${xr[0]}, ${xr[1]}] 上没有可画的点`,
      objectId: id,
    });
    return null;
  }
  return { segments: curve.segments, yMin: curve.yMin, yMax: curve.yMax, xMin: xr[0], xMax: xr[1] };
}

function solvePlotted(
  g: GroupState,
  samples: number,
  out: Shape[],
  extents: Partial<Extents>[],
  issues: SceneIssue[],
): void {
  const p = g.params ?? {};
  switch (g.primitive) {
    case "axes": {
      const xr = range(p.x_range);
      const yr = range(p.y_range);
      if (xr) extents.push({ xMin: xr[0], xMax: xr[1] });
      if (yr) extents.push({ yMin: yr[0], yMax: yr[1] });
      out.push({ kind: "axes", id: g.id });
      break;
    }
    case "number_line": {
      const xr = range(p.x_range) ?? range(p.range);
      if (xr) extents.push({ xMin: xr[0], xMax: xr[1], yMin: -0.5, yMax: 0.5 });
      out.push({ kind: "axes", id: g.id });
      break;
    }
    case "function_curve": {
      // 引擎的 Manim 通道可能已附采样点，有则直接用（省一次求值且与成片一致）
      const pre = Array.isArray(p.sampled_segments) ? (p.sampled_segments as unknown[]) : null;
      if (pre && pre.length > 0) {
        const segs = pre
          .map((s) => (Array.isArray(s) ? s.map(pair).filter((q): q is [number, number] => !!q) : []))
          .filter((s) => s.length >= 2);
        if (segs.length > 0) {
          const ys = segs.flat().map((q) => q[1]);
          const xs = segs.flat().map((q) => q[0]);
          extents.push({
            xMin: Math.min(...xs), xMax: Math.max(...xs),
            yMin: Math.min(...ys), yMax: Math.max(...ys),
          });
          out.push({ kind: "curve", id: g.id, label: g.label, segments: segs, role: "primary" });
          break;
        }
      }
      const s = sampleExpression(g.id, p, samples, issues);
      if (!s) break;
      extents.push({ xMin: s.xMin, xMax: s.xMax, yMin: s.yMin, yMax: s.yMax });
      out.push({ kind: "curve", id: g.id, label: g.label, segments: s.segments, role: "primary" });
      break;
    }
    case "composition_chain": {
      // 复合函数：内层、外层、合成三条曲线依次出现，讲清"曲线是怎么来的"
      const variable = typeof p.variable === "string" ? p.variable : "x";
      const xr = range(p.x_range) ?? [-5, 5];
      const inner = typeof p.inner === "string" ? p.inner : null;
      const outer = typeof p.outer === "string" ? p.outer : null;
      if (inner) {
        const s = sampleExpression(`${g.id}__inner`, { expression: inner, variable, x_range: xr }, samples, issues);
        if (s) {
          extents.push({ xMin: s.xMin, xMax: s.xMax, yMin: s.yMin, yMax: s.yMax });
          out.push({ kind: "curve", id: `${g.id}__inner`, label: `内层 u = ${inner}`, segments: s.segments, role: "support" });
        }
      }
      if (outer) {
        const ur = range(p.u_range) ?? xr;
        const s = sampleExpression(`${g.id}__outer`, { expression: outer, variable: "u", x_range: ur }, samples, issues, "expression", "variable", "x_range");
        if (s) {
          extents.push({ xMin: s.xMin, xMax: s.xMax, yMin: s.yMin, yMax: s.yMax });
          out.push({ kind: "curve", id: `${g.id}__outer`, label: `外层 y = ${outer}`, segments: s.segments, role: "support" });
        }
      }
      // 合成结果：用引擎给的 samples（已校验 outer(inner(x)) 一致）
      const chain = Array.isArray(p.samples) ? (p.samples as Record<string, unknown>[]) : [];
      const composed: Polyline = chain
        .map((s) => (typeof s.x === "number" && typeof s.y === "number" ? ([s.x, s.y] as [number, number]) : null))
        .filter((q): q is [number, number] => !!q);
      if (composed.length >= 2) {
        const ys = composed.map((q) => q[1]);
        extents.push({ xMin: xr[0], xMax: xr[1], yMin: Math.min(...ys), yMax: Math.max(...ys) });
        out.push({ kind: "curve", id: `${g.id}__composed`, label: g.label ?? "合成结果", segments: [composed], role: "primary" });
        // x→u→y 的映射箭头（取若干代表点）
        const step = Math.max(1, Math.floor(chain.length / 4));
        for (let i = 0; i < chain.length; i += step) {
          const s = chain[i];
          if (typeof s?.x === "number" && typeof s?.u === "number" && typeof s?.y === "number") {
            out.push({
              kind: "segment", id: `${g.id}__map${i}`, role: "arrow",
              from: [s.x, s.u], to: [s.x, s.y], label: i === 0 ? "x → u → y" : undefined,
            });
          }
        }
      }
      break;
    }
    case "tangent_line":
    case "secant_line": {
      const from = pair(p.start);
      const to = pair(p.end);
      const slope = typeof p.slope === "number" ? p.slope : undefined;
      if (from && to) {
        extents.push({ xMin: Math.min(from[0], to[0]), xMax: Math.max(from[0], to[0]), yMin: Math.min(from[1], to[1]), yMax: Math.max(from[1], to[1]) });
        out.push({
          kind: "segment", id: g.id, label: g.label, from, to, slope,
          role: g.primitive === "tangent_line" ? "tangent" : "secant",
        });
      }
      break;
    }
    case "riemann_rects": {
      const rects = Array.isArray(p.rects) ? (p.rects as unknown[]) : [];
      const parsed = rects
        .map((r) =>
          Array.isArray(r) && r.length >= 3 && r.every((v) => typeof v === "number")
            ? ([r[0], r[1], r[2]] as [number, number, number])
            : null,
        )
        .filter((r): r is [number, number, number] => !!r);
      if (parsed.length > 0) {
        const xs = parsed.flatMap((r) => [r[0], r[1]]);
        const hs = parsed.map((r) => r[2]);
        extents.push({ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(0, ...hs), yMax: Math.max(0, ...hs) });
        out.push({
          kind: "rects", id: g.id, label: g.label, rects: parsed,
          approxArea: typeof p.approx_area === "number" ? p.approx_area : undefined,
        });
      }
      break;
    }
    case "limit_approach": {
      const pts = (p.points ?? {}) as Record<string, unknown>;
      const collect = (side: "left" | "right") => {
        const arr = Array.isArray(pts[side]) ? (pts[side] as unknown[]) : [];
        return arr.map(pair).filter((q): q is [number, number] => !!q);
      };
      const all = [...collect("left"), ...collect("right")];
      all.forEach((q, i) => {
        out.push({ kind: "point", id: `${g.id}__p${i}`, at: q, role: "sample" });
      });
      if (all.length > 0) {
        const xs = all.map((q) => q[0]);
        const ys = all.map((q) => q[1]);
        extents.push({ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) });
      }
      const target = typeof p.target === "number" ? p.target : null;
      const lv = typeof p.limit_value === "number" ? p.limit_value : null;
      // 发散时绝不画"极限高度线"——那会暗示一个不存在的极限
      if (target !== null && lv !== null && p.divergent !== true) {
        out.push({ kind: "point", id: `${g.id}__limit`, at: [target, lv], open: true, role: "limit", label: g.label });
      }
      break;
    }
    case "dot": {
      const positions = Array.isArray(p.positions) ? (p.positions as unknown[]) : null;
      const pts = positions
        ? positions.map(pair).filter((q): q is [number, number] => !!q)
        : pair([p.x, p.y])
          ? [pair([p.x, p.y])!]
          : [];
      pts.forEach((q, i) => {
        extents.push({ xMin: q[0], xMax: q[0], yMin: q[1], yMax: q[1] });
        out.push({
          kind: "point", id: `${g.id}__${i}`, at: q, open: p.open === true,
          label: i === 0 ? g.label : undefined, role: "root",
        });
      });
      break;
    }
    case "line":
    case "arrow": {
      const from = pair(p.start);
      const to = pair(p.end);
      if (from && to) {
        extents.push({ xMin: Math.min(from[0], to[0]), xMax: Math.max(from[0], to[0]), yMin: Math.min(from[1], to[1]), yMax: Math.max(from[1], to[1]) });
        out.push({
          kind: "segment", id: g.id, label: g.label, from, to,
          role: g.primitive === "arrow" ? "arrow" : "guide",
        });
      }
      break;
    }
    case "polygon": {
      const verts = Array.isArray(p.vertices) ? (p.vertices as unknown[]) : [];
      const pts = verts.map(pair).filter((q): q is [number, number] => !!q);
      if (pts.length >= 2) {
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        extents.push({ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) });
        const closed: Polyline = [...pts, pts[0]!];
        out.push({ kind: "curve", id: g.id, label: g.label, segments: [closed], role: "support" });
      }
      break;
    }
  }
}
