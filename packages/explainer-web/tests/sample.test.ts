import { describe, expect, it } from "vitest";
import { compileExpression, type EvalFn } from "../src/math/expr.js";
import { sampleFunction } from "../src/math/sample.js";

const compile = (expr: string): EvalFn => {
  const result = compileExpression(expr, "x");
  if (!result.ok) throw new Error(`compile failed for ${expr}: ${result.error}`);
  return result.fn;
};

/** 是否存在一条把 x=0 直接连过去的线段（那正是假曲线的典型症状） */
const crossesZero = (segments: [number, number][][]): boolean =>
  segments.some((seg) =>
    seg.some((pt, i) => {
      if (i === 0) return false;
      const prev = seg[i - 1] as [number, number];
      return prev[0] < 0 && pt[0] > 0;
    }),
  );

describe("sampleFunction — 不连续处必须断开", () => {
  it("1/x 在 [-2,2] 至少断成两段且不跨越 0", () => {
    const curve = sampleFunction(compile("1/x"), -2, 2);
    expect(curve.segments.length).toBeGreaterThanOrEqual(2);
    expect(crossesZero(curve.segments)).toBe(false);
    // 两侧都有真实数据
    const hasLeft = curve.segments.some((s) => s.every((p) => p[0] < 0));
    const hasRight = curve.segments.some((s) => s.every((p) => p[0] > 0));
    expect(hasLeft).toBe(true);
    expect(hasRight).toBe(true);
  });

  it("1/x 采样点数为奇数（x=0 被采到）时同样断开", () => {
    const curve = sampleFunction(compile("1/x"), -2, 2, 601);
    expect(curve.segments.length).toBeGreaterThanOrEqual(2);
    expect(crossesZero(curve.segments)).toBe(false);
    expect(curve.segments.flat().some((p) => p[0] === 0)).toBe(false);
  });

  it("tan 在 [-2,2] 的两个极点处断段", () => {
    const curve = sampleFunction(compile("tan(x)"), -2, 2);
    expect(curve.segments.length).toBeGreaterThanOrEqual(3);
    // 每个极点两侧不能被同一段连起来
    for (const seg of curve.segments) {
      for (let i = 1; i < seg.length; i += 1) {
        const a = seg[i - 1] as [number, number];
        const b = seg[i] as [number, number];
        expect(a[0] < -Math.PI / 2 && b[0] > -Math.PI / 2).toBe(false);
        expect(a[0] < Math.PI / 2 && b[0] > Math.PI / 2).toBe(false);
      }
    }
  });

  it("连续函数只有一段", () => {
    const curve = sampleFunction(compile("x**2 - 4"), -3, 3, 601);
    expect(curve.segments.length).toBe(1);
    expect((curve.segments[0] as [number, number][]).length).toBe(601);
  });
});

describe("sampleFunction — 值域", () => {
  it("x**2-4 的 y 范围包含 -4（顶点不能被分位数削掉）", () => {
    const curve = sampleFunction(compile("x**2 - 4"), -3, 3, 601);
    expect(curve.yMin).toBeLessThanOrEqual(-4);
    expect(curve.yMin).toBeCloseTo(-4, 9);
    expect(curve.yMax).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  it("1/x 的极点不会把值域撑到 ±Infinity", () => {
    const curve = sampleFunction(compile("1/x"), -2, 2);
    expect(Number.isFinite(curve.yMin)).toBe(true);
    expect(Number.isFinite(curve.yMax)).toBe(true);
    expect(Math.abs(curve.yMin)).toBeLessThan(50);
    expect(Math.abs(curve.yMax)).toBeLessThan(50);
    expect(curve.yMax - curve.yMin).toBeGreaterThan(1);
  });

  it("sin 的值域接近 [-1,1]", () => {
    const curve = sampleFunction(compile("sin(x)"), -Math.PI, Math.PI);
    expect(curve.yMin).toBeCloseTo(-1, 4);
    expect(curve.yMax).toBeCloseTo(1, 4);
  });

  it("常函数不会崩，值域退化成一点", () => {
    const curve = sampleFunction(compile("3"), -1, 1, 11);
    expect(curve.yMin).toBe(3);
    expect(curve.yMax).toBe(3);
    expect(curve.segments.length).toBe(1);
  });
});

describe("sampleFunction — 定义域边界", () => {
  it("sqrt(x) 只在 x>=0 有数据，且起点被二分修到 0 附近", () => {
    const curve = sampleFunction(compile("sqrt(x)"), -2, 4, 601);
    const points = curve.segments.flat();
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p[0] >= -1e-6)).toBe(true);
    const first = points[0] as [number, number];
    expect(first[0]).toBeLessThan(1e-3);
    expect(first[1]).toBeLessThan(1e-1);
  });

  it("log(x) 在 x<=0 完全没有数据", () => {
    const curve = sampleFunction(compile("log(x)"), -1, 3);
    expect(curve.segments.flat().every((p) => p[0] > 0)).toBe(true);
  });

  it("处处无定义时返回空段 —— 宁可什么都不画", () => {
    const curve = sampleFunction(compile("sqrt(x)"), -5, -1);
    expect(curve.segments).toEqual([]);
  });
});

describe("sampleFunction — 退化输入", () => {
  it("xMin > xMax 自动交换", () => {
    const a = sampleFunction(compile("2*x"), 3, -3, 101);
    expect(a.segments.length).toBe(1);
    const pts = a.segments[0] as [number, number][];
    expect((pts[0] as [number, number])[0]).toBeCloseTo(-3, 12);
  });

  it("xMin == xMax 给一个单点段而不是除零", () => {
    const curve = sampleFunction(compile("x**2"), 2, 2);
    expect(curve.segments).toEqual([[[2, 4]]]);
    expect(curve.yMin).toBe(4);
  });

  it("非有限区间返回空", () => {
    expect(sampleFunction(compile("x"), Number.NaN, 1).segments).toEqual([]);
    expect(sampleFunction(compile("x"), 0, Number.POSITIVE_INFINITY).segments).toEqual([]);
  });

  it("采样数被夹到合法区间", () => {
    const curve = sampleFunction(compile("x"), 0, 1, 1);
    expect(curve.segments.flat().length).toBe(2);
  });
});

describe("sampleFunction — 边界点参与值域", () => {
  it("sqrt(x) 的 y 下界是 0（曲线起点必须进得了窗口）", () => {
    const curve = sampleFunction(compile("sqrt(x)"), -2, 4, 601);
    expect(curve.yMin).toBeCloseTo(0, 6);
    expect(curve.yMax).toBeCloseTo(2, 6);
  });
});
