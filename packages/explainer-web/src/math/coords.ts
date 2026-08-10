/**
 * 全场景共享的数据坐标系。
 *
 * 存在的理由：曲线、坐标轴、根、辅助线、点，全都带真实数据坐标，
 * 必须映射到**同一个** viewport 才可能对得齐。任何"各自在自己的局部盒子里
 * 归一化"的做法都会让 x=2 的根和曲线过 x 轴的位置错开 —— 那是在骗人。
 *
 * 约定：
 * - viewport 是数据坐标窗口；toScreen 把数据坐标映射到像素（y 轴翻转，屏幕向下为正）；
 * - padding 是像素内边距（默认 24），保证端点不贴边；
 * - nice ticks 步长恒为 1/2/5 × 10^n；刻度都是步长的整数倍，
 *   因此只要窗口含 0，0 一定是一根刻度 —— 数学图必须能看见原点。
 */

export interface CoordSystem {
  /** 数据坐标 → 像素坐标（左上为原点）。传入非有限数时原样输出非有限数，调用方需自行跳过 */
  toScreen(x: number, y: number): [number, number];
  xTicks: number[];
  yTicks: number[];
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** 窗口是否同时包含 x=0 与 y=0（即原点可见） */
  hasOrigin: boolean;
}

export interface Extents {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface CoordOptions {
  /** 像素内边距，默认 24；会被夹到不超过对应边长的 40% */
  padding?: number;
  /** 是否把窗口对齐到 1/2/5×10^n 的刻度（默认 true） */
  niceTicks?: boolean;
}

const DEFAULT_PADDING = 24;
const MAX_TICKS = 500;

/** 抹掉浮点尾巴：0.1*3 → 0.3 而不是 0.30000000000000004 */
function clean(v: number): number {
  if (!Number.isFinite(v)) return v;
  if (v === 0) return 0;
  return Number(v.toPrecision(12));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把可能退化的 [min, max] 撑成一个有正宽度的窗口。
 * 退化时以中心为准展开 max(|center|*0.1, 1)，这样 0 附近会得到 [-1, 1]（含原点）。
 */
function sanitizeAxis(min: number, max: number): [number, number] {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  const span = hi - lo;
  const scale = Math.max(Math.abs(lo), Math.abs(hi));
  // span 相对量级过小也算退化（例如 [1e9, 1e9 + 1e-9]）
  if (!(span > 0) || span < scale * 1e-12) {
    const center = (lo + hi) / 2;
    const half = Math.max(Math.abs(center) * 0.1, 1);
    return [center - half, center + half];
  }
  return [lo, hi];
}

/** 1/2/5 × 10^n 步长 */
function niceStep(span: number, target: number): number {
  if (!(span > 0) || !(target > 0)) return 1;
  const raw = span / target;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const f = raw / base;
  const m = f <= 1.5 ? 1 : f <= 3 ? 2 : f <= 7 ? 5 : 10;
  return clean(m * base);
}

function ticksFor(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0)) return out;
  const start = Math.ceil(min / step - 1e-9);
  const end = Math.floor(max / step + 1e-9);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  if (end - start > MAX_TICKS) return out;
  for (let i = start; i <= end; i += 1) out.push(clean(i * step));
  return out;
}

/**
 * 建立全场景共享坐标系。
 *
 * @param extents 数据范围（可以退化：xMin==xMax、常函数导致 yMin==yMax，都不会除零）
 * @param size    画布像素尺寸
 */
export function buildCoordSystem(
  extents: Extents,
  size: { w: number; h: number },
  opts?: CoordOptions,
): CoordSystem {
  const w = Number.isFinite(size?.w) && size.w > 0 ? size.w : 1;
  const h = Number.isFinite(size?.h) && size.h > 0 ? size.h : 1;

  const rawPadding = opts?.padding;
  const padWanted =
    typeof rawPadding === "number" && Number.isFinite(rawPadding) && rawPadding >= 0
      ? rawPadding
      : DEFAULT_PADDING;
  const padX = Math.min(padWanted, w * 0.4);
  const padY = Math.min(padWanted, h * 0.4);

  let [xMin, xMax] = sanitizeAxis(extents?.xMin as number, extents?.xMax as number);
  let [yMin, yMax] = sanitizeAxis(extents?.yMin as number, extents?.yMax as number);

  const innerW = Math.max(w - 2 * padX, 1);
  const innerH = Math.max(h - 2 * padY, 1);

  const targetX = clamp(Math.round(innerW / 80), 2, 12);
  const targetY = clamp(Math.round(innerH / 60), 2, 10);

  const useNice = opts?.niceTicks !== false;
  let stepX = niceStep(xMax - xMin, targetX);
  let stepY = niceStep(yMax - yMin, targetY);

  if (useNice) {
    // 只向外扩，永远不会把原本在窗口里的 0 挤出去
    xMin = clean(Math.floor(xMin / stepX + 1e-9) * stepX);
    xMax = clean(Math.ceil(xMax / stepX - 1e-9) * stepX);
    yMin = clean(Math.floor(yMin / stepY + 1e-9) * stepY);
    yMax = clean(Math.ceil(yMax / stepY - 1e-9) * stepY);
    if (!(xMax > xMin)) {
      xMin -= stepX;
      xMax += stepX;
    }
    if (!(yMax > yMin)) {
      yMin -= stepY;
      yMax += stepY;
    }
    stepX = niceStep(xMax - xMin, targetX);
    stepY = niceStep(yMax - yMin, targetY);
  }

  const spanX = xMax - xMin;
  const spanY = yMax - yMin;
  const sx = spanX > 0 ? innerW / spanX : 0;
  const sy = spanY > 0 ? innerH / spanY : 0;

  const toScreen = (x: number, y: number): [number, number] => [
    padX + (x - xMin) * sx,
    padY + (yMax - y) * sy,
  ];

  return {
    toScreen,
    xTicks: ticksFor(xMin, xMax, stepX),
    yTicks: ticksFor(yMin, yMax, stepY),
    viewport: { xMin, xMax, yMin, yMax },
    hasOrigin: xMin <= 0 && xMax >= 0 && yMin <= 0 && yMax >= 0,
  };
}

/** 合并多组数据范围（全场景共享坐标系的常用前置步骤） */
export function unionExtents(parts: readonly Partial<Extents>[]): Extents | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const part of parts) {
    if (!part) continue;
    const { xMin: a, xMax: b, yMin: c, yMax: d } = part;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      xMin = Math.min(xMin, a as number);
      xMax = Math.max(xMax, b as number);
      seen = true;
    }
    if (Number.isFinite(c) && Number.isFinite(d)) {
      yMin = Math.min(yMin, c as number);
      yMax = Math.max(yMax, d as number);
      seen = true;
    }
  }
  if (!seen) return null;
  return {
    xMin: Number.isFinite(xMin) ? xMin : 0,
    xMax: Number.isFinite(xMax) ? xMax : 0,
    yMin: Number.isFinite(yMin) ? yMin : 0,
    yMax: Number.isFinite(yMax) ? yMax : 0,
  };
}
