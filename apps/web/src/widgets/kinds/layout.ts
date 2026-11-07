/**
 * 十个组件的几何：状态 → 坐标。
 *
 * 为什么把这些换算单独抽出来、和 React 分开：
 * 1. 画面必须**由状态算出来**（这就是"看得见的表示"），算的过程要能被机器检查。
 *    放进组件里就只能靠人点着看，抽成纯函数之后 vitest 里能直接断言"跳到第 3 格时落点在哪"。
 * 2. 状态本身不在这里算——`initialWidgetState` / `applyWidgetAction` 是唯一真源
 *    （见 @mathtutor/widgets 的 reduce.ts）。这里只做「已经合法的状态 → 像素」的翻译，
 *    不夹边界、不改数值，否则同一件事就有两套规则，迟早对不上。
 */
import type { WidgetState, WidgetValue } from '@mathtutor/widgets'

export interface Pt {
  x: number
  y: number
}

/** 从状态里读一个数：读不到就给默认值，绝不把 NaN 送进 SVG（NaN 属性会让整张图静默消失） */
export function num(state: WidgetState, key: string, fallback = 0): number {
  const raw: WidgetValue | undefined = state[key]
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** 从 params 里读一个数：params 是 Record<string, unknown>，同样兜住 NaN */
export function paramNum(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(params[key])
  return Number.isFinite(value) ? value : fallback
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/* ── 数轴跳跃 ──────────────────────────────────────────────
   轴域取 params 的 [min,max] 与起点/落点的并集：跳出去的那一步也要看得见，
   否则「20 + 10」会被画成一个贴着右边缘、没有落点的箭头。 */

export interface NumberLineTick {
  value: number
  x: number
  /** 刻度太密时只标 5 的倍数，其余留空，免得数字糊成一片 */
  label: string | null
}

export interface NumberLineGeometry {
  axisMin: number
  axisMax: number
  startX: number
  endX: number
  end: number
  ticks: NumberLineTick[]
  width: number
}

export function numberLineGeometry(opts: {
  start: number
  jump: number
  right: boolean
  min: number
  max: number
  tick?: number
  width?: number
  pad?: number
}): NumberLineGeometry {
  const width = opts.width ?? 460
  const pad = opts.pad ?? 34
  const end = opts.right ? opts.start + opts.jump : opts.start - opts.jump
  const axisMin = Math.min(opts.min, opts.start, end)
  const axisMax = Math.max(opts.max, opts.start, end)
  const span = Math.max(1, axisMax - axisMin)
  const inner = width - pad * 2
  const xOf = (v: number) => pad + ((v - axisMin) / span) * inner

  // 刻度间隔：先按 tick 走，太密就逐级放大，最多约 80 个
  let step = Number.isFinite(opts.tick) && (opts.tick ?? 0) > 0 ? (opts.tick as number) : 1
  while (span / step > 80) step *= 5
  const labelEvery = span <= 12 ? step : Math.max(step, 5)

  const ticks: NumberLineTick[] = []
  for (let v = axisMin; v <= axisMax + 1e-9; v += step) {
    const rounded = Math.round(v * 1000) / 1000
    ticks.push({
      value: rounded,
      x: xOf(rounded),
      label: Math.abs(rounded % labelEvery) < 1e-9 ? String(rounded) : null,
    })
  }

  return { axisMin, axisMax, startX: xOf(opts.start), endX: xOf(end), end, ticks, width }
}

/* ── 分数条 ────────────────────────────────────────────── */

export interface FractionSegment {
  index: number
  x: number
  width: number
  filled: boolean
}

export function fractionSegments(
  denominator: number,
  numerator: number,
  opts: { width?: number; pad?: number; gap?: number } = {},
): FractionSegment[] {
  const width = opts.width ?? 460
  const pad = opts.pad ?? 30
  const gap = opts.gap ?? 3
  const d = Math.max(1, Math.round(denominator))
  const n = clamp(Math.round(numerator), 0, d)
  const inner = width - pad * 2
  const segWidth = (inner - gap * (d - 1)) / d
  return Array.from({ length: d }, (_, i) => ({
    index: i,
    x: pad + i * (segWidth + gap),
    width: segWidth,
    filled: i < n,
  }))
}

/* ── 天平 ────────────────────────────────────────────────
   tilt > 0 表示**左边下沉**（重的一边往下）。天平的"歪"就是这条关系本身：
   角度与两边的差成正比，差 0 就是平的。 */

export function balanceTilt(left: number, right: number, max = 20, maxDeg = 16): number {
  const safeMax = Math.max(1, max)
  return clamp(((left - right) / safeMax) * maxDeg, -maxDeg, maxDeg)
}

/** 横梁两端的位置：绕支点转 tilt 度。左端 y 变大 = 屏幕上下沉 */
export function beamEnds(tiltDeg: number, halfLen: number, pivot: Pt): { left: Pt; right: Pt } {
  const rad = (tiltDeg * Math.PI) / 180
  const dy = Math.sin(rad) * halfLen
  const dx = Math.cos(rad) * halfLen
  return {
    left: { x: pivot.x - dx, y: pivot.y + dy },
    right: { x: pivot.x + dx, y: pivot.y - dy },
  }
}

/* ── 钟面 ────────────────────────────────────────────────
   时针每分走 0.5°、分针每分走 6°：分针转一圈（360°）时针正好走 30°（一大格）。
   这条关系就藏在两个角度里，所以画面必须照它画，而不是"取整点的时针"。 */

export function clockHandAngles(hour: number, minute: number): { hourAngle: number; minuteAngle: number } {
  const h = ((Math.round(hour) % 24) + 24) % 24
  const m = clamp(Math.round(minute), 0, 59)
  const hourAngle = ((h % 12) + m / 60) * 30
  const minuteAngle = (m % 60) * 6
  return { hourAngle, minuteAngle }
}

/* ── 面积格 ────────────────────────────────────────────── */

export interface GridCell {
  row: number
  col: number
  x: number
  y: number
}

export interface GridGeometry {
  cols: number
  rows: number
  cells: GridCell[]
  width: number
  height: number
  count: number
  cell: number
  pad: number
}

export function gridLayout(width: number, height: number, cell = 34, pad = 18): GridGeometry {
  const cols = clamp(Math.round(width), 0, 40)
  const rows = clamp(Math.round(height), 0, 40)
  const cells: GridCell[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({ row, col, x: pad + col * cell, y: pad + row * cell })
    }
  }
  return {
    cols,
    rows,
    cells,
    width: pad * 2 + cols * cell,
    height: pad * 2 + rows * cell,
    count: cols * rows,
    cell,
    pad,
  }
}

/* ── 十进制的捆与散 ────────────────────────────────────────
   满十能捆成一条——这正是要让孩子看见的那件事，所以把"能捆几条"单独算出来，
   而不是让它埋在画格子的循环里。 */

export interface Base10Layout {
  rods: number
  ones: number
  /** 散块里能捆成几条十 */
  bundles: number
  /** 捆完还剩几个散块 */
  leftover: number
  total: number
}

export function base10Layout(tens: number, ones: number): Base10Layout {
  const t = Math.max(0, Math.round(tens))
  const o = Math.max(0, Math.round(ones))
  return {
    rods: t,
    ones: o,
    bundles: Math.floor(o / 10),
    leftover: o % 10,
    total: t * 10 + o,
  }
}

/* ── 规律火车 ────────────────────────────────────────────
   两节一组（红蓝）或一节一组（同色）。返回的是"色位"而不是颜色值：
   具体颜色留给渲染层，逻辑层不需要知道设计系统里哪个色号。 */

export type CarTone = 'warm' | 'cool'

export function patternCars(alternate: boolean, length = 8): CarTone[] {
  const n = clamp(Math.round(length), 0, 24)
  return Array.from({ length: n }, (_, i) => (alternate && i % 2 === 1 ? 'cool' : 'warm'))
}

/** 一组有几节：交替是 2 节一组，同色是 1 节一组 */
export function patternUnit(alternate: boolean): number {
  return alternate ? 2 : 1
}

/* ── 分堆 ──────────────────────────────────────────────── */

export interface BinSlot {
  index: number
  label: string
  active: boolean
  count: number
}

/** 状态里只记"当前筐 + 放几个"，所以只有被选中的筐有东西——
   这是实话：孩子手里只有一堆积木，放进去的那一筐才有数 */
export function binsLayout(labels: string[], activeLabel: string, count: number): BinSlot[] {
  const n = Math.max(0, Math.round(count))
  return labels.map((label, index) => ({
    index,
    label,
    active: label === activeLabel,
    count: label === activeLabel ? n : 0,
  }))
}

/** "筐 A" → 0。认不出来就退回 0，不抛错（状态来自服务端，宁可画第一个筐） */
export function binIndexOf(labels: string[], label: string): number {
  const i = labels.indexOf(label)
  return i >= 0 ? i : 0
}

/* ── 坐标点 ──────────────────────────────────────────────
   屏幕 y 朝下、数轴 y 朝上：这个翻转只在画的时候发生一次，
   所以 (3,2) 永远在 (2,3) 的右下，不会被画反。 */

export interface PointGeometry {
  px: number
  py: number
  width: number
  height: number
  unit: number
  pad: number
}

export function plotPoint(
  x: number,
  y: number,
  opts: { maxX?: number; maxY?: number; unit?: number; pad?: number } = {},
): PointGeometry {
  const maxX = Math.max(1, Math.round(opts.maxX ?? 12))
  const maxY = Math.max(1, Math.round(opts.maxY ?? 12))
  const unit = opts.unit ?? 26
  const pad = opts.pad ?? 34
  const cx = clamp(Math.round(x), 0, maxX)
  const cy = clamp(Math.round(y), 0, maxY)
  return {
    px: pad + cx * unit,
    py: pad + (maxY - cy) * unit,
    width: pad * 2 + maxX * unit,
    height: pad * 2 + maxY * unit,
    unit,
    pad,
  }
}

/* ── 找零 ────────────────────────────────────────────────
   两根条共用一个标尺，"差出来的那一段"就是找零；付少了就画成红色的缺口。
   共用一个 max 才有可比性——两根条各按各的比例画，长度差就成了假的。 */

export interface ChangeLayout {
  price: number
  paid: number
  /** 应找：付得多才为正 */
  change: number
  /** 还差多少：付少了才为正 */
  short: number
  scaleMax: number
  priceRatio: number
  paidRatio: number
  changeRatio: number
  enough: boolean
}

export function changeLayout(price: number, paid: number, max = 50): ChangeLayout {
  const p = Math.max(0, Math.round(price))
  const q = Math.max(0, Math.round(paid))
  const scaleMax = Math.max(1, max, p, q)
  const enough = q >= p
  return {
    price: p,
    paid: q,
    change: enough ? q - p : 0,
    short: enough ? 0 : p - q,
    scaleMax,
    priceRatio: p / scaleMax,
    paidRatio: q / scaleMax,
    changeRatio: Math.abs(q - p) / scaleMax,
    enough,
  }
}
