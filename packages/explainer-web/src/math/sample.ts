/**
 * 函数采样：把 EvalFn 变成可以直接画的折线段集合。
 *
 * 两条硬要求：
 * 1. 不连续处必须断开 —— 1/x 不能在 x=0 处被连成一条竖线，tan 不能在每个 π/2 处被连起来；
 * 2. y 值域要稳健 —— 一个极点不能把整条曲线压成一条贴着中轴的直线。
 *
 * 断段规则：
 * - 采样点无定义（null / NaN / Infinity）→ 断；并用二分把定义域边界补到最近处
 *   （这样 sqrt(x) 的起点落在 x=0 而不是第一个网格点上）；
 * - 相邻样本 y 跳变超过窗口高度的数倍，且两端分别落在窗口上下两侧
 *   （即"从 +∞ 跳到 -∞"）→ 判为极点，断段。
 *   同侧的剧烈上升（例如趋向同一条渐近线）不断段：那是真实的陡峭，不是跳变。
 */

import type { EvalFn } from "./expr.js";

/** 一条曲线：若干条连续折线段 + 稳健 y 值域 */
export interface Curve {
  /** 每段是一串 [x, y] 数据坐标；段与段之间是不连续的，不可相连 */
  segments: [number, number][][];
  yMin: number;
  yMax: number;
}

/** 默认采样数：按典型画布像素宽度取，保证每像素附近至少一个样本 */
const DEFAULT_SAMPLES = 600;
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 20000;
/** 箱线图围栏系数：q1 - K*IQR ~ q3 + K*IQR 之外算极端值 */
const FENCE_K = 3;
/** 跳变阈值：相邻 y 差超过窗口高度的这个倍数才可能判为极点 */
const JUMP_FACTOR = 2;
/** 定义域边界二分次数 */
const BOUNDARY_ITERS = 24;

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (idx - lo);
}

/**
 * 稳健 y 值域：先用 IQR 围栏剔除极端值，再取剩余值的真实 min/max。
 *
 * 关键性质：没有极点时围栏不会裁掉任何东西，min/max 就是真实极值
 * （x²-4 的 y 下界必须是 -4，不能被分位数削成 -3.99）。
 */
function robustRange(values: number[]): { yMin: number; yMax: number } {
  if (values.length === 0) return { yMin: 0, yMax: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (!(iqr > 0)) {
    // 常函数或极窄分布：围栏无意义，直接用真实极值
    return { yMin: sorted[0] as number, yMax: sorted[sorted.length - 1] as number };
  }
  const lo = q1 - FENCE_K * iqr;
  const hi = q3 + FENCE_K * iqr;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const v of sorted) {
    if (v < lo || v > hi) continue;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { yMin: sorted[0] as number, yMax: sorted[sorted.length - 1] as number };
  }
  return { yMin, yMax };
}

/**
 * 在 [xNull, xValid] 之间二分，找出最靠近定义域边界的那个有定义的点。
 * 返回 null 表示没找到（或找到的点已经飞出可视窗口，属于极点而非边界）。
 */
function refineBoundary(
  fn: EvalFn,
  xNull: number,
  xValid: number,
  guardLo: number,
  guardHi: number,
): [number, number] | null {
  let lo = xNull;
  let hi = xValid;
  let best: [number, number] | null = null;
  for (let i = 0; i < BOUNDARY_ITERS; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    const y = fn(mid);
    if (y === null || !Number.isFinite(y)) {
      lo = mid;
    } else {
      hi = mid;
      best = [mid, y];
    }
  }
  if (!best) return null;
  const y = best[1];
  // 极点旁的"边界点"会是天文数字，补上去只会把画面拉垮 —— 丢掉它。
  if (y < guardLo || y > guardHi) return null;
  return best;
}

/**
 * 在 [xMin, xMax] 上采样 fn，返回可直接绘制的折线段与稳健 y 值域。
 *
 * @param samples 采样点数（含两端），默认 600；会被夹到 [2, 20000]
 */
export function sampleFunction(
  fn: EvalFn,
  xMin: number,
  xMax: number,
  samples: number = DEFAULT_SAMPLES,
): Curve {
  const empty: Curve = { segments: [], yMin: 0, yMax: 0 };
  if (typeof fn !== "function") return empty;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return empty;

  let lo = xMin;
  let hi = xMax;
  if (lo > hi) [lo, hi] = [hi, lo];

  const span = hi - lo;
  if (span === 0) {
    // 退化区间：只有一个点是有意义的，诚实地给一个单点段
    const y = fn(lo);
    if (y === null || !Number.isFinite(y)) return empty;
    return { segments: [[[lo, y]]], yMin: y, yMax: y };
  }

  const n = Math.min(
    MAX_SAMPLES,
    Math.max(MIN_SAMPLES, Math.floor(Number.isFinite(samples) ? samples : DEFAULT_SAMPLES)),
  );

  // 第一遍：网格求值
  const xs = new Array<number>(n);
  const ys = new Array<number | null>(n);
  const finiteValues: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const x = lo + span * (i / (n - 1));
    xs[i] = x;
    const y = fn(x);
    const v = y === null || !Number.isFinite(y) ? null : y;
    ys[i] = v;
    if (v !== null) finiteValues.push(v);
  }

  if (finiteValues.length === 0) return empty;

  // 第二遍：稳健值域 → 得到"窗口"，跳变阈值与边界护栏都以它为准
  const { yMin, yMax } = robustRange(finiteValues);
  const height = yMax - yMin;
  const jumpThreshold = height > 0 ? JUMP_FACTOR * height : Number.POSITIVE_INFINITY;
  const guard = height > 0 ? height : Math.max(Math.abs(yMin), 1);
  const guardLo = yMin - guard;
  const guardHi = yMax + guard;

  // 第三遍：切段
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  // 二分补出来的定义域边界点已过护栏，可以安全地参与值域
  // （sqrt(x) 的起点 y=0 必须进得了窗口，否则曲线起点会被裁在框外）
  let edgeMin = Number.POSITIVE_INFINITY;
  let edgeMax = Number.NEGATIVE_INFINITY;
  const takeEdge = (edge: [number, number] | null): [number, number] | null => {
    if (edge) {
      if (edge[1] < edgeMin) edgeMin = edge[1];
      if (edge[1] > edgeMax) edgeMax = edge[1];
    }
    return edge;
  };
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let i = 0; i < n; i += 1) {
    const y = ys[i] as number | null;
    const x = xs[i] as number;

    if (y === null) {
      // 有定义 → 无定义：把边界补上再断
      if (current.length > 0) {
        const prevX = xs[i - 1] as number;
        const edge = takeEdge(refineBoundary(fn, x, prevX, guardLo, guardHi));
        if (edge) current.push(edge);
      }
      flush();
      continue;
    }

    if (current.length === 0) {
      // 无定义 → 有定义：先补边界点，让曲线从真正的定义域起点开始
      if (i > 0 && ys[i - 1] === null) {
        const edge = takeEdge(refineBoundary(fn, xs[i - 1] as number, x, guardLo, guardHi));
        if (edge) current.push(edge);
      }
      current.push([x, y]);
      continue;
    }

    const prev = current[current.length - 1] as [number, number];
    const prevY = prev[1];
    const dy = y - prevY;
    const straddles =
      (prevY < yMin && y > yMax) || (prevY > yMax && y < yMin);
    if (Math.abs(dy) > jumpThreshold && straddles) {
      // 从窗口下方直接跳到上方（或反之）= 竖直渐近线，绝不连线
      flush();
      current.push([x, y]);
      continue;
    }
    current.push([x, y]);
  }
  flush();

  return {
    segments,
    yMin: Math.min(yMin, edgeMin),
    yMax: Math.max(yMax, edgeMax),
  };
}
