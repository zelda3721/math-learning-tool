import { describe, expect, it } from "vitest";
import { buildCoordSystem, unionExtents } from "../src/math/coords.js";

/** 步长必须是 1/2/5 × 10^n */
const mantissaOf = (step: number): number => {
  const exp = Math.floor(Math.log10(step));
  return Number((step / Math.pow(10, exp)).toPrecision(6));
};

const stepsOf = (ticks: number[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    out.push(Number(((ticks[i] as number) - (ticks[i - 1] as number)).toPrecision(10)));
  }
  return out;
};

describe("buildCoordSystem — 共享坐标系", () => {
  it("同一坐标系下不同对象的同一数据坐标映射到同一像素", () => {
    const cs = buildCoordSystem({ xMin: -3, xMax: 3, yMin: -4, yMax: 5 }, { w: 640, h: 360 });
    const a = cs.toScreen(2, 0);
    const b = cs.toScreen(2, 0);
    expect(a).toEqual(b);
    // x 单调递增、y 屏幕坐标随数据 y 增大而减小
    expect(cs.toScreen(3, 0)[0]).toBeGreaterThan(cs.toScreen(-3, 0)[0]);
    expect(cs.toScreen(0, 5)[1]).toBeLessThan(cs.toScreen(0, -4)[1]);
  });

  it("padding 内边距生效且端点落在画布内", () => {
    const cs = buildCoordSystem(
      { xMin: 0, xMax: 10, yMin: 0, yMax: 10 },
      { w: 200, h: 200 },
      { padding: 20 },
    );
    const [sx, sy] = cs.toScreen(cs.viewport.xMin, cs.viewport.yMax);
    expect(sx).toBeCloseTo(20, 9);
    expect(sy).toBeCloseTo(20, 9);
    const [ex, ey] = cs.toScreen(cs.viewport.xMax, cs.viewport.yMin);
    expect(ex).toBeCloseTo(180, 9);
    expect(ey).toBeCloseTo(180, 9);
  });
});

describe("buildCoordSystem — 原点", () => {
  it("含 0 的范围必须保留原点，且 0 是一根刻度", () => {
    const cs = buildCoordSystem({ xMin: -3, xMax: 3, yMin: -4, yMax: 5 }, { w: 640, h: 360 });
    expect(cs.hasOrigin).toBe(true);
    expect(cs.viewport.xMin).toBeLessThanOrEqual(0);
    expect(cs.viewport.xMax).toBeGreaterThanOrEqual(0);
    expect(cs.viewport.yMin).toBeLessThanOrEqual(0);
    expect(cs.viewport.yMax).toBeGreaterThanOrEqual(0);
    expect(cs.xTicks).toContain(0);
    expect(cs.yTicks).toContain(0);
  });

  it("nice 对齐只向外扩，不会把 0 挤出窗口", () => {
    const cs = buildCoordSystem(
      { xMin: -0.3, xMax: 7.2, yMin: -1.1, yMax: 0.4 },
      { w: 500, h: 300 },
    );
    expect(cs.viewport.xMin).toBeLessThanOrEqual(-0.3);
    expect(cs.viewport.xMax).toBeGreaterThanOrEqual(7.2);
    expect(cs.hasOrigin).toBe(true);
    expect(cs.xTicks).toContain(0);
  });

  it("不含 0 的范围如实报告 hasOrigin=false", () => {
    const cs = buildCoordSystem({ xMin: 10, xMax: 20, yMin: 100, yMax: 200 }, { w: 400, h: 300 });
    expect(cs.hasOrigin).toBe(false);
  });
});

describe("buildCoordSystem — nice ticks", () => {
  const cases: { extents: [number, number]; w: number }[] = [
    { extents: [-3, 3], w: 640 },
    { extents: [0, 1], w: 400 },
    { extents: [-0.05, 0.05], w: 500 },
    { extents: [0, 1234], w: 800 },
    { extents: [-7, 13], w: 300 },
    { extents: [1e6, 3e6], w: 600 },
  ];

  for (const { extents, w } of cases) {
    it(`步长是 1/2/5 的 10 次幂倍：x∈[${extents[0]}, ${extents[1]}]`, () => {
      const cs = buildCoordSystem(
        { xMin: extents[0], xMax: extents[1], yMin: extents[0], yMax: extents[1] },
        { w, h: 400 },
      );
      expect(cs.xTicks.length).toBeGreaterThanOrEqual(2);
      const steps = stepsOf(cs.xTicks);
      for (const step of steps) {
        expect(step).toBeGreaterThan(0);
        expect([1, 2, 5, 10]).toContain(mantissaOf(step));
      }
      // 步长唯一
      expect(new Set(steps.map((s) => Number(s.toPrecision(8)))).size).toBe(1);
      // 刻度都落在窗口内
      for (const t of cs.xTicks) {
        expect(t).toBeGreaterThanOrEqual(cs.viewport.xMin - 1e-9);
        expect(t).toBeLessThanOrEqual(cs.viewport.xMax + 1e-9);
      }
    });
  }

  it("刻度值不带浮点尾巴", () => {
    const cs = buildCoordSystem({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }, { w: 400, h: 400 });
    for (const t of cs.xTicks) {
      expect(String(t).length).toBeLessThan(8);
    }
  });

  it("niceTicks:false 时窗口不被扩到刻度边界", () => {
    const cs = buildCoordSystem(
      { xMin: -0.3, xMax: 7.2, yMin: -1.1, yMax: 0.4 },
      { w: 500, h: 300 },
      { niceTicks: false },
    );
    expect(cs.viewport.xMin).toBeCloseTo(-0.3, 12);
    expect(cs.viewport.xMax).toBeCloseTo(7.2, 12);
  });
});

describe("buildCoordSystem — 退化输入不崩", () => {
  const finitePair = (p: [number, number]): boolean =>
    Number.isFinite(p[0]) && Number.isFinite(p[1]);

  it("xMin == xMax 与 yMin == yMax", () => {
    const cs = buildCoordSystem({ xMin: 2, xMax: 2, yMin: 5, yMax: 5 }, { w: 300, h: 200 });
    expect(cs.viewport.xMax).toBeGreaterThan(cs.viewport.xMin);
    expect(cs.viewport.yMax).toBeGreaterThan(cs.viewport.yMin);
    expect(finitePair(cs.toScreen(2, 5))).toBe(true);
    expect(cs.xTicks.length).toBeGreaterThanOrEqual(2);
  });

  it("常函数 y=0 全零范围保留原点", () => {
    const cs = buildCoordSystem({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 }, { w: 300, h: 300 });
    expect(cs.hasOrigin).toBe(true);
    expect(finitePair(cs.toScreen(0, 0))).toBe(true);
  });

  it("非有限 extents 被兜底", () => {
    const cs = buildCoordSystem(
      { xMin: Number.NaN, xMax: Number.POSITIVE_INFINITY, yMin: 0, yMax: 1 },
      { w: 300, h: 300 },
    );
    expect(Number.isFinite(cs.viewport.xMin)).toBe(true);
    expect(Number.isFinite(cs.viewport.xMax)).toBe(true);
    expect(finitePair(cs.toScreen(0, 0))).toBe(true);
  });

  it("反向 extents 自动交换", () => {
    const cs = buildCoordSystem({ xMin: 5, xMax: -5, yMin: 3, yMax: -3 }, { w: 300, h: 300 });
    expect(cs.viewport.xMin).toBeLessThan(cs.viewport.xMax);
    expect(cs.viewport.yMin).toBeLessThan(cs.viewport.yMax);
  });

  it("零尺寸画布不除零", () => {
    const cs = buildCoordSystem({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, { w: 0, h: 0 });
    expect(finitePair(cs.toScreen(0, 0))).toBe(true);
  });

  it("padding 大于画布时被夹住", () => {
    const cs = buildCoordSystem(
      { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
      { w: 100, h: 100 },
      { padding: 500 },
    );
    expect(finitePair(cs.toScreen(1, 1))).toBe(true);
    expect(cs.toScreen(1, 0)[0]).toBeGreaterThan(cs.toScreen(-1, 0)[0]);
  });
});

describe("unionExtents", () => {
  it("合并多组范围", () => {
    const merged = unionExtents([
      { xMin: -2, xMax: 2, yMin: -1, yMax: 1 },
      { xMin: 0, xMax: 5, yMin: -4, yMax: 0 },
    ]);
    expect(merged).toEqual({ xMin: -2, xMax: 5, yMin: -4, yMax: 1 });
  });

  it("全空返回 null", () => {
    expect(unionExtents([])).toBeNull();
    expect(unionExtents([{ xMin: Number.NaN, xMax: 1 }])).toBeNull();
  });
});
