import { describe, expect, it } from "vitest";
import { foldBeats } from "../src/fold.js";
import { solveScene } from "../src/render/scene.js";
import type { SceneSpec } from "@mathtutor/schema";

function spec(objects: unknown[], scenes: unknown[] = [{ role: "setup", actions: [] }]): SceneSpec {
  return { visual_objects: objects, scenes } as unknown as SceneSpec;
}

function firstScene(objects: unknown[], scenes?: unknown[]) {
  const beats = foldBeats(spec(objects, scenes));
  return solveScene(beats[0]!, 640, 380);
}

describe("曲线必须是真算出来的", () => {
  it("表达式被真实求值：x**2-4 的 y 范围触及 -4，且曲线经过根 (±2, 0)", () => {
    const s = firstScene([
      { id: "c", primitive: "function_curve", params: { expression: "x**2 - 4", variable: "x", x_range: [-3, 3] } },
    ]);
    const curve = s.plotted.find((p) => p.kind === "curve");
    expect(curve).toBeTruthy();
    if (curve?.kind !== "curve") throw new Error("no curve");
    const pts = curve.segments.flat();
    // 顶点 -4 必须在（不能被分位数裁掉）
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThanOrEqual(-3.99);
    // x=2 附近 y≈0（真实函数，不是装饰曲线）
    const near2 = pts.reduce((best, p) => (Math.abs(p[0] - 2) < Math.abs(best[0] - 2) ? p : best));
    expect(Math.abs(near2[1])).toBeLessThan(0.1);
    expect(s.issues).toHaveLength(0);
  });

  it("算不出来时不画任何曲线，并诚实上报（绝不退化成装饰抛物线）", () => {
    const s = firstScene([
      { id: "bad", primitive: "function_curve", params: { expression: "M0,h Q w/2", variable: "x", x_range: [-3, 3] } },
    ]);
    expect(s.plotted.filter((p) => p.kind === "curve")).toHaveLength(0);
    expect(s.issues.some((i) => i.kind === "uncomputable-curve")).toBe(true);
  });

  it("1/x 断成多段，没有跨越渐近线的假连线", () => {
    const s = firstScene([
      { id: "h", primitive: "function_curve", params: { expression: "1/x", variable: "x", x_range: [-2, 2] } },
    ]);
    const curve = s.plotted.find((p) => p.kind === "curve");
    if (curve?.kind !== "curve") throw new Error("no curve");
    expect(curve.segments.length).toBeGreaterThanOrEqual(2);
    for (const seg of curve.segments) {
      const signs = new Set(seg.map((p) => Math.sign(p[0])));
      expect(signs.has(-1) && signs.has(1)).toBe(false);
    }
  });
});

describe("全场景共享一个坐标系", () => {
  it("曲线上的点与同坐标的根映射到同一像素（对得齐）", () => {
    const s = firstScene([
      { id: "c", primitive: "function_curve", params: { expression: "x**2 - 4", variable: "x", x_range: [-3, 3] } },
      { id: "r", primitive: "dot", params: { positions: [[2, 0]] } },
      { id: "g", primitive: "line", params: { start: [2, -1], end: [2, 1] } },
    ]);
    expect(s.coords).toBeTruthy();
    const cs = s.coords!;
    const root = s.plotted.find((p) => p.kind === "point");
    const guide = s.plotted.find((p) => p.kind === "segment");
    if (root?.kind !== "point" || guide?.kind !== "segment") throw new Error("missing shapes");
    // 同一个数据 x=2 → 同一个屏幕 x
    expect(cs.toScreen(root.at[0], root.at[1])[0]).toBeCloseTo(cs.toScreen(guide.from[0], guide.from[1])[0], 6);
  });
});

describe("数量的变与不变", () => {
  it("take_from：单位从源组移到目标组，总数守恒", () => {
    const beats = foldBeats(
      spec(
        [{ id: "pile", primitive: "unit_grid", params: { count: 9 } }],
        [
          { role: "setup", actions: [] },
          { role: "transform", actions: [{ op: "take_from", source: "pile", count: 2 }] },
        ],
      ),
    );
    const after = beats[1]!;
    const total = after.groups.reduce((n, g) => n + g.units.length, 0);
    expect(total).toBe(9); // 拿走的没有消失，进了残影组
    expect(after.conservation?.ok).toBe(true);
    const source = after.groups.find((g) => g.id === "pile")!;
    expect(source.units.length).toBe(7);
    expect(after.moves.length).toBe(2); // 两个具体单位发生了位移
  });

  it("recount_verify 宣称数与实际数不符时被暴露", () => {
    const beats = foldBeats(
      spec(
        [{ id: "pile", primitive: "unit_grid", params: { count: 5 } }],
        [
          { role: "setup", actions: [] },
          { role: "verify", actions: [{ op: "recount_verify", targets: ["pile"], expect: 7 }] },
        ],
      ),
    );
    const s = solveScene(beats[1]!, 640, 380);
    expect(s.counts.some((c) => c.claimed === 7 && c.actual === 5)).toBe(true);
    expect(s.issues.some((i) => i.kind === "inconsistent-count")).toBe(true);
  });
});

describe("微积分构件", () => {
  it("割线与切线各归其位，斜率可标注", () => {
    const s = firstScene([
      { id: "sec", primitive: "secant_line", params: { x0: 1, h: 0.5, slope: 2.5, start: [1, 1], end: [1.5, 2.25] } },
      { id: "tan", primitive: "tangent_line", params: { at_x: 1, slope: 2, start: [0.5, 0], end: [1.5, 2] } },
    ]);
    const roles = s.plotted.filter((p) => p.kind === "segment").map((p) => (p.kind === "segment" ? p.role : ""));
    expect(roles).toContain("secant");
    expect(roles).toContain("tangent");
  });

  it("黎曼矩形按真实高度进入场景", () => {
    const s = firstScene([
      {
        id: "ri", primitive: "riemann_rects",
        params: { n: 2, side: "left", approx_area: 1.25, rects: [[0, 0.5, 0.5], [0.5, 1, 1.5]] },
      },
    ]);
    const rects = s.plotted.find((p) => p.kind === "rects");
    if (rects?.kind !== "rects") throw new Error("no rects");
    expect(rects.rects).toHaveLength(2);
    expect(rects.approxArea).toBeCloseTo(1.25);
  });

  it("发散的极限不画极限高度点（不暗示不存在的极限）", () => {
    const divergent = firstScene([
      {
        id: "lim", primitive: "limit_approach",
        params: { target: 0, divergent: true, limit_value: 99, points: { left: [[-0.1, -10]], right: [[0.1, 10]] } },
      },
    ]);
    expect(divergent.plotted.some((p) => p.kind === "point" && p.role === "limit")).toBe(false);

    const convergent = firstScene([
      {
        id: "lim2", primitive: "limit_approach",
        params: { target: 2, limit_value: 4, points: { left: [[1.9, 3.8]], right: [[2.1, 4.2]] } },
      },
    ]);
    expect(convergent.plotted.some((p) => p.kind === "point" && p.role === "limit")).toBe(true);
  });

  it("复合函数产出三条曲线（内层/外层/合成）与映射箭头", () => {
    const s = firstScene([
      {
        id: "comp", primitive: "composition_chain",
        params: {
          inner: "2*x + 1", outer: "u**2", variable: "x",
          x_range: [-2, 2], u_range: [-3, 5],
          samples: [
            { x: -1, u: -1, y: 1 }, { x: 0, u: 1, y: 1 },
            { x: 1, u: 3, y: 9 }, { x: 2, u: 5, y: 25 },
          ],
        },
      },
    ]);
    const curves = s.plotted.filter((p) => p.kind === "curve");
    expect(curves.length).toBeGreaterThanOrEqual(3); // 内层 + 外层 + 合成
    expect(s.plotted.some((p) => p.kind === "segment" && p.role === "arrow")).toBe(true);
  });
});

describe("未知构件", () => {
  it("不画装饰图形，只留中性占位并上报", () => {
    const s = firstScene([{ id: "weird", primitive: "hyper_widget", params: {} }]);
    expect(s.issues.some((i) => i.kind === "unknown-primitive")).toBe(true);
    expect(s.flowed.some((f) => f.kind === "label" && f.placeholder)).toBe(true);
  });
});
