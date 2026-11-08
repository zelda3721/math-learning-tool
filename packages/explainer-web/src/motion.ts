/**
 * 补间：把「上一拍在哪」与「这一拍在哪」按进度合成一个位置。
 *
 * 这一层刻意是纯函数，理由和 timeline 一样：位置若由（起点、终点、进度）唯一决定，
 * 那么任意时刻的画面就是算出来的；只要掺进一点"上一帧残留"，seek 就再也对不准，
 * 而 seek 对不准的播放器，断点续看、字幕对时、截图比对全都不成立。
 *
 * 缓动只做一种：easeOutCubic。它不是审美选择——错开物体的运动曲线会让
 * 「总量没变，只是换了位置」这条信息变模糊，而那是数量画面唯一要说的事。
 */

export interface Point {
  x: number;
  y: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function easeOutCubic(p: number): number {
  const t = clamp01(p);
  return 1 - Math.pow(1 - t, 3);
}

export function tweenPoint(from: Point, to: Point, progress: number, ease = easeOutCubic): Point {
  // 端点直接返回原值：浮点误差不该让"进度 1"与终点差半个像素
  const p = clamp01(progress);
  if (p === 0) return { x: from.x, y: from.y };
  if (p === 1) return { x: to.x, y: to.y };
  const e = ease(p);
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
}

/**
 * 整组单位的位置插值。
 *
 * 两条规则，都是"宁可不动，也不要凭空消失"：
 * - 目标里没有这个单位：原地不动（它这一趟不参与移动，会不会消失由下一拍的显隐决定）
 * - 起点里没有这个单位：不产生位置（新单位在下一拍才登场，不该提前出现）
 */
export function tweenPositions(
  from: Map<string, Point>,
  to: Map<string, Point>,
  progress: number,
  ease = easeOutCubic,
): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const [id, start] of from) {
    const end = to.get(id);
    out.set(id, end ? tweenPoint(start, end, progress, ease) : { x: start.x, y: start.y });
  }
  return out;
}

/** 一根"条"的几何：槽位 + 填充长度。刻度是相对槽位左侧的偏移，等比跟着填充走 */
export interface BarGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  fillW: number;
}

/**
 * 条的插值。
 *
 * 插的是**像素**，不是数值：所有条共享一把尺，而尺本身也会随全场最大值变。
 * 若去插 value 再按新尺换算，中途会出现"数值没动、条却跳了一下"的怪相；
 * 插几何则永远平滑，读数是哪一拍的就写哪一拍的（文字不补间，跟单位标签一个道理）。
 */
export function tweenBarGeometry(
  from: BarGeometry,
  to: BarGeometry,
  progress: number,
  ease = easeOutCubic,
): BarGeometry {
  const p = clamp01(progress);
  if (p === 0) return { ...from };
  if (p === 1) return { ...to };
  const e = ease(p);
  const mix = (a: number, b: number) => a + (b - a) * e;
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    w: mix(from.w, to.w),
    h: mix(from.h, to.h),
    // 填充不能超过槽位：中途两边尺寸不同时，宁可短一截，也不要画到框外
    fillW: Math.min(mix(from.fillW, to.fillW), mix(from.w, to.w)),
  };
}
