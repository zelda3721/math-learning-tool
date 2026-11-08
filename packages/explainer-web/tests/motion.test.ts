import { describe, expect, it } from "vitest";
import { easeOutCubic, tweenBarGeometry, tweenPoint, tweenPositions } from "../src/motion.js";

/**
 * 补间是纯函数这件事，是"任意 t 都能画对"的全部依据。
 * 这里盯四件事：端点精确、单调、纯粹（同输入同输出）、以及缺单位时宁可不动。
 */

describe("缓动", () => {
  it("两端精确，中点不越过两端", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    const mid = easeOutCubic(0.5);
    expect(mid).toBeGreaterThan(0.5); // 先快后慢
    expect(mid).toBeLessThan(1);
  });

  it("越界与 NaN 钳制到 [0,1]（时间轴那边也会钳，但这里不能依赖调用方守规矩）", () => {
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(9)).toBe(1);
    expect(easeOutCubic(Number.NaN)).toBe(0);
  });
});

describe("位置插值", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 40 };

  it("进度 0 / 1 返回端点原值（不因浮点误差差半像素）", () => {
    expect(tweenPoint(a, b, 0)).toEqual({ x: 0, y: 0 });
    expect(tweenPoint(a, b, 1)).toEqual({ x: 100, y: 40 });
  });

  it("同向推进：进度越大越接近终点", () => {
    const d = (p: number) => Math.hypot(...(Object.values(tweenPoint(a, b, p)) as [number, number]));
    expect(d(0.2)).toBeLessThan(d(0.5));
    expect(d(0.5)).toBeLessThan(d(0.9));
  });

  it("纯粹：同一进度反复求值恒等", () => {
    expect(tweenPoint(a, b, 0.37)).toEqual(tweenPoint(a, b, 0.37));
  });

  it("整组：目标里没有的单位原地不动（宁可不动，也不要凭空消失）", () => {
    const from = new Map([
      ["u1", { x: 0, y: 0 }],
      ["u2", { x: 50, y: 50 }],
    ]);
    const to = new Map([["u1", { x: 100, y: 100 }]]);
    const out = tweenPositions(from, to, 1);
    expect(out.get("u1")).toEqual({ x: 100, y: 100 });
    expect(out.get("u2")).toEqual({ x: 50, y: 50 });
  });

  it("整组：起点里没有的单位不产生位置（新单位下一拍才登场）", () => {
    const out = tweenPositions(new Map(), new Map([["new", { x: 1, y: 1 }]]), 0.5);
    expect(out.size).toBe(0);
  });
});

describe("条的几何插值", () => {
  const a = { x: 10, y: 20, w: 200, h: 30, fillW: 200 };
  const b = { x: 10, y: 60, w: 200, h: 30, fillW: 80 };

  it("端点精确：进度 0/1 就是两端原值", () => {
    expect(tweenBarGeometry(a, b, 0)).toEqual(a);
    expect(tweenBarGeometry(a, b, 1)).toEqual(b);
  });

  it("中途：填充长度落在两端之间，槽位也跟着走", () => {
    const mid = tweenBarGeometry(a, b, 0.5);
    expect(mid.fillW).toBeGreaterThan(80);
    expect(mid.fillW).toBeLessThan(200);
    expect(mid.y).toBeGreaterThan(20);
    expect(mid.y).toBeLessThan(60);
  });

  it("填充永不超过槽位（两边尺寸不同时也不能画到框外）", () => {
    const wide = { x: 0, y: 0, w: 100, h: 10, fillW: 100 };
    const short = { x: 0, y: 0, w: 40, h: 10, fillW: 40 };
    for (const p of [0.1, 0.5, 0.9]) {
      const g = tweenBarGeometry(wide, short, p);
      expect(g.fillW).toBeLessThanOrEqual(g.w + 1e-9);
    }
  });

  it("纯粹：同一进度反复求值恒等", () => {
    expect(tweenBarGeometry(a, b, 0.31)).toEqual(tweenBarGeometry(a, b, 0.31));
  });
});
